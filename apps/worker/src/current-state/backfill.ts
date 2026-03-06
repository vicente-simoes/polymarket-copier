import { Prisma, PrismaClient } from "@copybot/db";
import {
  buildLeaderLatestTradePriceInputs,
  mapFollowerSnapshotRowsToCurrentPositions,
  PrismaCurrentStateStore,
  type CurrentPositionSource,
  type FollowerCurrentPositionInput,
  type LeaderCurrentPositionInput
} from "./store.js";

interface LeaderCurrentPositionHistoryRow {
  leaderId: string;
  tokenId: string;
  marketId: string | null;
  shares: Prisma.Decimal;
  avgPrice: Prisma.Decimal | null;
  currentPrice: Prisma.Decimal | null;
  currentValueUsd: Prisma.Decimal | null;
  snapshotAt: Date;
}

interface FollowerCurrentPositionHistoryRow {
  copyProfileId: string;
  tokenId: string;
  marketId: string | null;
  outcome: string | null;
  shares: Prisma.Decimal;
  costBasisUsd: Prisma.Decimal | null;
  currentPrice: Prisma.Decimal | null;
  currentValueUsd: Prisma.Decimal | null;
  payload: Prisma.JsonValue | null;
  snapshotAt: Date;
}

interface LatestTradePriceHistoryRow {
  leaderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: Prisma.Decimal;
  leaderFillAtMs: bigint;
  source: "CHAIN" | "DATA_API";
}

export async function loadLeaderCurrentPositionBackfillRows(
  prisma: PrismaClient
): Promise<LeaderCurrentPositionHistoryRow[]> {
  return prisma.$queryRaw<LeaderCurrentPositionHistoryRow[]>(
    Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON ("leaderId") "leaderId", "snapshotAt"
        FROM "LeaderPositionSnapshot"
        ORDER BY "leaderId" ASC, "snapshotAt" DESC
      )
      SELECT
        l."leaderId",
        s."tokenId",
        s."marketId",
        s."shares",
        s."avgPrice",
        s."currentPrice",
        s."currentValueUsd",
        s."snapshotAt"
      FROM latest l
      INNER JOIN "LeaderPositionSnapshot" s
        ON s."leaderId" = l."leaderId"
       AND s."snapshotAt" = l."snapshotAt"
      ORDER BY l."leaderId" ASC, s."tokenId" ASC
    `
  );
}

export async function loadFollowerCurrentPositionBackfillRows(
  prisma: PrismaClient
): Promise<FollowerCurrentPositionHistoryRow[]> {
  return prisma.$queryRaw<FollowerCurrentPositionHistoryRow[]>(
    Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON ("copyProfileId") "copyProfileId", "snapshotAt"
        FROM "FollowerPositionSnapshot"
        ORDER BY "copyProfileId" ASC, "snapshotAt" DESC
      )
      SELECT
        l."copyProfileId",
        s."tokenId",
        s."marketId",
        s."outcome",
        s."shares",
        s."costBasisUsd",
        s."currentPrice",
        s."currentValueUsd",
        s."payload",
        s."snapshotAt"
      FROM latest l
      INNER JOIN "FollowerPositionSnapshot" s
        ON s."copyProfileId" = l."copyProfileId"
       AND s."snapshotAt" = l."snapshotAt"
      ORDER BY l."copyProfileId" ASC, s."tokenId" ASC
    `
  );
}

export async function loadLeaderLatestTradePriceBackfillRows(
  prisma: PrismaClient
): Promise<LatestTradePriceHistoryRow[]> {
  return prisma.$queryRaw<LatestTradePriceHistoryRow[]>(
    Prisma.sql`
      SELECT DISTINCT ON ("leaderId", "tokenId", "side")
        "leaderId",
        "tokenId",
        "side",
        "price",
        "leaderFillAtMs",
        "source"
      FROM "LeaderTradeEvent"
      WHERE "price" > 0
      ORDER BY "leaderId" ASC, "tokenId" ASC, "side" ASC, "leaderFillAtMs" DESC, "createdAt" DESC
    `
  );
}

