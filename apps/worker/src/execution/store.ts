import { Prisma, PrismaClient } from "@copybot/db";
import {
  readCopySystemEnabled,
  readProfileGuardrailOverrides,
  readProfileMaxPriceOverride,
  readProfileSizingOverrides
} from "../config/copy-profile-guardrails.js";
import { readLeaderSettings } from "../config/leader-settings.js";
import type {
  CopyOrderDraft,
  CopyOrderRecord,
  ExecutionAttemptContext,
  ExecutionGuardrailOverrides,
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

    const pendingDeltaMetadata = asObject(attempt.pendingDelta?.metadata);
    const contributorLeaderIds = resolveContributorLeaderIds(pendingDeltaMetadata, attempt.leaderId ?? undefined);
    const contributorLeaderRows =
      contributorLeaderIds.length === 0
        ? []
        : await this.prisma.copyProfileLeader.findMany({
            where: {
              copyProfileId: attempt.copyProfileId,
              leaderId: {
                in: contributorLeaderIds
              }
            },
            select: {
              leaderId: true,
              settings: true
            }
          });
    const contributorSettingsByLeaderId = Object.fromEntries(
      contributorLeaderRows.map((row) => [row.leaderId, readLeaderSettings(row.settings)])
    );
    const profileGuardrailOverrides = readProfileGuardrailOverrides(attempt.copyProfile.config);
    const profileSizingOverrides = readProfileSizingOverrides(attempt.copyProfile.config);
    const profileMaxPricePerShare = readProfileMaxPriceOverride(attempt.copyProfile.config);
    const contributorMaxPricePerShare = resolveContributorMaxPricePerShare(
      contributorLeaderIds,
      contributorSettingsByLeaderId
    );

    return {
      attemptId: attempt.id,
      copyProfileStatus: attempt.copyProfile.status as "ACTIVE" | "PAUSED" | "DISABLED",
      copySystemEnabled: readCopySystemEnabled(attempt.copyProfile.config) ?? true,
      leaderStatus: attempt.leader?.status as "ACTIVE" | "PAUSED" | "DISABLED" | undefined,
      maxPricePerShareOverride:
        contributorMaxPricePerShare !== undefined ? contributorMaxPricePerShare : profileMaxPricePerShare,
      guardrailOverrides: toExecutionGuardrailOverrides(profileGuardrailOverrides, contributorSettingsByLeaderId),
      profileSizingOverrides: toExecutionProfileSizingOverrides(profileSizingOverrides),
      contributorLeaderIds,
      contributorSettingsByLeaderId,
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
      pendingDeltaMetadata
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

  async getLeaderRecentNotionalTurnoverUsd(args: {
    copyProfileId: string;
    leaderIds: string[];
    since: Date;
  }): Promise<Record<string, number>> {
    if (args.leaderIds.length === 0) {
      return {};
    }

    const rows = await this.prisma.copyFillAllocation.findMany({
      where: {
        leaderId: {
          in: args.leaderIds
        },
        allocatedAt: {
          gte: args.since
        },
        copyOrder: {
          copyProfileId: args.copyProfileId
        }
      },
      select: {
        leaderId: true,
        usdcDelta: true
      }
    });

    const byLeader: Record<string, number> = {};
    for (const leaderId of args.leaderIds) {
      byLeader[leaderId] = 0;
    }

    for (const row of rows) {
      if (!row.leaderId) {
        continue;
      }
      byLeader[row.leaderId] = (byLeader[row.leaderId] ?? 0) + Math.abs(Number(row.usdcDelta));
    }

    return byLeader;
  }

  async listLeaderLedgerPositions(args: {
    copyProfileId: string;
    leaderIds: string[];
  }): Promise<Array<{ leaderId: string; tokenId: string; shares: number }>> {
    if (args.leaderIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<Array<{ leaderId: string; tokenId: string; shares: Prisma.Decimal }>>(
      Prisma.sql`
        SELECT "leaderId", "tokenId", "shares"
        FROM "LeaderTokenLedger"
        WHERE "copyProfileId" = ${args.copyProfileId}
          AND "leaderId" IN (${Prisma.join(args.leaderIds)})
      `
    );

    return rows.map((row) => ({
      leaderId: row.leaderId,
      tokenId: row.tokenId,
      shares: Number(row.shares)
    }));
  }

  async countOpenOrders(copyProfileId: string): Promise<number> {
    return this.prisma.copyOrder.count({
      where: {
        copyProfileId,
        externalOrderId: {
          not: null
        },
        status: {
          in: ["PLACED", "PARTIALLY_FILLED", "RETRYING"]
        }
      }
    });
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

function toExecutionGuardrailOverrides(
  input: {
    minNotionalPerOrderUsd?: number;
    maxWorseningBuyUsd?: number;
    maxWorseningSellUsd?: number;
    buyImprovementGuardEnabled?: boolean;
    maxBuyImprovementBps?: number | null;
    maxSlippageBps?: number;
    maxSpreadUsd?: number;
    minBookDepthForSizeEnabled?: boolean;
    cooldownPerMarketSeconds?: number;
    maxOpenOrders?: number | null;
  },
  contributorSettingsByLeaderId: Record<string, ReturnType<typeof readLeaderSettings>>
): ExecutionGuardrailOverrides | undefined {
  const strictestContributorMinNotional = pickStrictestMax(
    Object.values(contributorSettingsByLeaderId).map((settings) => settings.minNotionalPerOrderUsd)
  );
  const strictestContributorSlippage = pickStrictestMin(
    Object.values(contributorSettingsByLeaderId).map((settings) => settings.maxSlippageBps)
  );

  const overrides: ExecutionGuardrailOverrides = {
    minNotionalUsd: strictestContributorMinNotional ?? input.minNotionalPerOrderUsd,
    maxWorseningBuyUsd: input.maxWorseningBuyUsd,
    maxWorseningSellUsd: input.maxWorseningSellUsd,
    buyImprovementGuardEnabled: input.buyImprovementGuardEnabled,
    maxBuyImprovementBps: input.maxBuyImprovementBps,
    maxSlippageBps: strictestContributorSlippage ?? input.maxSlippageBps,
    maxSpreadUsd: input.maxSpreadUsd,
    minBookDepthForSizeEnabled: input.minBookDepthForSizeEnabled,
    cooldownPerMarketSeconds: input.cooldownPerMarketSeconds,
    maxOpenOrders: input.maxOpenOrders
  };

  if (Object.values(overrides).every((value) => value === undefined)) {
    return undefined;
  }
  return overrides;
}

function toExecutionProfileSizingOverrides(input: {
  maxExposurePerLeaderUsd?: number;
  maxExposurePerMarketOutcomeUsd?: number;
  maxHourlyNotionalTurnoverUsd?: number;
  maxDailyNotionalTurnoverUsd?: number;
}) {
  const overrides = {
    maxExposurePerLeaderUsd: input.maxExposurePerLeaderUsd,
    maxExposurePerMarketOutcomeUsd: input.maxExposurePerMarketOutcomeUsd,
    maxHourlyNotionalTurnoverUsd: input.maxHourlyNotionalTurnoverUsd,
    maxDailyNotionalTurnoverUsd: input.maxDailyNotionalTurnoverUsd
  };

  if (Object.values(overrides).every((value) => value === undefined)) {
    return undefined;
  }
  return overrides;
}

function resolveContributorLeaderIds(metadata: Record<string, unknown>, fallbackLeaderId: string | undefined): string[] {
  const fromMetadata = readContributorLeaderIds(metadata);
  if (fromMetadata.length > 0) {
    return fromMetadata;
  }

  const fromTargetShares = Object.keys(asObject(metadata.leaderTargetShares));
  if (fromTargetShares.length > 0) {
    return [...new Set(fromTargetShares)].sort();
  }

  if (fallbackLeaderId) {
    return [fallbackLeaderId];
  }
  return [];
}

function readContributorLeaderIds(metadata: Record<string, unknown>): string[] {
  const raw = metadata.contributorLeaderIds;
  if (!Array.isArray(raw)) {
    return [];
  }
  const values = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return [...new Set(values)].sort();
}

function resolveContributorMaxPricePerShare(
  contributorLeaderIds: string[],
  contributorSettingsByLeaderId: Record<string, ReturnType<typeof readLeaderSettings>>
): number | null | undefined {
  const numeric: number[] = [];
  let sawExplicitDisable = false;

  for (const leaderId of contributorLeaderIds) {
    const settings = contributorSettingsByLeaderId[leaderId];
    if (!settings) {
      continue;
    }
    if (settings.maxPricePerShareUsd === null) {
      sawExplicitDisable = true;
      continue;
    }
    if (settings.maxPricePerShareUsd !== undefined) {
      numeric.push(settings.maxPricePerShareUsd);
    }
  }

  if (numeric.length > 0) {
    return Math.min(...numeric);
  }
  if (sawExplicitDisable) {
    return null;
  }
  return undefined;
}

function pickStrictestMax(values: Array<number | undefined>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    result = result === undefined ? value : Math.max(result, value);
  }
  return result;
}

function pickStrictestMin(values: Array<number | undefined>): number | undefined {
  let result: number | undefined;
  for (const value of values) {
    if (value === undefined) {
      continue;
    }
    result = result === undefined ? value : Math.min(result, value);
  }
  return result;
}
