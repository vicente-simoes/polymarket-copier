import { Prisma, PrismaClient } from "@copybot/db";
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
    const rows: LeaderPositionPoint[] = [];
    for (const leaderId of leaderIds) {
      const latest = await this.prisma.leaderPositionSnapshot.findFirst({
        where: { leaderId },
        orderBy: {
          snapshotAt: "desc"
        },
        select: {
          snapshotAt: true
        }
      });

      if (!latest) {
        continue;
      }

      const snapshots = await this.prisma.leaderPositionSnapshot.findMany({
        where: {
          leaderId,
          snapshotAt: latest.snapshotAt
        },
        select: {
          leaderId: true,
          tokenId: true,
          marketId: true,
          shares: true,
          avgPrice: true,
          currentPrice: true,
          currentValueUsd: true
        }
      });

      for (const snapshot of snapshots) {
        rows.push({
          leaderId: snapshot.leaderId,
          tokenId: snapshot.tokenId,
          marketId: snapshot.marketId ?? undefined,
          shares: Number(snapshot.shares),
          avgPrice: snapshot.avgPrice ? Number(snapshot.avgPrice) : undefined,
          currentPrice: snapshot.currentPrice ? Number(snapshot.currentPrice) : undefined,
          currentValueUsd: snapshot.currentValueUsd ? Number(snapshot.currentValueUsd) : undefined
        });
      }
    }

    return rows;
  }

  async getLatestLeaderTradePrices(args: {
    leaderIds: string[];
    tokenIds: string[];
  }): Promise<LeaderTradePricePoint[]> {
    if (args.leaderIds.length === 0 || args.tokenIds.length === 0) {
      return [];
    }

    const rows = await this.prisma.leaderTradeEvent.findMany({
      where: {
        leaderId: {
          in: args.leaderIds
        },
        tokenId: {
          in: args.tokenIds
        },
        side: {
          in: ["BUY", "SELL"]
        }
      },
      orderBy: [
        {
          leaderFillAtMs: "desc"
        },
        {
          createdAt: "desc"
        }
      ],
      select: {
        leaderId: true,
        tokenId: true,
        side: true,
        price: true,
        leaderFillAtMs: true
      }
    });

    const latestByKey = new Map<string, LeaderTradePricePoint>();

    for (const row of rows) {
      const key = `${row.leaderId}|${row.tokenId}|${row.side}`;
      if (latestByKey.has(key)) {
        continue;
      }
      latestByKey.set(key, {
        leaderId: row.leaderId,
        tokenId: row.tokenId,
        side: row.side as PendingDeltaSide,
        price: Number(row.price),
        leaderFillAtMs: Number(row.leaderFillAtMs)
      });
    }

    return [...latestByKey.values()];
  }

  async getLatestFollowerPositions(copyProfileId: string): Promise<FollowerPositionPoint[]> {
    const latest = await this.prisma.followerPositionSnapshot.findFirst({
      where: {
        copyProfileId
      },
      orderBy: {
        snapshotAt: "desc"
      },
      select: {
        snapshotAt: true
      }
    });

    if (!latest) {
      return [];
    }

    const snapshots = await this.prisma.followerPositionSnapshot.findMany({
      where: {
        copyProfileId,
        snapshotAt: latest.snapshotAt
      },
      select: {
        tokenId: true,
        shares: true
      }
    });

    return snapshots.map((snapshot) => ({
      tokenId: snapshot.tokenId,
      shares: Number(snapshot.shares)
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
