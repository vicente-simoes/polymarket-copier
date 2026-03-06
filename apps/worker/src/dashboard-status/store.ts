import { Prisma, PrismaClient } from "@copybot/db";

export interface DashboardStatusSummaryInput {
  nowMs?: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
}

export interface DashboardStatusSummaryDetails {
  errorCounts: {
    last15m: number;
    last1h: number;
    last24h: number;
  };
  orderAttemptOutcomes1h: Record<string, number>;
  orderAttemptOutcomes24h: Record<string, number>;
  skipReasons1h: Record<string, number>;
  skipReasons24h: Record<string, number>;
  latestMigration: {
    migrationName: string | null;
    finishedAt: string | null;
  };
  estimatedSnapshotCounts: {
    leaderPositionSnapshots: number;
    followerPositionSnapshots: number;
  };
  databaseSizeBytes: number | null;
  retryBackoff: {
    retryingAttempts: number;
    retryDueNow: number;
    nextRetryAt: string | null;
    nextRetryInSeconds: number | null;
    retryingByTokenTop: Array<{ tokenId: string; count: number }>;
  };
}

export async function computeDashboardStatusSummary(
  prisma: PrismaClient,
  input: DashboardStatusSummaryInput
): Promise<DashboardStatusSummaryDetails> {
  const nowMs = input.nowMs ?? Date.now();
  const last15mAt = new Date(nowMs - 15 * 60_000);
  const last1hAt = new Date(nowMs - 3_600_000);
  const last24hAt = new Date(nowMs - 24 * 3_600_000);

  const [
    errorCount15m,
    errorCount1h,
    errorCount24h,
    orderOutcomes1hRows,
    orderOutcomes24hRows,
    skipReasons1hRows,
    skipReasons24hRows,
    retryingAttempts,
    latestMigration,
    estimatedSnapshotCounts,
    databaseSizeBytes
  ] = await Promise.all([
    prisma.errorEvent.count({
      where: {
        occurredAt: {
          gte: last15mAt
        },
        severity: {
          in: ["ERROR", "CRITICAL"]
        }
      }
    }),
    prisma.errorEvent.count({
      where: {
        occurredAt: {
          gte: last1hAt
        },
        severity: {
          in: ["ERROR", "CRITICAL"]
        }
      }
    }),
    prisma.errorEvent.count({
      where: {
        occurredAt: {
          gte: last24hAt
        },
        severity: {
          in: ["ERROR", "CRITICAL"]
        }
      }
    }),
    prisma.copyOrder.groupBy({
      by: ["status"],
      where: {
        attemptedAt: {
          gte: last1hAt
        }
      },
      _count: {
        _all: true
      }
    }),
    prisma.copyOrder.groupBy({
      by: ["status"],
      where: {
        attemptedAt: {
          gte: last24hAt
        }
      },
      _count: {
        _all: true
      }
    }),
    prisma.copyAttempt.groupBy({
      by: ["reason"],
      where: {
        updatedAt: {
          gte: last1hAt
        },
        reason: {
          not: null
        }
      },
      _count: {
        _all: true
      }
    }),
    prisma.copyAttempt.groupBy({
      by: ["reason"],
      where: {
        updatedAt: {
          gte: last24hAt
        },
        reason: {
          not: null
        }
      },
      _count: {
        _all: true
      }
    }),
    prisma.copyAttempt.findMany({
      where: {
        status: "RETRYING",
        decision: "PENDING"
      },
      select: {
        tokenId: true,
        retries: true,
        attemptedAt: true
      }
    }),
    fetchLatestMigration(prisma),
    fetchEstimatedSnapshotCounts(prisma),
    fetchDatabaseSizeBytes(prisma)
  ]);

  return {
    errorCounts: {
      last15m: errorCount15m,
      last1h: errorCount1h,
      last24h: errorCount24h
    },
    orderAttemptOutcomes1h: toCountRecord(orderOutcomes1hRows, "status"),
    orderAttemptOutcomes24h: toCountRecord(orderOutcomes24hRows, "status"),
    skipReasons1h: toCountRecord(skipReasons1hRows, "reason"),
    skipReasons24h: toCountRecord(skipReasons24hRows, "reason"),
    latestMigration: {
      migrationName: latestMigration?.migrationName ?? null,
      finishedAt: latestMigration?.finishedAt?.toISOString() ?? null
    },
    estimatedSnapshotCounts,
    databaseSizeBytes,
    retryBackoff: computeRetryState(retryingAttempts, nowMs, input.retryBackoffBaseMs, input.retryBackoffMaxMs)
  };
}

