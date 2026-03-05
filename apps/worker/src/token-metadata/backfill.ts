import { Prisma, PrismaClient } from "@copybot/db";
import type { TokenDisplayMetadataObservation } from "@copybot/shared";
import { buildTokenMetadataObservationFromRow, mergeObservationBatch, PrismaTokenMetadataStore } from "./store.js";

interface TokenMetadataHistoryRow {
  tokenId: string;
  marketId: string | null;
  outcome: string | null;
  payload: Prisma.JsonValue | null;
  observedAt: Date;
}

export async function loadTokenMetadataBackfillObservations(
  prisma: PrismaClient
): Promise<TokenDisplayMetadataObservation[]> {
  const [leaderPositionRows, leaderTradeRows, followerPositionRows] = await Promise.all([
    prisma.$queryRaw<TokenMetadataHistoryRow[]>(
      Prisma.sql`
        SELECT DISTINCT ON ("tokenId")
          "tokenId",
          "marketId",
          "outcome",
          "payload",
          "snapshotAt" AS "observedAt"
        FROM "LeaderPositionSnapshot"
        ORDER BY "tokenId" ASC, "snapshotAt" DESC
      `
    ),
    prisma.$queryRaw<TokenMetadataHistoryRow[]>(
      Prisma.sql`
        SELECT DISTINCT ON ("tokenId")
          "tokenId",
          "marketId",
          "outcome",
          "payload",
          to_timestamp(("leaderFillAtMs"::double precision) / 1000.0) AS "observedAt"
        FROM "LeaderTradeEvent"
        ORDER BY "tokenId" ASC, "leaderFillAtMs" DESC
      `
    ),
    prisma.$queryRaw<TokenMetadataHistoryRow[]>(
      Prisma.sql`
        SELECT DISTINCT ON ("tokenId")
          "tokenId",
          "marketId",
          "outcome",
          "payload",
          "snapshotAt" AS "observedAt"
        FROM "FollowerPositionSnapshot"
        ORDER BY "tokenId" ASC, "snapshotAt" DESC
      `
    )
  ]);

  return mergeBackfillObservationGroups({
    leaderPositions: rowsToObservations(leaderPositionRows),
    leaderTrades: rowsToObservations(leaderTradeRows),
    followerPositions: rowsToObservations(followerPositionRows)
  });
}

export async function runTokenMetadataBackfill(prisma: PrismaClient): Promise<{
  observationsLoaded: number;
  rowsUpserted: number;
}> {
  const observations = await loadTokenMetadataBackfillObservations(prisma);
  const store = new PrismaTokenMetadataStore(prisma);
  await store.upsertObservations(observations);
  return {
    observationsLoaded: observations.length,
    rowsUpserted: observations.length
  };
}

export function mergeBackfillObservationGroups(groups: {
  leaderPositions: TokenDisplayMetadataObservation[];
  leaderTrades: TokenDisplayMetadataObservation[];
  followerPositions: TokenDisplayMetadataObservation[];
}): TokenDisplayMetadataObservation[] {
  return mergeObservationBatch([
    ...groups.leaderPositions,
    ...groups.leaderTrades,
    ...groups.followerPositions
  ]);
}

function rowsToObservations(rows: TokenMetadataHistoryRow[]): TokenDisplayMetadataObservation[] {
  return rows
    .map((row) =>
      buildTokenMetadataObservationFromRow({
        tokenId: row.tokenId,
        marketId: row.marketId,
        outcome: row.outcome,
        payload: row.payload,
        observedAt: row.observedAt
      })
    )
    .filter((value): value is TokenDisplayMetadataObservation => value !== null);
}
