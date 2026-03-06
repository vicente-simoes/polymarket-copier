import { Prisma, PrismaClient } from "@copybot/db";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface HistoryPruneConfig {
  leaderPositionSnapshotDays: number;
  followerPositionSnapshotDays: number;
  heartbeatDays: number;
  errorEventDays: number;
  batchSize: number;
}

export interface HistoryPruneResult {
  ranAt: string;
  batchSize: number;
  tables: Record<string, { deleted: number; skipped: boolean; reason?: string }>;
}

export const DEFAULT_HISTORY_PRUNE_CONFIG: HistoryPruneConfig = {
  leaderPositionSnapshotDays: 7,
  followerPositionSnapshotDays: 7,
  heartbeatDays: 14,
  errorEventDays: 30,
  batchSize: 10_000
};

export async function runHistoryPrune(
  prisma: PrismaClient,
  config: HistoryPruneConfig = DEFAULT_HISTORY_PRUNE_CONFIG,
  now = new Date()
): Promise<HistoryPruneResult> {
  const leaderSnapshotTable = "LeaderPositionSnapshot";
  const followerSnapshotTable = "FollowerPositionSnapshot";
  const heartbeatTable = "Heartbeat";
  const errorEventTable = "ErrorEvent";
  const result: HistoryPruneResult = {
    ranAt: now.toISOString(),
    batchSize: config.batchSize,
    tables: {
      [leaderSnapshotTable]: { deleted: 0, skipped: false },
      [followerSnapshotTable]: { deleted: 0, skipped: false },
      [heartbeatTable]: { deleted: 0, skipped: false },
      [errorEventTable]: { deleted: 0, skipped: false }
    }
  };

  const [leaderCurrentCount, followerCurrentCount] = await Promise.all([
    countRows(prisma, "LeaderCurrentPosition"),
    countRows(prisma, "FollowerCurrentPosition")
  ]);

  if (leaderCurrentCount <= 0) {
    result.tables[leaderSnapshotTable] = {
      deleted: 0,
      skipped: true,
      reason: "leader_current_positions_empty"
    };
  } else {
    result.tables[leaderSnapshotTable]!.deleted = await pruneTableInBatches(
      prisma,
      "LeaderPositionSnapshot",
      "snapshotAt",
      new Date(now.getTime() - config.leaderPositionSnapshotDays * DAY_MS),
      config.batchSize
    );
  }

  if (followerCurrentCount <= 0) {
    result.tables[followerSnapshotTable] = {
      deleted: 0,
      skipped: true,
      reason: "follower_current_positions_empty"
    };
  } else {
    result.tables[followerSnapshotTable]!.deleted = await pruneTableInBatches(
      prisma,
      "FollowerPositionSnapshot",
      "snapshotAt",
      new Date(now.getTime() - config.followerPositionSnapshotDays * DAY_MS),
      config.batchSize
    );
  }

  result.tables[heartbeatTable]!.deleted = await pruneTableInBatches(
    prisma,
    "Heartbeat",
    "observedAt",
    new Date(now.getTime() - config.heartbeatDays * DAY_MS),
    config.batchSize
  );
  result.tables[errorEventTable]!.deleted = await pruneTableInBatches(
    prisma,
    "ErrorEvent",
    "occurredAt",
    new Date(now.getTime() - config.errorEventDays * DAY_MS),
    config.batchSize
  );

  return result;
}

export async function runHistoryPruneSafely(
  prisma: PrismaClient,
  config: HistoryPruneConfig = DEFAULT_HISTORY_PRUNE_CONFIG,
  now = new Date()
): Promise<HistoryPruneResult> {
  try {
    return await runHistoryPrune(prisma, config, now);
  } catch (error) {
    await prisma.errorEvent.create({
      data: {
        component: "WORKER",
        severity: "ERROR",
        code: "HISTORY_PRUNE_FAILED",
        message: toErrorMessage(error),
        context: {
          now: now.toISOString(),
          batchSize: config.batchSize
        }
      }
    });
    throw error;
  }
}

async function pruneTableInBatches(
  prisma: PrismaClient,
  tableName: "LeaderPositionSnapshot" | "FollowerPositionSnapshot" | "Heartbeat" | "ErrorEvent",
  timestampColumn: "snapshotAt" | "observedAt" | "occurredAt",
  cutoff: Date,
  batchSize: number
): Promise<number> {
  let totalDeleted = 0;

  while (true) {
    const deleted = await prisma.$executeRaw(
      Prisma.sql`
        WITH doomed AS (
          SELECT "id"
          FROM ${Prisma.raw(`"${tableName}"`)}
          WHERE ${Prisma.raw(`"${timestampColumn}"`)} < ${cutoff}
          ORDER BY ${Prisma.raw(`"${timestampColumn}"`)} ASC
          LIMIT ${batchSize}
        )
        DELETE FROM ${Prisma.raw(`"${tableName}"`)}
        WHERE "id" IN (SELECT "id" FROM doomed)
      `
    );

    if (!deleted || deleted <= 0) {
      break;
    }
    totalDeleted += Number(deleted);
    if (Number(deleted) < batchSize) {
      break;
    }
  }

  return totalDeleted;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function countRows(
  prisma: PrismaClient,
  tableName: "LeaderCurrentPosition" | "FollowerCurrentPosition"
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint | number | string }>>(Prisma.sql`
    SELECT COUNT(*) AS count
    FROM ${Prisma.raw(`"${tableName}"`)}
  `);
  const count = rows[0]?.count;
  return typeof count === "bigint" ? Number(count) : Number(count ?? 0);
}
