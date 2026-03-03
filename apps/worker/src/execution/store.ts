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
        copyProfileId: true,
        leaderId: true,
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
            blockReason: true,
            pendingDeltaShares: true,
            pendingDeltaNotionalUsd: true,
            metadata: true
          }
        }
      }
    });

    if (!attempt) {
      return null;
    }

    const profileMaxPricePerShare = readMaxPricePerShareOverrideFromProfileConfig(attempt.copyProfile.config);
    const leaderSettings = attempt.leaderId
      ? await this.prisma.copyProfileLeader.findUnique({
          where: {
            copyProfileId_leaderId: {
              copyProfileId: attempt.copyProfileId,
              leaderId: attempt.leaderId
            }
          },
          select: {
            settings: true
          }
        })
      : null;
    const leaderMaxPricePerShare = readMaxPricePerShareOverrideFromLeaderSettings(leaderSettings?.settings);

    return {
      attemptId: attempt.id,
      copyProfileStatus: attempt.copyProfile.status as "ACTIVE" | "PAUSED" | "DISABLED",
      copySystemEnabled: readCopySystemEnabledFromConfig(attempt.copyProfile.config),
      leaderStatus: attempt.leader?.status as "ACTIVE" | "PAUSED" | "DISABLED" | undefined,
      maxPricePerShareOverride:
        leaderMaxPricePerShare !== undefined ? leaderMaxPricePerShare : profileMaxPricePerShare,
      pendingDeltaId: attempt.pendingDeltaId ?? undefined,
      pendingDeltaStatus: attempt.pendingDelta?.status as "PENDING" | "ELIGIBLE" | "BLOCKED" | "EXPIRED" | "CONVERTED" | undefined,
      pendingDeltaBlockReason: attempt.pendingDelta?.blockReason ?? undefined,
      pendingDeltaShares:
        attempt.pendingDelta?.pendingDeltaShares !== null && attempt.pendingDelta?.pendingDeltaShares !== undefined
          ? Number(attempt.pendingDelta.pendingDeltaShares)
          : undefined,
      pendingDeltaNotionalUsd:
        attempt.pendingDelta?.pendingDeltaNotionalUsd !== null && attempt.pendingDelta?.pendingDeltaNotionalUsd !== undefined
          ? Number(attempt.pendingDelta.pendingDeltaNotionalUsd)
          : undefined,
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
          status: "EXECUTED",
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

  async repairExecutionInvariants(now: Date): Promise<{ pendingDeltasConverted: number; attemptsClosed: number }> {
    const activePendingStatuses: Array<"PENDING" | "ELIGIBLE" | "BLOCKED"> = ["PENDING", "ELIGIBLE", "BLOCKED"];
    const placedLikeStatuses: Array<"PLACED" | "PARTIALLY_FILLED" | "FILLED"> = ["PLACED", "PARTIALLY_FILLED", "FILLED"];

    return this.prisma.$transaction(async (tx) => {
      const drifted = await tx.copyAttempt.findMany({
        where: {
          status: "EXECUTING",
          decision: "EXECUTED",
          copyOrders: {
            some: {
              status: {
                in: placedLikeStatuses
              }
            }
          }
        },
        select: {
          id: true,
          pendingDeltaId: true
        }
      });

      const pendingDeltaIds = [...new Set(drifted.map((row) => row.pendingDeltaId).filter((value): value is string => Boolean(value)))];
      const pendingConverted =
        pendingDeltaIds.length > 0
          ? await tx.pendingDelta.updateMany({
              where: {
                id: {
                  in: pendingDeltaIds
                },
                status: {
                  in: activePendingStatuses
                }
              },
              data: {
                status: "CONVERTED",
                blockReason: null
              }
            })
          : { count: 0 };

      const attemptsClosed =
        drifted.length > 0
          ? await tx.copyAttempt.updateMany({
              where: {
                id: {
                  in: drifted.map((row) => row.id)
                },
                status: "EXECUTING",
                decision: "EXECUTED"
              },
              data: {
                status: "EXECUTED"
              }
            })
          : { count: 0 };

      if (pendingConverted.count > 0 || attemptsClosed.count > 0) {
        await tx.errorEvent.create({
          data: {
            component: "WORKER",
            severity: "WARN",
            code: "EXECUTION_INVARIANT_REPAIRED",
            message:
              "Repaired execution invariants for executing/executed attempts with placed-like orders by converting pending deltas and closing attempts",
            context: toJsonValue({
              pendingDeltasConverted: pendingConverted.count,
              attemptsClosed: attemptsClosed.count,
              repairedAttemptIds: drifted.map((row) => row.id).slice(0, 50),
              repairedAt: now.toISOString()
            })
          }
        });
      }

      return {
        pendingDeltasConverted: pendingConverted.count,
        attemptsClosed: attemptsClosed.count
      };
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
      const activeStatuses: Array<"PENDING" | "ELIGIBLE" | "BLOCKED"> = ["PENDING", "ELIGIBLE", "BLOCKED"];
      if (input.terminalStatus === "EXPIRED") {
        await tx.pendingDelta.updateMany({
          where: {
            id: input.pendingDeltaId,
            status: {
              in: activeStatuses
            }
          },
          data: {
            status: "EXPIRED",
            blockReason: "EXPIRED"
          }
        });
        return;
      }

      await tx.pendingDelta.updateMany({
        where: {
          id: input.pendingDeltaId,
          status: {
            in: activeStatuses
          }
        },
        data: {
          status: "PENDING",
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

function readMaxPricePerShareOverrideFromProfileConfig(value: unknown): number | null | undefined {
  const config = asObject(value);
  const guardrails = asObject(config.guardrails);
  return readOptionalPositiveNumberOverride(guardrails.maxPricePerShareUsd);
}

function readMaxPricePerShareOverrideFromLeaderSettings(value: unknown): number | null | undefined {
  const settings = asObject(value);
  return readOptionalPositiveNumberOverride(settings.maxPricePerShareUsd);
}

function readOptionalPositiveNumberOverride(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  const parsed = readNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
