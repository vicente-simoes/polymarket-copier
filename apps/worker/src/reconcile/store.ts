import { Prisma, PrismaClient } from "@copybot/db";
import type { DataApiPosition } from "@copybot/shared";
import type { LeaderDataApiClient } from "../leader/types.js";
import {
  mapFollowerSnapshotRowsToCurrentPositions,
  PrismaCurrentStateStore,
  type CurrentPositionSource
} from "../current-state/store.js";
import type { ReconcileAuditRecord, ReconcileStore } from "./types.js";
import { PrismaTokenMetadataStore } from "../token-metadata/store.js";

interface PrismaReconcileStoreOptions {
  prisma: PrismaClient;
  dataApi?: LeaderDataApiClient;
  dataApiPageLimit?: number;
  dataApiMaxPages?: number;
  followerAddressFallback?: string;
}

export class PrismaReconcileStore implements ReconcileStore {
  private readonly prisma: PrismaClient;
  private readonly dataApi?: LeaderDataApiClient;
  private readonly dataApiPageLimit: number;
  private readonly dataApiMaxPages: number;
  private readonly followerAddressFallback?: string;
  private readonly tokenMetadataStore: PrismaTokenMetadataStore;
  private readonly currentStateStore: PrismaCurrentStateStore;

  constructor(prismaOrOptions: PrismaClient | PrismaReconcileStoreOptions) {
    if ("$connect" in prismaOrOptions) {
      this.prisma = prismaOrOptions;
      this.dataApi = undefined;
      this.dataApiPageLimit = 100;
      this.dataApiMaxPages = 20;
      this.followerAddressFallback = undefined;
      this.tokenMetadataStore = new PrismaTokenMetadataStore(prismaOrOptions);
      this.currentStateStore = new PrismaCurrentStateStore(prismaOrOptions);
      return;
    }

    this.prisma = prismaOrOptions.prisma;
    this.dataApi = prismaOrOptions.dataApi;
    this.dataApiPageLimit = Math.max(1, prismaOrOptions.dataApiPageLimit ?? 100);
    this.dataApiMaxPages = Math.max(1, prismaOrOptions.dataApiMaxPages ?? 20);
    this.followerAddressFallback = normalizeAddress(prismaOrOptions.followerAddressFallback ?? undefined) ?? undefined;
    this.tokenMetadataStore = new PrismaTokenMetadataStore(prismaOrOptions.prisma);
    this.currentStateStore = new PrismaCurrentStateStore(prismaOrOptions.prisma);
  }

  async listActiveCopyProfileIds(): Promise<string[]> {
    const profiles = await this.prisma.copyProfile.findMany({
      where: {
        status: "ACTIVE"
      },
      orderBy: {
        createdAt: "asc"
      },
      select: {
        id: true
      }
    });

    return profiles.map((profile) => profile.id);
  }

  async rebuildFollowerSnapshot(copyProfileId: string, snapshotAt: Date, snapshotAtMs: number): Promise<{
    tokensSnapshotted: number;
    absoluteSharesSum: number;
  }> {
    const profile = await this.prisma.copyProfile.findUnique({
      where: {
        id: copyProfileId
      },
      select: {
        followerAddress: true
      }
    });

    const resolvedFollowerAddress =
      normalizeAddress(profile?.followerAddress) ??
      this.followerAddressFallback;

    if (resolvedFollowerAddress && resolvedFollowerAddress !== profile?.followerAddress?.toLowerCase()) {
      await this.prisma.copyProfile
        .update({
          where: {
            id: copyProfileId
          },
          data: {
            followerAddress: resolvedFollowerAddress
          }
        })
        .catch(() => undefined);
    }

    if (this.dataApi && resolvedFollowerAddress) {
      try {
        return await this.rebuildFromDataApi({
          copyProfileId,
          followerAddress: resolvedFollowerAddress,
          snapshotAt,
          snapshotAtMs
        });
      } catch (error) {
        return this.rebuildFromFills(copyProfileId, snapshotAt, snapshotAtMs, {
          source: "RECONCILE_FILLS_FALLBACK",
          followerAddress: resolvedFollowerAddress,
          fallbackReason: "DATA_API_ERROR",
          fallbackError: toErrorMessage(error)
        });
      }
    }

    return this.rebuildFromFills(copyProfileId, snapshotAt, snapshotAtMs, {
      source: "RECONCILE_FILLS",
      followerAddress: resolvedFollowerAddress ?? null,
      fallbackReason: resolvedFollowerAddress ? "DATA_API_DISABLED" : "FOLLOWER_ADDRESS_UNAVAILABLE"
    });
  }

