import { Prisma, PrismaClient } from "@copybot/db";

type DecimalLike = Prisma.Decimal | bigint | number | string | null;
import { readProfileGuardrailOverrides } from "../config/copy-profile-guardrails.js";
import { readLeaderSettings } from "../config/leader-settings.js";
import type {
  ActiveCopyProfile,
  FollowerPositionPoint,
  LeaderPositionPoint,
  LeaderTradePricePoint,
  OpenCopyAttemptRecord,
  PendingDeltaInput,
  PendingDeltaRecord,
  PendingDeltaSide,
  TargetNettingStore
} from "./types.js";

export class PrismaTargetNettingStore implements TargetNettingStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listActiveCopyProfiles(): Promise<ActiveCopyProfile[]> {
    const profiles = await this.prisma.copyProfile.findMany({
      where: {
        status: "ACTIVE"
      },
      select: {
        id: true,
        defaultRatio: true,
        config: true,
        leaders: {
          where: {
            status: "ACTIVE",
            leader: {
              status: "ACTIVE"
            }
          },
          select: {
            leaderId: true,
            ratio: true,
            settings: true
          }
        }
      }
    });

    return profiles.map((profile) => {
      const guardrails = readProfileGuardrailOverrides(profile.config);
      return {
        copyProfileId: profile.id,
        defaultRatio: Number(profile.defaultRatio),
        leaders: profile.leaders.map((leaderLink) => ({
          leaderId: leaderLink.leaderId,
          ratio: Number(leaderLink.ratio),
          settings: readLeaderSettings(leaderLink.settings)
        })),
        guardrailOverrides: toTargetGuardrailOverrides({
          minNotionalPerOrderUsd: guardrails.minNotionalPerOrderUsd,
          maxRetriesPerAttempt: guardrails.maxRetriesPerAttempt,
          attemptExpirationSeconds: guardrails.attemptExpirationSeconds
        })
      };
    });
  }

  async getLatestLeaderPositions(leaderIds: string[]): Promise<LeaderPositionPoint[]> {
    if (leaderIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<Array<{
      leaderId: string;
      tokenId: string;
      marketId: string | null;
      shares: DecimalLike;
      avgPrice: DecimalLike;
      currentPrice: DecimalLike;
      currentValueUsd: DecimalLike;
    }>>(Prisma.sql`
      SELECT "leaderId", "tokenId", "marketId", "shares", "avgPrice", "currentPrice", "currentValueUsd"
      FROM "LeaderCurrentPosition"
      WHERE "leaderId" IN (${Prisma.join(leaderIds)})
    `);

    return rows.map((row) => ({
      leaderId: row.leaderId,
      tokenId: row.tokenId,
      marketId: row.marketId ?? undefined,
      shares: normalizeDecimalLike(row.shares) ?? 0,
      avgPrice: normalizeDecimalLike(row.avgPrice) ?? undefined,
      currentPrice: normalizeDecimalLike(row.currentPrice) ?? undefined,
      currentValueUsd: normalizeDecimalLike(row.currentValueUsd) ?? undefined
    }));
  }

  async getLatestLeaderTradePrices(args: {
    leaderIds: string[];
    tokenIds: string[];
  }): Promise<LeaderTradePricePoint[]> {
    if (args.leaderIds.length === 0 || args.tokenIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<Array<{
      leaderId: string;
      tokenId: string;
      side: string;
      price: DecimalLike;
      leaderFillAtMs: bigint | number | string;
    }>>(Prisma.sql`
      SELECT "leaderId", "tokenId", "side", "price", "leaderFillAtMs"
      FROM "LeaderLatestTradePrice"
      WHERE "leaderId" IN (${Prisma.join(args.leaderIds)})
        AND "tokenId" IN (${Prisma.join(args.tokenIds)})
    `);

    return rows.map((row) => ({
      leaderId: row.leaderId,
      tokenId: row.tokenId,
      side: row.side as PendingDeltaSide,
      price: normalizeDecimalLike(row.price) ?? 0,
      leaderFillAtMs: normalizeBigIntLike(row.leaderFillAtMs)
    }));
  }

  async getLatestFollowerPositions(copyProfileId: string): Promise<FollowerPositionPoint[]> {
    const rows = await this.prisma.$queryRaw<Array<{ tokenId: string; shares: DecimalLike }>>(Prisma.sql`
      SELECT "tokenId", "shares"
      FROM "FollowerCurrentPosition"
      WHERE "copyProfileId" = ${copyProfileId}
    `);

    return rows.map((row) => ({
      tokenId: row.tokenId,
      shares: normalizeDecimalLike(row.shares) ?? 0
    }));
  }

  async listOpenPendingTokenIds(copyProfileId: string): Promise<string[]> {
    const rows = await this.prisma.pendingDelta.findMany({
      where: {
        copyProfileId,
        status: {
          in: ["PENDING", "ELIGIBLE", "BLOCKED"]
        }
      },
      select: {
        tokenId: true
      }
    });

    return [...new Set(rows.map((row) => row.tokenId))];
  }

  async upsertPendingDelta(input: PendingDeltaInput): Promise<PendingDeltaRecord> {
    const result = await this.prisma.pendingDelta.upsert({
      where: {
        copyProfileId_tokenId_side: {
          copyProfileId: input.copyProfileId,
          tokenId: input.tokenId,
          side: input.side
        }
      },
      create: {
        copyProfileId: input.copyProfileId,
        leaderId: input.leaderId ?? null,
        tokenId: input.tokenId,
        marketId: input.marketId ?? null,
        side: input.side,
        pendingDeltaShares: String(input.pendingDeltaShares),
        pendingDeltaNotionalUsd: String(input.pendingDeltaNotionalUsd),
        minExecutableNotionalUsd: String(input.minExecutableNotionalUsd),
        status: input.status,
        blockReason: input.blockReason ?? null,
        expiresAt: input.expiresAt,
        metadata: toJsonValue(input.metadata)
      },
      update: {
        leaderId: input.leaderId ?? null,
        marketId: input.marketId ?? null,
        pendingDeltaShares: String(input.pendingDeltaShares),
        pendingDeltaNotionalUsd: String(input.pendingDeltaNotionalUsd),
        minExecutableNotionalUsd: String(input.minExecutableNotionalUsd),
        status: input.status,
        blockReason: input.blockReason ?? null,
        expiresAt: input.expiresAt,
        metadata: toJsonValue(input.metadata)
      },
      select: {
        id: true,
        copyProfileId: true,
        leaderId: true,
        tokenId: true,
        marketId: true,
        side: true,
        pendingDeltaShares: true,
        pendingDeltaNotionalUsd: true,
        status: true
      }
    });

    return {
      id: result.id,
      copyProfileId: result.copyProfileId,
      leaderId: result.leaderId ?? undefined,
      tokenId: result.tokenId,
      marketId: result.marketId ?? undefined,
      side: result.side as PendingDeltaSide,
      pendingDeltaShares: Number(result.pendingDeltaShares),
      pendingDeltaNotionalUsd: Number(result.pendingDeltaNotionalUsd),
      status: result.status as "PENDING" | "ELIGIBLE" | "BLOCKED"
    };
  }

  async expireOppositePendingDeltas(copyProfileId: string, tokenId: string, side: PendingDeltaSide): Promise<number> {
    const opposite: PendingDeltaSide = side === "BUY" ? "SELL" : "BUY";
    const result = await this.prisma.pendingDelta.updateMany({
      where: {
        copyProfileId,
        tokenId,
        side: opposite
      },
      data: {
        status: "EXPIRED",
        blockReason: "UNKNOWN",
        pendingDeltaShares: "0",
        pendingDeltaNotionalUsd: "0",
        metadata: toJsonValue({
          expiredByOppositeSide: true,
          expiredAtMs: Date.now()
        })
      }
    });

    return result.count;
  }

  async clearTokenPendingDeltas(copyProfileId: string, tokenId: string): Promise<number> {
    const result = await this.prisma.pendingDelta.updateMany({
      where: {
        copyProfileId,
        tokenId
      },
      data: {
        pendingDeltaShares: "0",
        pendingDeltaNotionalUsd: "0",
        status: "CONVERTED",
        blockReason: null,
        metadata: toJsonValue({
          clearedByNetZero: true,
          clearedAtMs: Date.now()
        })
      }
    });

    return result.count;
  }

  async findOpenCopyAttemptForPendingDelta(pendingDeltaId: string): Promise<OpenCopyAttemptRecord | null> {
    const attempt = await this.prisma.copyAttempt.findFirst({
      where: {
        pendingDeltaId,
        status: {
          in: ["PENDING", "EXECUTING", "RETRYING"]
        }
      },
      select: {
        id: true,
        pendingDeltaId: true,
        status: true
      }
    });

    if (!attempt) {
      return null;
    }

    return {
      id: attempt.id,
      pendingDeltaId: attempt.pendingDeltaId ?? "",
      status: attempt.status as "PENDING" | "EXECUTING" | "RETRYING"
    };
  }

  async createCopyAttempt(input: {
    copyProfileId: string;
    leaderId?: string;
    pendingDeltaId: string;
    tokenId: string;
    marketId?: string;
    side: PendingDeltaSide;
    pendingDeltaShares: number;
    pendingDeltaNotionalUsd: number;
    expiresAt: Date;
    maxRetries: number;
    idempotencyKey: string;
  }): Promise<void> {
    await this.prisma.copyAttempt.create({
      data: {
        copyProfileId: input.copyProfileId,
        leaderId: input.leaderId ?? null,
        pendingDeltaId: input.pendingDeltaId,
        tokenId: input.tokenId,
        marketId: input.marketId ?? null,
        side: input.side,
        status: "PENDING",
        decision: "PENDING",
        accumulatedDeltaShares: String(input.pendingDeltaShares),
        accumulatedDeltaNotionalUsd: String(input.pendingDeltaNotionalUsd),
        idempotencyKey: input.idempotencyKey,
        retries: 0,
        maxRetries: input.maxRetries,
        expiresAt: input.expiresAt
      }
    });
  }
}

function toJsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizeDecimalLike(value: DecimalLike): number | null {
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeBigIntLike(value: bigint | number | string): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTargetGuardrailOverrides(input: {
  minNotionalPerOrderUsd?: number;
  maxRetriesPerAttempt?: number;
  attemptExpirationSeconds?: number;
}):
  | {
      minNotionalUsd?: number;
      maxRetriesPerAttempt?: number;
      attemptExpirationSeconds?: number;
    }
  | undefined {
  const overrides = {
    minNotionalUsd: input.minNotionalPerOrderUsd,
    maxRetriesPerAttempt: input.maxRetriesPerAttempt,
    attemptExpirationSeconds: input.attemptExpirationSeconds
  };

  if (Object.values(overrides).every((value) => value === undefined)) {
    return undefined;
  }

  return overrides;
}
