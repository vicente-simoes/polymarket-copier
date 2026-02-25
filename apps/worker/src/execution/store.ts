import { Prisma, PrismaClient } from "@copybot/db";
import type {
  CopyOrderDraft,
  CopyOrderRecord,
  ExecutionAttemptContext,
  ExecutionAttemptRecord,
  ExecutionSkipReason,
  ExecutionStore,
  ExecutionTransitionInput
} from "./types.js";

type TxClient = Prisma.TransactionClient;

export class PrismaExecutionStore implements ExecutionStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listOpenAttempts(limit: number): Promise<ExecutionAttemptRecord[]> {
    const attempts = await this.prisma.copyAttempt.findMany({
      where: {
        status: {
          in: ["PENDING", "RETRYING"]
        },
        decision: "PENDING"
      },
      orderBy: {
        createdAt: "asc"
      },
      take: limit,
      select: {
        id: true,
        copyProfileId: true,
        leaderId: true,
        pendingDeltaId: true,
        tokenId: true,
        marketId: true,
        side: true,
        retries: true,
        maxRetries: true,
        expiresAt: true,
        attemptedAt: true,
        accumulatedDeltaShares: true,
        accumulatedDeltaNotionalUsd: true,
        status: true
      }
    });

    return attempts.map((attempt) => ({
      id: attempt.id,
      copyProfileId: attempt.copyProfileId,
      leaderId: attempt.leaderId ?? undefined,
      pendingDeltaId: attempt.pendingDeltaId ?? undefined,
      tokenId: attempt.tokenId,
      marketId: attempt.marketId ?? undefined,
      side: attempt.side as "BUY" | "SELL",
      retries: attempt.retries,
      maxRetries: attempt.maxRetries,
      expiresAt: attempt.expiresAt,
      attemptedAt: attempt.attemptedAt ?? undefined,
      accumulatedDeltaShares: attempt.accumulatedDeltaShares ? Number(attempt.accumulatedDeltaShares) : 0,
      accumulatedDeltaNotionalUsd: attempt.accumulatedDeltaNotionalUsd ? Number(attempt.accumulatedDeltaNotionalUsd) : 0,
      status: attempt.status as "PENDING" | "RETRYING"
    }));
  }

  async getAttemptContext(attemptId: string): Promise<ExecutionAttemptContext | null> {
    const attempt = await this.prisma.copyAttempt.findUnique({
      where: {
        id: attemptId
      },
      select: {
        id: true,
        pendingDeltaId: true,
        copyProfile: {
          select: {
            status: true,
            config: true
          }
        },
        leader: {
          select: {
            status: true
          }
        },
        pendingDelta: {
          select: {
            status: true,
            metadata: true
          }
        }
      }
    });

    if (!attempt) {
      return null;
    }

    return {
      attemptId: attempt.id,
      copyProfileStatus: attempt.copyProfile.status as "ACTIVE" | "PAUSED" | "DISABLED",
      copySystemEnabled: readCopySystemEnabledFromConfig(attempt.copyProfile.config),
      leaderStatus: attempt.leader?.status as "ACTIVE" | "PAUSED" | "DISABLED" | undefined,
      pendingDeltaId: attempt.pendingDeltaId ?? undefined,
      pendingDeltaStatus: attempt.pendingDelta?.status as "PENDING" | "ELIGIBLE" | "BLOCKED" | "EXPIRED" | "CONVERTED" | undefined,
      pendingDeltaMetadata: asObject(attempt.pendingDelta?.metadata)
    };
  }

  async getNotionalTurnoverUsd(copyProfileId: string, since: Date): Promise<number> {
    const aggregate = await this.prisma.copyOrder.aggregate({
      where: {
        copyProfileId,
        attemptedAt: {
          gte: since
        },
        status: {
          in: ["PLACED", "PARTIALLY_FILLED", "FILLED"]
        }
      },
      _sum: {
        intendedNotionalUsd: true
      }
    });

    return aggregate._sum.intendedNotionalUsd ? Number(aggregate._sum.intendedNotionalUsd) : 0;
  }

  async getLastOrderAttemptAt(copyProfileId: string, tokenId: string): Promise<Date | null> {
    const latest = await this.prisma.copyOrder.findFirst({
      where: {
        copyProfileId,
        tokenId
      },
      orderBy: {
        attemptedAt: "desc"
      },
      select: {
        attemptedAt: true
      }
    });

    return latest?.attemptedAt ?? null;
  }

  async createCopyOrderDraft(input: CopyOrderDraft): Promise<CopyOrderRecord> {
    const assignedWeight = Object.values(input.leaderWeights).reduce((sum, weight) => sum + Math.max(weight, 0), 0);
    const unattributedWeight = Math.max(1 - assignedWeight, 0);

    const order = await this.prisma.copyOrder.upsert({
      where: {
        idempotencyKey: input.idempotencyKey
      },
      create: {
        copyProfileId: input.copyProfileId,
        copyAttemptId: input.copyAttemptId,
        tokenId: input.tokenId,
        marketId: input.marketId ?? null,
        side: input.side,
        orderType: "FAK",
        intendedNotionalUsd: String(input.intendedNotionalUsd),
        intendedShares: String(input.intendedShares),
        priceLimit: String(input.priceLimit),
        leaderWeights: toJsonValue(input.leaderWeights),
        unattributedWeight: unattributedWeight > 0 ? String(unattributedWeight) : null,
        idempotencyKey: input.idempotencyKey,
        status: "RETRYING",
        retryCount: input.retryCount,
        attemptedAt: input.attemptedAt
      },
      update: {},
      select: {
        id: true,
        status: true,
        externalOrderId: true
      }
    });

    return {
      id: order.id,
      status: order.status as CopyOrderRecord["status"],
      externalOrderId: order.externalOrderId ?? undefined
    };
  }

  async markCopyOrderPlaced(input: {
    copyOrderId: string;
    attemptId: string;
    pendingDeltaId?: string;
    status: "PLACED" | "PARTIALLY_FILLED" | "FILLED";
    externalOrderId?: string;
    responsePayload?: Record<string, unknown>;
    attemptedAt: Date;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.copyOrder.update({
        where: {
          id: input.copyOrderId
        },
        data: {
          status: input.status,
          externalOrderId: input.externalOrderId ?? undefined,
          errorMessage: null,
          errorPayload: Prisma.DbNull,
          attemptedAt: input.attemptedAt
        }
      });

      await tx.copyAttempt.update({
        where: {
          id: input.attemptId
        },
        data: {
          status: "EXECUTING",
          decision: "EXECUTED",
          reason: null,
          attemptedAt: input.attemptedAt,
          errorPayload: input.responsePayload ? toJsonValue(input.responsePayload) : undefined
        }
      });

      if (input.pendingDeltaId) {
        await tx.pendingDelta.update({
          where: {
            id: input.pendingDeltaId
          },
          data: {
            status: "CONVERTED",
            blockReason: null
          }
        });
      }
    });
  }

  async markCopyOrderFailure(input: {
    copyOrderId: string;
    attemptTransition: ExecutionTransitionInput;
    orderStatus?: "FAILED" | "CANCELLED" | "RETRYING";
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.copyOrder.update({
        where: {
          id: input.copyOrderId
        },
        data: {
          status: input.orderStatus ?? "FAILED",
          errorMessage: input.attemptTransition.message ?? null,
          errorPayload: input.attemptTransition.context ? toJsonValue(input.attemptTransition.context) : undefined,
          retryCount: input.attemptTransition.nextRetries,
          lastRetryAt: input.attemptTransition.attemptedAt
        }
      });

      await this.applyAttemptTransitionTx(tx, input.attemptTransition);
    });
  }

  async deferAttempt(input: ExecutionTransitionInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.applyAttemptTransitionTx(tx, input);
    });
  }

  private async applyAttemptTransitionTx(tx: TxClient, input: ExecutionTransitionInput): Promise<void> {
    const status =
      input.terminalStatus === "FAILED"
        ? "FAILED"
        : input.terminalStatus === "EXPIRED"
          ? "EXPIRED"
          : "RETRYING";

    const decision = input.terminalStatus ? "SKIPPED" : "PENDING";
    const reason = input.terminalStatus === "EXPIRED" ? "EXPIRED" : mapSkipReason(input.reason);

    await tx.copyAttempt.update({
      where: {
        id: input.attemptId
      },
      data: {
        status,
        decision,
        reason,
        retries: input.nextRetries,
        attemptedAt: input.attemptedAt,
        errorPayload: input.context ? toJsonValue(input.context) : undefined
      }
    });

    if (input.pendingDeltaId) {
      await tx.pendingDelta.update({
        where: {
          id: input.pendingDeltaId
        },
        data: {
          status: input.terminalStatus === "EXPIRED" ? "EXPIRED" : "PENDING",
          blockReason: mapSkipReason(input.reason)
        }
      });
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function mapSkipReason(reason: ExecutionSkipReason) {
  if (reason === "MIN_NOTIONAL") {
    return "MIN_NOTIONAL";
  }
  if (reason === "MIN_ORDER_SIZE") {
    return "MIN_ORDER_SIZE";
  }
  if (reason === "SLIPPAGE") {
    return "SLIPPAGE";
  }
  if (reason === "PRICE_GUARD") {
    return "PRICE_GUARD";
  }
  if (reason === "SPREAD") {
    return "SPREAD";
  }
  if (reason === "THIN_BOOK") {
    return "THIN_BOOK";
  }
  if (reason === "STALE_PRICE") {
    return "STALE_PRICE";
  }
  if (reason === "MARKET_WS_DISCONNECTED") {
    return "MARKET_WS_DISCONNECTED";
  }
  if (reason === "RATE_LIMIT") {
    return "RATE_LIMIT";
  }
  if (reason === "KILL_SWITCH") {
    return "KILL_SWITCH";
  }
  if (reason === "LEADER_PAUSED") {
    return "LEADER_PAUSED";
  }
  if (reason === "EXPIRED") {
    return "EXPIRED";
  }
  if (reason === "BOOK_UNAVAILABLE") {
    return "BOOK_UNAVAILABLE";
  }
  return "UNKNOWN";
}

function toJsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function readCopySystemEnabledFromConfig(value: unknown): boolean {
  const config = asObject(value);
  const masterSwitches = asObject(config.masterSwitches);
  const configured = masterSwitches.copySystemEnabled;
  if (typeof configured === "boolean") {
    return configured;
  }
  return true;
}