  private async rebuildFromDataApi(args: {
    copyProfileId: string;
    followerAddress: string;
    snapshotAt: Date;
    snapshotAtMs: number;
  }): Promise<{
    tokensSnapshotted: number;
    absoluteSharesSum: number;
  }> {
    if (!this.dataApi) {
      throw new Error("Data API client is not configured");
    }

    const positions: DataApiPosition[] = [];
    for (let page = 0; page < this.dataApiMaxPages; page += 1) {
      const pageRows = await this.dataApi.fetchPositionsPage({
        user: args.followerAddress,
        limit: this.dataApiPageLimit,
        offset: page * this.dataApiPageLimit,
        sizeThreshold: 0
      });

      positions.push(...pageRows);
      if (pageRows.length < this.dataApiPageLimit) {
        break;
      }
    }

    const rows = buildFollowerSnapshotRowsFromDataApiPositions(positions);
    const absoluteSharesSum = rows.reduce((sum, row) => sum + Math.abs(row.shares), 0);

    await this.persistFollowerSnapshot({
      copyProfileId: args.copyProfileId,
      snapshotAt: args.snapshotAt,
      snapshotAtMs: args.snapshotAtMs,
      rows,
      sourcePayload: {
        source: "RECONCILE_DATA_API",
        followerAddress: args.followerAddress,
        positionsSeen: positions.length,
        rebuiltAtMs: args.snapshotAtMs
      }
    });
    await this.tokenMetadataStore.upsertFromDataApiPositions(positions, args.snapshotAt);
    await this.currentStateStore.replaceFollowerCurrentPositions(
      args.copyProfileId,
      args.snapshotAt,
      "DATA_API",
      mapFollowerSnapshotRowsToCurrentPositions(rows)
    );

    return {
      tokensSnapshotted: rows.length,
      absoluteSharesSum
    };
  }

  private async rebuildFromFills(
    copyProfileId: string,
    snapshotAt: Date,
    snapshotAtMs: number,
    payload: Record<string, unknown>
  ): Promise<{
    tokensSnapshotted: number;
    absoluteSharesSum: number;
  }> {
    const fills = await this.prisma.copyFill.findMany({
      where: {
        copyOrder: {
          copyProfileId
        }
      },
      select: {
        tokenId: true,
        marketId: true,
        side: true,
        filledShares: true
      }
    });

    const byToken = new Map<string, { tokenId: string; marketId?: string; shares: number }>();
    for (const fill of fills) {
      const existing = byToken.get(fill.tokenId) ?? {
        tokenId: fill.tokenId,
        marketId: fill.marketId ?? undefined,
        shares: 0
      };

      if (!existing.marketId && fill.marketId) {
        existing.marketId = fill.marketId;
      }

      const signedShares = fill.side === "BUY" ? Number(fill.filledShares) : -Number(fill.filledShares);
      existing.shares += signedShares;
      byToken.set(fill.tokenId, existing);
    }

    const rows = [...byToken.values()].filter((row) => Math.abs(row.shares) >= 1e-12);
    const absoluteSharesSum = rows.reduce((sum, row) => sum + Math.abs(row.shares), 0);

    await this.persistFollowerSnapshot({
      copyProfileId,
      snapshotAt,
      snapshotAtMs,
      rows: rows.map((row) => ({
        tokenId: row.tokenId,
        marketId: row.marketId,
        shares: row.shares
      })),
      sourcePayload: {
        ...payload,
        rebuiltAtMs: snapshotAtMs
      }
    });
    await this.currentStateStore.replaceFollowerCurrentPositions(
      copyProfileId,
      snapshotAt,
      "RECONCILE_FILLS",
      mapFollowerSnapshotRowsToCurrentPositions(rows)
    );

    return {
      tokensSnapshotted: rows.length,
      absoluteSharesSum
    };
  }

