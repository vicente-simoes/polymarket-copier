import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'
import { fetchWorkerHealth } from '@/lib/server/worker-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HealthStatusSchema = z.enum(['OK', 'DOWN', 'UNKNOWN'])

const StatusDataSchema = z.object({
  cards: z.object({
    worker: z.object({
      status: HealthStatusSchema,
      lastUpdatedAt: z.string().nullable(),
      lastEventAt: z.string().nullable()
    }),
    database: z.object({
      status: HealthStatusSchema,
      lastUpdatedAt: z.string().nullable(),
      latencyMs: z.number().nullable(),
      sizeBytes: z.number().nullable()
    }),
    redis: z.object({
      status: HealthStatusSchema,
      lastUpdatedAt: z.string().nullable()
    }),
    websocket: z.object({
      status: HealthStatusSchema,
      lastUpdatedAt: z.string().nullable(),
      connected: z.boolean().nullable()
    })
  }),
  details: z.object({
    worker: z.object({
      loops: z.object({
        tradeDetectionRunning: z.boolean().nullable(),
        reconcileRunning: z.boolean().nullable(),
        executionRunning: z.boolean().nullable()
      }),
      controls: z.object({
        envCopySystemEnabled: z.boolean(),
        profileCopySystemEnabled: z.boolean().nullable(),
        panicModeEnabled: z.boolean(),
        dryRunModeEnabled: z.boolean()
      }),
      reconcileIntervalSeconds: z.number().int().positive(),
      nextReconcileInSeconds: z.number().int().nonnegative().nullable(),
      lastReconcileSummary: z.record(z.string(), z.unknown()),
      errorCounts: z.object({
        last15m: z.number().int().nonnegative(),
        last1h: z.number().int().nonnegative(),
        last24h: z.number().int().nonnegative()
      }),
      lastError: z
        .object({
          message: z.string(),
          code: z.string().nullable(),
          component: z.string(),
          severity: z.string(),
          occurredAt: z.string(),
          stack: z.string().nullable()
        })
        .nullable(),
      retryBackoff: z.object({
        totalBackoffSkips: z.number().int().nonnegative(),
        retryingAttempts: z.number().int().nonnegative(),
        retryDueNow: z.number().int().nonnegative(),
        nextRetryAt: z.string().nullable(),
        nextRetryInSeconds: z.number().int().nonnegative().nullable(),
        retryingByTokenTop: z.array(
          z.object({
            tokenId: z.string(),
            count: z.number().int().positive()
          })
        )
      }),
      orderAttemptOutcomes1h: z.record(z.string(), z.number().int().nonnegative()),
      orderAttemptOutcomes24h: z.record(z.string(), z.number().int().nonnegative()),
      skipReasons1h: z.record(z.string(), z.number().int().nonnegative()),
      skipReasons24h: z.record(z.string(), z.number().int().nonnegative())
    }),
    database: z.object({
      latencyMs: z.number().nullable(),
      sizeBytes: z.number().nullable(),
      migration: z.object({
        latestMigration: z.string().nullable(),
        latestAppliedAt: z.string().nullable()
      }),
      tableCounts: z.object({
        leaders: z.number().int().nonnegative(),
        leaderPositionSnapshots: z.number().int().nonnegative(),
        followerPositionSnapshots: z.number().int().nonnegative(),
        copyOrders: z.number().int().nonnegative(),
        copyAttempts: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative()
      })
    }),
    redis: z.object({
      details: z.record(z.string(), z.unknown()),
      queueCounts: z.record(z.string(), z.number()),
      oldestPendingJobAgeSeconds: z.number().nullable(),
      memoryUsedBytes: z.number().nullable(),
      evictionWarnings: z.number().nullable()
    }),
    websocket: z.object({
      activeSubscriptionCount: z.number().int().nonnegative().nullable(),
      messageRatePerMin: z.number().nullable(),
      connectionUptimeSeconds: z.number().nullable(),
      reconnectCount: z.number().int().nonnegative().nullable(),
      lastDisconnectReason: z.string().nullable(),
      lastTriggerLagMs: z.number().nullable(),
      lastWsLagMs: z.number().nullable(),
      lastDetectLagMs: z.number().nullable(),
      wsBackedTokenCount: z.number().int().nonnegative().nullable(),
      restBackedTokenCount: z.number().int().nonnegative().nullable(),
      fallbackUsage1h: z.number().int().nonnegative(),
      fallbackUsage24h: z.number().int().nonnegative()
    })
  })
})