export async function runLeaderCurrentPositionBackfill(prisma: PrismaClient): Promise<{
  rowsLoaded: number;
  leadersProcessed: number;
  rowsUpserted: number;
}> {
  const store = new PrismaCurrentStateStore(prisma);
  const rows = await loadLeaderCurrentPositionBackfillRows(prisma);
  const rowsByLeader = new Map<string, { snapshotAt: Date; positions: LeaderCurrentPositionInput[] }>();

  for (const row of rows) {
    const group = rowsByLeader.get(row.leaderId) ?? {
      snapshotAt: row.snapshotAt,
      positions: []
    };
    group.positions.push({
      tokenId: row.tokenId,
      marketId: row.marketId ?? undefined,
      shares: Number(row.shares),
      avgPrice: row.avgPrice !== null ? Number(row.avgPrice) : undefined,
      currentPrice: row.currentPrice !== null ? Number(row.currentPrice) : undefined,
      currentValueUsd: row.currentValueUsd !== null ? Number(row.currentValueUsd) : undefined
    });
    rowsByLeader.set(row.leaderId, group);
  }

  let rowsUpserted = 0;
  for (const [leaderId, group] of rowsByLeader.entries()) {
    const result = await store.replaceLeaderCurrentPositions(leaderId, group.snapshotAt, group.positions);
    rowsUpserted += result.created + result.updated;
  }

  return {
    rowsLoaded: rows.length,
    leadersProcessed: rowsByLeader.size,
    rowsUpserted
  };
}

export async function runFollowerCurrentPositionBackfill(prisma: PrismaClient): Promise<{
  rowsLoaded: number;
  profilesProcessed: number;
  rowsUpserted: number;
}> {
  const store = new PrismaCurrentStateStore(prisma);
  const rows = await loadFollowerCurrentPositionBackfillRows(prisma);
  const rowsByProfile = new Map<
    string,
    {
      snapshotAt: Date;
      source: CurrentPositionSource;
      positions: FollowerCurrentPositionInput[];
    }
  >();

  for (const row of rows) {
    const group = rowsByProfile.get(row.copyProfileId) ?? {
      snapshotAt: row.snapshotAt,
      source: resolveFollowerCurrentPositionSource(row.payload),
      positions: []
    };
    group.positions.push(
      ...mapFollowerSnapshotRowsToCurrentPositions([
        {
          tokenId: row.tokenId,
          marketId: row.marketId,
          outcome: row.outcome,
          shares: Number(row.shares),
          costBasisUsd: row.costBasisUsd !== null ? Number(row.costBasisUsd) : undefined,
          currentPrice: row.currentPrice !== null ? Number(row.currentPrice) : undefined,
          currentValueUsd: row.currentValueUsd !== null ? Number(row.currentValueUsd) : undefined
        }
      ])
    );
    rowsByProfile.set(row.copyProfileId, group);
  }

  let rowsUpserted = 0;
  for (const [copyProfileId, group] of rowsByProfile.entries()) {
    const result = await store.replaceFollowerCurrentPositions(copyProfileId, group.snapshotAt, group.source, group.positions);
    rowsUpserted += result.created + result.updated;
  }

  return {
    rowsLoaded: rows.length,
    profilesProcessed: rowsByProfile.size,
    rowsUpserted
  };
}

export async function runLeaderLatestTradePriceBackfill(prisma: PrismaClient): Promise<{
  rowsLoaded: number;
  rowsUpserted: number;
}> {
  const store = new PrismaCurrentStateStore(prisma);
  const rows = await loadLeaderLatestTradePriceBackfillRows(prisma);
  const result = await store.upsertLeaderLatestTradePrices(
    buildLeaderLatestTradePriceInputsFromRows(rows)
  );

  return {
    rowsLoaded: rows.length,
    rowsUpserted: result.created + result.updated
  };
}

export function buildLeaderLatestTradePriceInputsFromRows(
  rows: LatestTradePriceHistoryRow[]
) {
  return rows.map((row) => ({
    leaderId: row.leaderId,
    tokenId: row.tokenId,
    side: row.side,
    price: Number(row.price),
    leaderFillAtMs: Number(row.leaderFillAtMs),
    source: row.source
  }));
}

export function resolveFollowerCurrentPositionSource(payload: Prisma.JsonValue | null): CurrentPositionSource {
  const root = asObject(payload);
  const source = root.source;
  if (source === "RECONCILE_DATA_API") {
    return "DATA_API";
  }
  return "RECONCILE_FILLS";
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