  private async persistFollowerSnapshot(args: {
    copyProfileId: string;
    snapshotAt: Date;
    snapshotAtMs: number;
    rows: FollowerSnapshotRow[];
    sourcePayload: Record<string, unknown>;
  }): Promise<void> {
    const absoluteSharesSum = args.rows.reduce((sum, row) => sum + Math.abs(row.shares), 0);

    await this.prisma.$transaction(async (tx) => {
      if (args.rows.length > 0) {
        await tx.followerPositionSnapshot.createMany({
          data: args.rows.map((row) => ({
            copyProfileId: args.copyProfileId,
            snapshotAt: args.snapshotAt,
            snapshotAtMs: BigInt(args.snapshotAtMs),
            tokenId: row.tokenId,
            marketId: row.marketId ?? null,
            outcome: row.outcome ?? null,
            shares: String(row.shares),
            avgCostUsd: finiteNumberToString(row.avgCostUsd),
            currentPrice: finiteNumberToString(row.currentPrice),
            costBasisUsd: finiteNumberToString(row.costBasisUsd),
            currentValueUsd: finiteNumberToString(row.currentValueUsd),
            unrealizedPnlUsd: finiteNumberToString(row.unrealizedPnlUsd),
            payload: toInputJsonValue({
              ...args.sourcePayload,
              marketTitle: row.marketName ?? null
            })
          }))
        });
      }

      await tx.heartbeat.create({
        data: {
          component: "WORKER",
          instanceId: "reconcile-engine",
          status: "OK",
          observedAt: args.snapshotAt,
          payload: toInputJsonValue({
            kind: "FOLLOWER_RECONCILE",
            copyProfileId: args.copyProfileId,
            snapshotAt: args.snapshotAt.toISOString(),
            snapshotAtMs: args.snapshotAtMs,
            tokensSnapshotted: args.rows.length,
            absoluteSharesSum,
            source: args.sourcePayload.source ?? "UNKNOWN"
          })
        }
      });
    });
  }

  async getLatestLeaderSnapshotAt(): Promise<Date | null> {
    const aggregate = await this.prisma.leaderPositionSnapshot.aggregate({
      _max: {
        snapshotAt: true
      }
    });

    return aggregate._max.snapshotAt ?? null;
  }

  async getLatestFollowerSnapshotAt(copyProfileId: string): Promise<Date | null> {
    const aggregate = await this.prisma.followerPositionSnapshot.aggregate({
      where: {
        copyProfileId
      },
      _max: {
        snapshotAt: true
      }
    });

    const heartbeatRows = await this.prisma.$queryRaw<Array<{ observedAt: Date }>>`
      SELECT "observedAt"
      FROM "Heartbeat"
      WHERE "component" = 'WORKER'::"ComponentType"
        AND "payload"->>'kind' = 'FOLLOWER_RECONCILE'
        AND "payload"->>'copyProfileId' = ${copyProfileId}
      ORDER BY "observedAt" DESC
      LIMIT 1
    `;

    const snapshotAt = aggregate._max.snapshotAt ?? null;
    const heartbeatAt = heartbeatRows[0]?.observedAt ?? null;
    if (!snapshotAt) {
      return heartbeatAt;
    }
    if (!heartbeatAt) {
      return snapshotAt;
    }
    return snapshotAt.getTime() >= heartbeatAt.getTime() ? snapshotAt : heartbeatAt;
  }

  async countOpenAttemptCollisions(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT "copyProfileId", "tokenId", "side"
        FROM "CopyAttempt"
        WHERE "decision" = 'PENDING'::"AttemptDecision"
          AND "status" IN ('PENDING'::"AttemptStatus", 'RETRYING'::"AttemptStatus", 'EXECUTING'::"AttemptStatus")
        GROUP BY "copyProfileId", "tokenId", "side"
        HAVING COUNT(*) > 1
      ) AS collisions
    `;

    return rows[0]?.count ?? 0;
  }

  async countDuplicateOrderDecisionKeys(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT "copyAttemptId"
        FROM "CopyOrder"
        WHERE "copyAttemptId" IS NOT NULL
          AND "status" IN ('PLACED'::"OrderStatus", 'PARTIALLY_FILLED'::"OrderStatus", 'FILLED'::"OrderStatus")
        GROUP BY "copyAttemptId"
        HAVING COUNT(*) > 1
      ) AS duplicate_attempt_executions
    `;