export async function GET(_request: NextRequest) {
  try {
    const nowMs = Date.now()
    const last15mAt = new Date(nowMs - 15 * 60_000)
    const last1hAt = new Date(nowMs - 3_600_000)
    const last24hAt = new Date(nowMs - 24 * 3_600_000)

    const startedDbPingAt = nowMs
    let databaseLatencyMs: number | null = null
    let databaseReachable = false
    try {
      await prisma.$queryRaw`SELECT 1`
      databaseReachable = true
      databaseLatencyMs = Date.now() - startedDbPingAt
    } catch {
      databaseReachable = false
      databaseLatencyMs = null
    }

    const [
      workerHealth,
      workerSystemStatus,
      redisSystemStatus,
      lastError,
      errorCount15m,
      errorCount1h,
      errorCount24h,
      exactCounts,
      estimatedSnapshotCounts,
      fallbackUsage1h,
      fallbackUsage24h,
      latestMigration,
      databaseSizeBytes,
      retryingAttempts,
      orderOutcomes1hRows,
      orderOutcomes24hRows,
      skipReasons1hRows,
      skipReasons24hRows,
      activeCopyProfile
    ] = await Promise.all([
      fetchWorkerHealth(),
      prisma.systemStatus.findUnique({
        where: {
          component: 'WORKER'
        },
        select: {
          status: true,
          lastUpdatedAt: true,
          details: true
        }
      }),
      prisma.systemStatus.findUnique({
        where: {
          component: 'REDIS'
        },
        select: {
          status: true,
          lastUpdatedAt: true,
          details: true
        }
      }),
      prisma.errorEvent.findFirst({
        orderBy: {
          occurredAt: 'desc'
        },
        select: {
          message: true,
          code: true,
          component: true,
          severity: true,
          occurredAt: true,
          stack: true
        }
      }),
      prisma.errorEvent.count({
        where: {
          occurredAt: {
            gte: last15mAt
          },
          severity: {
            in: ['ERROR', 'CRITICAL']
          }
        }
      }),
      prisma.errorEvent.count({
        where: {
          occurredAt: {
            gte: last1hAt
          },
          severity: {
            in: ['ERROR', 'CRITICAL']
          }
        }
      }),
      prisma.errorEvent.count({
        where: {
          occurredAt: {
            gte: last24hAt
          },
          severity: {
            in: ['ERROR', 'CRITICAL']
          }
        }
      }),
      Promise.all([
        prisma.leader.count(),
        prisma.copyOrder.count(),
        prisma.copyAttempt.count(),
        prisma.errorEvent.count()
      ]),
      fetchEstimatedSnapshotCounts(),
      prisma.leaderTradeEvent.count({
        where: {
          source: 'DATA_API',
          detectedAtMs: {
            gte: BigInt(nowMs - 3_600_000)
          }
        }
      }),
      prisma.leaderTradeEvent.count({
        where: {
          source: 'DATA_API',
          detectedAtMs: {
            gte: BigInt(nowMs - 24 * 3_600_000)
          }
        }
      }),
      fetchLatestMigration(),
      fetchDatabaseSizeBytes(),
      prisma.copyAttempt.findMany({
        where: {
          status: 'RETRYING',
          decision: 'PENDING'
        },
        select: {
          tokenId: true,
          retries: true,
          attemptedAt: true
        }
      }),
      prisma.copyOrder.groupBy({
        by: ['status'],
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
        by: ['status'],
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
        by: ['reason'],
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
        by: ['reason'],
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
      prisma.copyProfile.findFirst({
        where: {
          status: {
            in: ['ACTIVE', 'PAUSED']
          }
        },
        orderBy: {
          createdAt: 'asc'
        },
        select: {
          config: true
        }
      })
    ])

    const workerDetails = asObject(workerHealth ?? workerSystemStatus?.details)
    const reconcileDetails = asObject(workerDetails.reconcile)
    const chainDetails = asObject(workerDetails.chainTriggers)
    const executionDetails = asObject(workerDetails.execution)
    const marketDataDetails = asObject(workerDetails.marketData)
    const marketFreshness = asObject(marketDataDetails.freshness)
    const redisDetails = asObject(redisSystemStatus?.details)
    const profileCopySystemEnabled = readCopySystemEnabled(activeCopyProfile?.config)

    const reconcileIntervalSeconds = toPositiveInt(process.env.RECONCILE_INTERVAL_SECONDS, 60)
    const lastReconcileRunAtMs = toNumber(reconcileDetails.lastRunAtMs)
    const nextReconcileInSeconds =
      lastReconcileRunAtMs > 0
        ? Math.max(0, Math.trunc((lastReconcileRunAtMs + reconcileIntervalSeconds * 1_000 - nowMs) / 1_000))
        : null

    const workerStatus = workerHealth ? 'OK' : mapSystemStatus(workerSystemStatus?.status)
    const redisStatus = mapSystemStatus(redisSystemStatus?.status)
    const websocketConnected = asBoolean(chainDetails.connected)

    const messageRatePerMin = (() => {
      const receivedMessages = toNumber(chainDetails.receivedMessages)
      const connectedAtMs = toNumber(chainDetails.connectedAtMs)
      if (receivedMessages <= 0 || connectedAtMs <= 0) {
        return null
      }
      const uptimeMinutes = Math.max((nowMs - connectedAtMs) / 60_000, 1)
      return receivedMessages / uptimeMinutes
    })()
    const connectionUptimeSeconds = (() => {
      const connectedAtMs = toNumber(chainDetails.connectedAtMs)
      if (connectedAtMs <= 0) {
        return null
      }
      return Math.max(0, Math.trunc((nowMs - connectedAtMs) / 1_000))
    })()

    const queueCounts = asNumberRecord(redisDetails.queueCounts)
    const oldestPendingJobAgeSeconds = asNullableNumber(
      redisDetails.oldestPendingJobAgeSeconds ?? redisDetails.oldestJobAgeSeconds
    )
    const memoryUsedBytes = asNullableNumber(redisDetails.memoryUsedBytes ?? redisDetails.memoryUsageBytes)
    const evictionWarnings = asNullableNumber(redisDetails.evictionWarnings ?? redisDetails.evictions)

    const retryBackoffBaseMs = toPositiveInt(process.env.EXECUTION_RETRY_BACKOFF_BASE_MS, 5_000)
    const retryBackoffMaxMs = toPositiveInt(process.env.EXECUTION_RETRY_BACKOFF_MAX_MS, 300_000)
    const retryState = computeRetryState(retryingAttempts, nowMs, retryBackoffBaseMs, retryBackoffMaxMs)

    return jsonContract(
      StatusDataSchema,
      {
        cards: {
          worker: {
            status: workerStatus,
            lastUpdatedAt: workerHealth?.now ?? workerSystemStatus?.lastUpdatedAt.toISOString() ?? null,
            lastEventAt: workerHealth?.lastHeartbeatAt ?? null
          },
          database: {
            status: databaseReachable ? 'OK' : 'DOWN',
            lastUpdatedAt: new Date().toISOString(),
            latencyMs: databaseLatencyMs,
            sizeBytes: databaseSizeBytes
          },
          redis: {
            status: redisStatus,
            lastUpdatedAt: redisSystemStatus?.lastUpdatedAt.toISOString() ?? null
          },
          websocket: {
            status: workerHealth ? (websocketConnected ? 'OK' : 'DOWN') : 'UNKNOWN',
            lastUpdatedAt:
              typeof chainDetails.lastMessageAtMs === 'number'
                ? new Date(chainDetails.lastMessageAtMs).toISOString()
                : workerHealth?.now ?? null,
            connected: websocketConnected
          }
        },
        details: {
          worker: {
            loops: {
              tradeDetectionRunning: asBoolean(chainDetails.connected),
              reconcileRunning: asBoolean(reconcileDetails.running),
              executionRunning: asBoolean(executionDetails.running)
            },
            controls: {
              envCopySystemEnabled: parseEnvBoolean(process.env.COPY_SYSTEM_ENABLED, false),
              profileCopySystemEnabled,
              panicModeEnabled: parseEnvBoolean(process.env.PANIC_MODE, false),
              dryRunModeEnabled: parseEnvBoolean(process.env.DRY_RUN_MODE, false)
            },
            reconcileIntervalSeconds,
            nextReconcileInSeconds,
            lastReconcileSummary: reconcileDetails,
            errorCounts: {
              last15m: errorCount15m,
              last1h: errorCount1h,
              last24h: errorCount24h
            },
            lastError: lastError
              ? {
                  message: lastError.message,
                  code: lastError.code ?? null,
                  component: lastError.component,
                  severity: lastError.severity,
                  occurredAt: lastError.occurredAt.toISOString(),
                  stack: lastError.stack ? truncate(lastError.stack, 2_000) : null
                }
              : null,
            retryBackoff: {
              totalBackoffSkips: toNumber(executionDetails.totalBackoffSkips),
              retryingAttempts: retryState.retryingAttempts,
              retryDueNow: retryState.retryDueNow,
              nextRetryAt: retryState.nextRetryAt,
              nextRetryInSeconds: retryState.nextRetryInSeconds,
              retryingByTokenTop: retryState.retryingByTokenTop
            },
            orderAttemptOutcomes1h: toCountRecord(orderOutcomes1hRows, 'status'),
            orderAttemptOutcomes24h: toCountRecord(orderOutcomes24hRows, 'status'),
            skipReasons1h: toCountRecord(skipReasons1hRows, 'reason'),
            skipReasons24h: toCountRecord(skipReasons24hRows, 'reason')
          },
          database: {
            latencyMs: databaseLatencyMs,
            sizeBytes: databaseSizeBytes,
            migration: {
              latestMigration: latestMigration?.migrationName ?? null,
              latestAppliedAt: latestMigration?.finishedAt?.toISOString() ?? null
            },
            tableCounts: {
              leaders: exactCounts[0],
              leaderPositionSnapshots: estimatedSnapshotCounts.leaderPositionSnapshots,
              followerPositionSnapshots: estimatedSnapshotCounts.followerPositionSnapshots,
              copyOrders: exactCounts[1],
              copyAttempts: exactCounts[2],
              errors: exactCounts[3]
            }
          },
          redis: {
            details: redisDetails,
            queueCounts,
            oldestPendingJobAgeSeconds,
            memoryUsedBytes,
            evictionWarnings
          },
          websocket: {
            activeSubscriptionCount: asNullableInt(chainDetails.activeSubscriptionCount),
            messageRatePerMin,
            connectionUptimeSeconds,
            reconnectCount: asNullableInt(chainDetails.reconnectCount),
            lastDisconnectReason: asNullableString(chainDetails.lastError),
            lastTriggerLagMs: asNullableNumber(chainDetails.lastTriggerLagMs),
            lastWsLagMs: asNullableNumber(chainDetails.lastWsLagMs),
            lastDetectLagMs: asNullableNumber(chainDetails.lastDetectLagMs),
            wsBackedTokenCount: asNullableInt(marketFreshness.wsBackedTokenCount),
            restBackedTokenCount: asNullableInt(marketFreshness.restBackedTokenCount),
            fallbackUsage1h,
            fallbackUsage24h
          }
        }
      },
      {
        cacheSeconds: 5
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'STATUS_CONTRACT_FAILED', 'Status response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'STATUS_FAILED', toErrorMessage(error))
  }
}

async function fetchLatestMigration(): Promise<{ migrationName: string; finishedAt: Date | null } | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null }>>(
      Prisma.sql`SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at DESC NULLS LAST LIMIT 1`
    )
    const row = rows[0]
    if (!row) {
      return null
    }
    return {
      migrationName: row.migration_name,
      finishedAt: row.finished_at
    }
  } catch {
    return null
  }
}

async function fetchEstimatedSnapshotCounts(): Promise<{
  leaderPositionSnapshots: number
  followerPositionSnapshots: number
}> {
  try {
    const rows = await prisma.$queryRaw<Array<{ relname: string; estimated_rows: bigint | number }>>(
      Prisma.sql`
        SELECT relname, GREATEST(n_live_tup, 0)::bigint AS estimated_rows
        FROM pg_stat_user_tables
        WHERE relname IN ('LeaderPositionSnapshot', 'FollowerPositionSnapshot')
      `
    )

    const counts = new Map(rows.map((row) => [row.relname, Number(row.estimated_rows)]))

    return {
      leaderPositionSnapshots: counts.get('LeaderPositionSnapshot') ?? 0,
      followerPositionSnapshots: counts.get('FollowerPositionSnapshot') ?? 0
    }
  } catch {
    const [leaderPositionSnapshots, followerPositionSnapshots] = await Promise.all([
      prisma.leaderPositionSnapshot.count(),
      prisma.followerPositionSnapshot.count()
    ])

    return {
      leaderPositionSnapshots,
      followerPositionSnapshots
    }
  }
}

async function fetchDatabaseSizeBytes(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ size_bytes: bigint | number | string }>>(
      Prisma.sql`SELECT pg_database_size(current_database()) AS size_bytes`
    )
    const size = rows[0]?.size_bytes
    if (typeof size === 'bigint') {
      return Number(size)
    }
    if (typeof size === 'number') {
      return Number.isFinite(size) ? size : null
    }
    if (typeof size === 'string') {
      const parsed = Number(size)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  } catch {
    return null
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  return null
}

function asNullableInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return Math.trunc(value)
}