export async function writeDashboardStatusSummary(
  prisma: PrismaClient,
  input: DashboardStatusSummaryInput
): Promise<DashboardStatusSummaryDetails> {
  const details = await computeDashboardStatusSummary(prisma, input);
  const lastEventAt = new Date(input.nowMs ?? Date.now());
  const detailsJson = JSON.stringify(toJsonValue(details));

  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "SystemStatus" ("component", "status", "lastEventAt", "details", "updatedAt")
    VALUES ('DASHBOARD_STATUS'::"ComponentType", 'OK'::"HealthStatus", ${lastEventAt}, ${detailsJson}::jsonb, ${lastEventAt})
    ON CONFLICT ("component")
    DO UPDATE SET
      "status" = 'OK'::"HealthStatus",
      "lastEventAt" = EXCLUDED."lastEventAt",
      "details" = EXCLUDED."details",
      "updatedAt" = EXCLUDED."updatedAt"
  `);

  return details;
}

async function fetchLatestMigration(prisma: PrismaClient): Promise<{ migrationName: string; finishedAt: Date | null } | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>(
      Prisma.sql`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1`
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      migrationName: row.migration_name,
      finishedAt: row.finished_at
    };
  } catch {
    return null;
  }
}

async function fetchEstimatedSnapshotCounts(prisma: PrismaClient): Promise<{
  leaderPositionSnapshots: number;
  followerPositionSnapshots: number;
}> {
  try {
    const rows = await prisma.$queryRaw<Array<{ relname: string; estimated_rows: bigint | number }>>(
      Prisma.sql`
        SELECT relname, GREATEST(n_live_tup, 0)::bigint AS estimated_rows
        FROM pg_stat_user_tables
        WHERE relname IN ('LeaderPositionSnapshot', 'FollowerPositionSnapshot')
      `
    );

    const counts = new Map(rows.map((row) => [row.relname, Number(row.estimated_rows)]));
    return {
      leaderPositionSnapshots: counts.get("LeaderPositionSnapshot") ?? 0,
      followerPositionSnapshots: counts.get("FollowerPositionSnapshot") ?? 0
    };
  } catch {
    const [leaderPositionSnapshots, followerPositionSnapshots] = await Promise.all([
      prisma.leaderPositionSnapshot.count(),
      prisma.followerPositionSnapshot.count()
    ]);
    return {
      leaderPositionSnapshots,
      followerPositionSnapshots
    };
  }
}

async function fetchDatabaseSizeBytes(prisma: PrismaClient): Promise<number | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ size_bytes: bigint | number | string }>>(
      Prisma.sql`SELECT pg_database_size(current_database()) AS size_bytes`
    );
    const size = rows[0]?.size_bytes;
    if (typeof size === "bigint") {
      return Number(size);
    }
    if (typeof size === "number") {
      return Number.isFinite(size) ? size : null;
    }
    if (typeof size === "string") {
      const parsed = Number(size);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

function computeRetryState(
  rows: Array<{ tokenId: string; retries: number; attemptedAt: Date | null }>,
  nowMs: number,
  backoffBaseMs: number,
  backoffMaxMs: number
): {
  retryingAttempts: number;
  retryDueNow: number;
  nextRetryAt: string | null;
  nextRetryInSeconds: number | null;
  retryingByTokenTop: Array<{ tokenId: string; count: number }>;
} {
  let retryDueNow = 0;
  let nextDueAtMs: number | null = null;
  const byToken = new Map<string, number>();

  for (const row of rows) {
    const attemptAtMs = row.attemptedAt?.getTime() ?? nowMs;
    const dueAtMs = attemptAtMs + computeBackoffMs(row.retries, backoffBaseMs, backoffMaxMs);
    if (dueAtMs <= nowMs) {
      retryDueNow += 1;
    }
    if (nextDueAtMs === null || dueAtMs < nextDueAtMs) {
      nextDueAtMs = dueAtMs;
    }
    byToken.set(row.tokenId, (byToken.get(row.tokenId) ?? 0) + 1);
  }

  return {
    retryingAttempts: rows.length,
    retryDueNow,
    nextRetryAt: nextDueAtMs ? new Date(nextDueAtMs).toISOString() : null,
    nextRetryInSeconds: nextDueAtMs ? Math.max(0, Math.trunc((nextDueAtMs - nowMs) / 1_000)) : null,
    retryingByTokenTop: [...byToken.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 5)
      .map(([tokenId, count]) => ({ tokenId, count }))
  };
}

function computeBackoffMs(retries: number, baseMs: number, maxMs: number): number {
  if (!Number.isFinite(retries) || retries <= 0) {
    return 0;
  }
  const exponent = Math.max(0, Math.trunc(retries) - 1);
  const raw = baseMs * 2 ** exponent;
  return Math.min(raw, maxMs);
}

function toCountRecord<TField extends string>(
  rows: Array<{ [key: string]: unknown; _count: { _all: number } }>,
  field: TField
): Record<string, number> {
  const output: Record<string, number> = {};
  for (const row of rows) {
    const key = row[field];
    if (typeof key !== "string" || key.length === 0) {
      continue;
    }
    output[key] = row._count._all;
  }
  return output;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