    return rows[0]?.count ?? 0;
  }

  async writeReconcileAudit(input: ReconcileAuditRecord): Promise<void> {
    const nextHealth = input.status === "OK" ? "OK" : "DEGRADED";
    const latencyMs = asLatency(input.details.durationMs);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.systemStatus.findUnique({
        where: {
          component: "WORKER"
        },
        select: {
          status: true,
          details: true
        }
      });

      const baseDetails = asObject(existing?.details);
      const nextDetails = {
        ...baseDetails,
        reconcile: {
          cycleAt: input.cycleAt.toISOString(),
          status: input.status,
          ...input.details
        }
      };

      await tx.systemStatus.upsert({
        where: {
          component: "WORKER"
        },
        create: {
          component: "WORKER",
          status: nextHealth,
          lastEventAt: input.cycleAt,
          details: toInputJsonValue(nextDetails)
        },
        update: {
          status: nextHealth,
          lastEventAt: input.cycleAt,
          details: toInputJsonValue(nextDetails)
        }
      });

      await tx.heartbeat.create({
        data: {
          component: "WORKER",
          instanceId: "reconcile-engine",
          status: nextHealth,
          observedAt: input.cycleAt,
          latencyMs,
          payload: toInputJsonValue({
            kind: "RECONCILE_CYCLE",
            status: input.status,
            cycleAt: input.cycleAt.toISOString(),
            ...input.details
          })
        }
      });
    });
  }

  async writeReconcileIssue(input: {
    code: string;
    message: string;
    severity: "WARN" | "ERROR";
    context?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.errorEvent.create({
      data: {
        component: "WORKER",
        severity: input.severity === "WARN" ? "WARN" : "ERROR",
        code: input.code,
        message: input.message,
        context: input.context ? toInputJsonValue(input.context) : undefined
      }
    });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

interface FollowerSnapshotRow {
  tokenId: string;
  marketId?: string;
  marketName?: string;
  outcome?: string;
  shares: number;
  avgCostUsd?: number;
  currentPrice?: number;
  costBasisUsd?: number;
  currentValueUsd?: number;
  unrealizedPnlUsd?: number;
}

function buildFollowerSnapshotRowsFromDataApiPositions(positions: DataApiPosition[]): FollowerSnapshotRow[] {
  const byToken = new Map<string, FollowerSnapshotRow>();

  for (const position of positions) {
    const tokenId = position.asset;
    const shares = finiteOrZero(position.size);
    if (!tokenId || Math.abs(shares) < 1e-12) {
      continue;
    }

    const currentPrice = finiteOrUndefined(position.curPrice) ?? finiteOrUndefined(position.avgPrice);
    const currentValueUsd = finiteOrUndefined(position.currentValue) ?? (currentPrice !== undefined ? shares * currentPrice : undefined);
    const costBasisUsd = finiteOrUndefined(position.initialValue) ?? (finiteOrUndefined(position.avgPrice) !== undefined ? shares * (position.avgPrice as number) : undefined);
    const avgCostUsd =
      costBasisUsd !== undefined && Math.abs(shares) >= 1e-12 ? costBasisUsd / shares : finiteOrUndefined(position.avgPrice);
    const unrealizedPnlUsd =
      currentValueUsd !== undefined && costBasisUsd !== undefined ? currentValueUsd - costBasisUsd : undefined;

    const existing = byToken.get(tokenId);
    if (!existing) {
      byToken.set(tokenId, {
        tokenId,
        marketId: position.conditionId,
        marketName: readNonEmptyString(position.title) ?? readNonEmptyString(position.slug) ?? undefined,
        outcome: position.outcome,
        shares,
        avgCostUsd,
        currentPrice,
        costBasisUsd,
        currentValueUsd,
        unrealizedPnlUsd
      });
      continue;
    }

    existing.shares += shares;
    existing.costBasisUsd = sumDefined(existing.costBasisUsd, costBasisUsd);
    existing.currentValueUsd = sumDefined(existing.currentValueUsd, currentValueUsd);
    if (!existing.marketId && position.conditionId) {
      existing.marketId = position.conditionId;
    }
    if (!existing.outcome && position.outcome) {
      existing.outcome = position.outcome;
    }
    if (!existing.marketName) {
      existing.marketName = readNonEmptyString(position.title) ?? readNonEmptyString(position.slug) ?? undefined;
    }
  }

  return [...byToken.values()]
    .map((row) => {
      const currentPrice =
        row.currentPrice ??
        (row.currentValueUsd !== undefined && Math.abs(row.shares) >= 1e-12 ? row.currentValueUsd / row.shares : undefined);
      const avgCostUsd =
        row.avgCostUsd ??
        (row.costBasisUsd !== undefined && Math.abs(row.shares) >= 1e-12 ? row.costBasisUsd / row.shares : undefined);
      const unrealizedPnlUsd =
        row.unrealizedPnlUsd ??
        (row.currentValueUsd !== undefined && row.costBasisUsd !== undefined ? row.currentValueUsd - row.costBasisUsd : undefined);

      return {
        ...row,
        currentPrice,
        avgCostUsd,
        unrealizedPnlUsd
      };
    })
    .filter((row) => Math.abs(row.shares) >= 1e-12);
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    return null;
  }
  if (normalized === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return normalized;
}

function finiteOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left + right;
}

function finiteNumberToString(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return String(value);
}

function asLatency(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