function asNullableString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  return null
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  return value
}

function asNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const output: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      output[key] = entry
    }
  }
  return output
}

function mapSystemStatus(value: unknown): z.infer<typeof HealthStatusSchema> {
  if (value === 'OK') {
    return 'OK'
  }
  if (value === 'DOWN') {
    return 'DOWN'
  }
  return 'UNKNOWN'
}

function toPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.trunc(parsed)
}

function parseEnvBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback
  }
  const normalized = raw.toLowerCase()
  if (normalized === 'true') {
    return true
  }
  if (normalized === 'false') {
    return false
  }
  return fallback
}

function computeRetryState(
  rows: Array<{ tokenId: string; retries: number; attemptedAt: Date | null }>,
  nowMs: number,
  backoffBaseMs: number,
  backoffMaxMs: number
): {
  retryingAttempts: number
  retryDueNow: number
  nextRetryAt: string | null
  nextRetryInSeconds: number | null
  retryingByTokenTop: Array<{ tokenId: string; count: number }>
} {
  let retryDueNow = 0
  let nextDueAtMs: number | null = null
  const byToken = new Map<string, number>()

  for (const row of rows) {
    const attemptAtMs = row.attemptedAt?.getTime() ?? nowMs
    const dueAtMs = attemptAtMs + computeBackoffMs(row.retries, backoffBaseMs, backoffMaxMs)
    if (dueAtMs <= nowMs) {
      retryDueNow += 1
    }
    if (nextDueAtMs === null || dueAtMs < nextDueAtMs) {
      nextDueAtMs = dueAtMs
    }

    byToken.set(row.tokenId, (byToken.get(row.tokenId) ?? 0) + 1)
  }

  const retryingByTokenTop = [...byToken.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tokenId, count]) => ({ tokenId, count }))

  return {
    retryingAttempts: rows.length,
    retryDueNow,
    nextRetryAt: nextDueAtMs ? new Date(nextDueAtMs).toISOString() : null,
    nextRetryInSeconds: nextDueAtMs ? Math.max(0, Math.trunc((nextDueAtMs - nowMs) / 1_000)) : null,
    retryingByTokenTop
  }
}

function computeBackoffMs(retries: number, baseMs: number, maxMs: number): number {
  if (!Number.isFinite(retries) || retries <= 0) {
    return 0
  }
  const exponent = Math.max(0, Math.trunc(retries) - 1)
  const raw = baseMs * 2 ** exponent
  return Math.min(raw, maxMs)
}

function toCountRecord<TField extends string>(
  rows: Array<{ [key: string]: unknown; _count: { _all: number } }>,
  field: TField
): Record<string, number> {
  const output: Record<string, number> = {}
  for (const row of rows) {
    const key = row[field]
    if (typeof key !== 'string' || key.length === 0) {
      continue
    }
    output[key] = row._count._all
  }
  return output
}

function readCopySystemEnabled(rawConfig: unknown): boolean | null {
  const config = asObject(rawConfig)
  const masterSwitches = asObject(config.masterSwitches)
  const value = masterSwitches.copySystemEnabled
  if (typeof value === 'boolean') {
    return value
  }
  return null
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value
  }
  return `${value.slice(0, maxLen)}…`
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
