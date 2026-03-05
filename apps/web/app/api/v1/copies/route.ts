import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, paginationMeta, parsePagination, toIso, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'
import { resolveTokenDisplayMetadata } from '@/lib/server/token-display-metadata'
import { fetchWorkerHealth, fetchWorkerMarketBooks } from '@/lib/server/worker-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SectionSchema = z.enum(['open', 'attempting', 'executions', 'skipped'])
const SpreadStateSchema = z.enum(['LIVE', 'STALE', 'UNAVAILABLE'])

const CopiesDataSchema = z.object({
  section: SectionSchema,
  summary: z.object({
    clobAuthentication: z.object({
      status: z.enum(['OK', 'ERROR', 'UNKNOWN']),
      lastCheckedAt: z.string().nullable()
    }),
    userChannel: z.object({
      status: z.enum(['CONNECTED', 'DISCONNECTED', 'UNKNOWN']),
      lastMessageAt: z.string().nullable()
    }),
    lastReconcileAt: z.string().nullable(),
    timeSinceLastReconcileSeconds: z.number().int().nonnegative().nullable(),
    pendingBelowMinCount: z.number().int().nonnegative(),
    openOrdersCount: z.number().int().nonnegative()
  }),
  open: z
    .object({
      items: z.array(
        z.object({
          id: z.string(),
          createdAt: z.string(),
          leaderId: z.string().nullable(),
          leaderName: z.string().nullable(),
          leaderNames: z.array(z.string()),
          tokenId: z.string(),
          marketId: z.string().nullable(),
          marketLabel: z.string().nullable(),
          marketSlug: z.string().nullable(),
          outcome: z.string().nullable(),
          side: z.enum(['BUY', 'SELL']),
          pendingNotionalUsd: z.number(),
          minExecutableNotionalUsd: z.number(),
          minOrderSizeShares: z.number().nullable(),
          pendingShares: z.number(),
          status: z.enum(['PENDING', 'ELIGIBLE', 'BLOCKED', 'EXPIRED', 'CONVERTED']),
          blockReason: z.string().nullable(),
          expiresAt: z.string().nullable()
        })
      ),
      pagination: z.object({
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().positive()
      })
    })
    .nullable(),
  attempting: z
    .object({
      items: z.array(
        z.object({
          id: z.string(),
          createdAt: z.string(),
          attemptedAt: z.string().nullable(),
          leaderId: z.string().nullable(),
          leaderName: z.string().nullable(),
          leaderNames: z.array(z.string()),
          tokenId: z.string(),
          marketId: z.string().nullable(),
          marketLabel: z.string().nullable(),
          marketSlug: z.string().nullable(),
          outcome: z.string().nullable(),
          side: z.enum(['BUY', 'SELL']),
          accumulatedDeltaNotionalUsd: z.number(),
          accumulatedDeltaShares: z.number(),
          spreadState: SpreadStateSchema,
          spreadAgeMs: z.number().int().nonnegative().nullable(),
          currentSpreadUsd: z.number().nullable(),
          retries: z.number().int().nonnegative(),
          maxRetries: z.number().int().nonnegative(),
          status: z.enum(['PENDING', 'RETRYING', 'EXECUTING']),
          reason: z.string().nullable(),
          message: z.string().nullable(),
          lastOrderStatus: z.enum(['PLACED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED', 'RETRYING']).nullable(),
          lastOrderError: z.string().nullable(),
          pendingStatus: z.enum(['PENDING', 'ELIGIBLE', 'BLOCKED', 'EXPIRED', 'CONVERTED']).nullable(),
          pendingBlockReason: z.string().nullable()
        })
      ),
      pagination: z.object({
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().positive()
      })
    })
    .nullable(),
  executions: z
    .object({
      items: z.array(
        z.object({
          id: z.string(),
          copyAttemptId: z.string().nullable(),
          attemptedAt: z.string(),
          leaderId: z.string().nullable(),
          leaderName: z.string().nullable(),
          tokenId: z.string(),
          marketId: z.string().nullable(),
          marketLabel: z.string().nullable(),
          marketSlug: z.string().nullable(),
          outcome: z.string().nullable(),
          side: z.enum(['BUY', 'SELL']),
          intendedNotionalUsd: z.number(),
          intendedShares: z.number(),
          priceLimit: z.number(),
          externalOrderId: z.string().nullable(),
          feePaidUsd: z.number(),
          status: z.enum(['PLACED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED', 'RETRYING']),
          reason: z.string().nullable(),
          errorMessage: z.string().nullable(),
          accumulatedDeltaNotionalUsd: z.number().nullable(),
          retryCount: z.number().int().nonnegative(),
          lastRetryAt: z.string().nullable()
        })
      ),
      pagination: z.object({
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().positive()
      })
    })
    .nullable(),
  skipped: z
    .object({
      mode: z.enum(['groups', 'details']),
      groups: z
        .array(
          z.object({
            tokenId: z.string(),
            marketId: z.string().nullable(),
            marketLabel: z.string().nullable(),
            marketSlug: z.string().nullable(),
            outcome: z.string().nullable(),
            skipCount: z.number().int().nonnegative(),
            lastSkippedAt: z.string(),
            topReason: z.string().nullable()
          })
        )
        .nullable(),
      details: z
        .array(
          z.object({
            id: z.string(),
            createdAt: z.string(),
            attemptedAt: z.string().nullable(),
            leaderId: z.string().nullable(),
            leaderName: z.string().nullable(),
            tokenId: z.string(),
            marketId: z.string().nullable(),
            marketLabel: z.string().nullable(),
            marketSlug: z.string().nullable(),
            outcome: z.string().nullable(),
            side: z.enum(['BUY', 'SELL']),
            reason: z.string().nullable(),
            accumulatedDeltaNotionalUsd: z.number()
          })
        )
        .nullable(),
      pagination: z.object({
        page: z.number().int().positive(),
        pageSize: z.number().int().positive(),
        total: z.number().int().nonnegative(),
        totalPages: z.number().int().positive()
      })
    })
    .nullable()
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)
    const section = SectionSchema.safeParse(url.searchParams.get('section')).success
      ? (url.searchParams.get('section') as z.infer<typeof SectionSchema>)
      : 'open'
    const tokenId = url.searchParams.get('tokenId')?.trim()

    const skippedWhere: Prisma.CopyAttemptWhereInput = {
      OR: [
        {
          decision: 'SKIPPED'
        },
        {
          status: {
            in: ['EXPIRED', 'FAILED']
          }
        }
      ]
    }

    const [pendingBelowMinCount, openOrdersCount, workerStatusRow, workerHealth] = await Promise.all([
      prisma.pendingDelta.count({
        where: {
          status: {
            in: ['PENDING', 'BLOCKED']
          },
          OR: [
            {
              blockReason: 'MIN_NOTIONAL'
            },
            {
              pendingDeltaNotionalUsd: {
                lt: '1'
              }
            }
          ]
        }
      }),
      prisma.copyOrder.count({
        where: {
          status: {
            in: ['PLACED', 'PARTIALLY_FILLED', 'RETRYING']
          },
          externalOrderId: {
            not: null
          }
        }
      }),
      prisma.systemStatus.findUnique({
        where: {
          component: 'WORKER'
        },
        select: {
          details: true
        }
      }),
      fetchWorkerHealth()
    ])

    const systemReconcile = asObject(asObject(workerStatusRow?.details).reconcile)
    const lastReconcileAt =
      workerHealth && typeof workerHealth.reconcile?.lastSuccessAtMs === 'number'
        ? new Date(workerHealth.reconcile.lastSuccessAtMs).toISOString()
        : (typeof systemReconcile.cycleAt === 'string' ? systemReconcile.cycleAt : null)

    const timeSinceLastReconcileSeconds =
      lastReconcileAt !== null ? Math.max(0, Math.trunc((Date.now() - new Date(lastReconcileAt).getTime()) / 1_000)) : null

    const executionStatus = asObject(workerHealth?.execution)
    const userChannelStatus = asObject(workerHealth?.userChannel)
    const clobAuthStatus = workerHealth
      ? executionStatus.lastError
        ? 'ERROR'
        : 'OK'
      : 'UNKNOWN'
    const userChannelConnection =
      typeof userChannelStatus.connected === 'boolean'
        ? userChannelStatus.connected
          ? 'CONNECTED'
          : 'DISCONNECTED'
        : 'UNKNOWN'
    const userChannelLastMessageAt =
      typeof userChannelStatus.lastMessageAtMs === 'number'
        ? new Date(userChannelStatus.lastMessageAtMs).toISOString()
        : null

    const summary = {
      clobAuthentication: {
        status: clobAuthStatus as 'OK' | 'ERROR' | 'UNKNOWN',
        lastCheckedAt: workerHealth?.now ?? null
      },
      userChannel: {
        status: userChannelConnection as 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN',
        lastMessageAt: userChannelLastMessageAt
      },
      lastReconcileAt,
      timeSinceLastReconcileSeconds,
      pendingBelowMinCount,
      openOrdersCount
    }

    if (section === 'open') {
      const openWhere: Prisma.PendingDeltaWhereInput = {
        status: {
          in: ['PENDING', 'BLOCKED', 'ELIGIBLE']
        },
        copyAttempts: {
          none: {
            status: {
              in: ['PENDING', 'RETRYING', 'EXECUTING']
            }
          }
        },
        OR: [
          {
            expiresAt: null
          },
          {
            expiresAt: {
              gt: new Date()
            }
          }
        ],
        ...(tokenId ? { tokenId } : {})
      }

      const [total, rows] = await Promise.all([
        prisma.pendingDelta.count({
          where: openWhere
        }),
        prisma.pendingDelta.findMany({
          where: openWhere,
          orderBy: {
            createdAt: 'desc'
          },
          skip: pagination.skip,
          take: pagination.pageSize,
          select: {
            id: true,
            createdAt: true,
            leaderId: true,
            tokenId: true,
            marketId: true,
            side: true,
            pendingDeltaNotionalUsd: true,
            minExecutableNotionalUsd: true,
            pendingDeltaShares: true,
            status: true,
            blockReason: true,
            metadata: true,
            expiresAt: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        })
      ])
      const tokenMetadata = await resolveTokenDisplayMetadata(rows.map((row) => row.tokenId))
      const leaderNamesByRow = await resolveOpenLeaderNames(rows)

      return jsonContract(
        CopiesDataSchema,
        {
          section,
          summary,
          open: {
            items: rows.map((row) => ({
              id: row.id,
              createdAt: row.createdAt.toISOString(),
              leaderId: row.leaderId,
              leaderName: leaderNamesByRow.get(row.id)?.[0] ?? row.leader?.name ?? null,
              leaderNames: leaderNamesByRow.get(row.id) ?? [],
              tokenId: row.tokenId,
              marketId: row.marketId ?? tokenMetadata.get(row.tokenId)?.marketId ?? null,
              marketLabel: tokenMetadata.get(row.tokenId)?.marketLabel ?? null,
              marketSlug: tokenMetadata.get(row.tokenId)?.marketSlug ?? null,
              outcome: tokenMetadata.get(row.tokenId)?.outcome ?? null,
              side: row.side,
              pendingNotionalUsd: toNumber(row.pendingDeltaNotionalUsd),
              minExecutableNotionalUsd: toNumber(row.minExecutableNotionalUsd),
              minOrderSizeShares: extractMinOrderSizeShares(row.metadata),
              pendingShares: toNumber(row.pendingDeltaShares),
              status: row.status,
              blockReason: row.blockReason,
              expiresAt: toIso(row.expiresAt)
            })),
            pagination: paginationMeta(pagination, total)
          },
          attempting: null,
          executions: null,
          skipped: null
        },
        {
          cacheSeconds: 5
        }
      )
    }

    if (section === 'attempting') {
      const attemptingWhere: Prisma.CopyAttemptWhereInput = {
        status: {
          in: ['PENDING', 'RETRYING', 'EXECUTING']
        },
        decision: 'PENDING',
        ...(tokenId ? { tokenId } : {})
      }

      const [total, rows] = await Promise.all([
        prisma.copyAttempt.count({
          where: attemptingWhere
        }),
        prisma.copyAttempt.findMany({
          where: attemptingWhere,
          orderBy: {
            createdAt: 'desc'
          },
          skip: pagination.skip,
          take: pagination.pageSize,
          select: {
            id: true,
            createdAt: true,
            attemptedAt: true,
            leaderId: true,
            tokenId: true,
            marketId: true,
            side: true,
            accumulatedDeltaNotionalUsd: true,
            accumulatedDeltaShares: true,
            retries: true,
            maxRetries: true,
            status: true,
            reason: true,
            errorPayload: true,
            leader: {
              select: {
                name: true
              }
            },
            pendingDelta: {
              select: {
                status: true,
                blockReason: true,
                pendingDeltaNotionalUsd: true,
                pendingDeltaShares: true,
                metadata: true
              }
            },
            copyOrders: {
              orderBy: {
                attemptedAt: 'desc'
              },
              take: 1,
              select: {
                status: true,
                errorMessage: true
              }
            }
          }
        })
      ])

      const tokenMetadata = await resolveTokenDisplayMetadata(rows.map((row) => row.tokenId))
      const spreadByToken = await resolveCurrentSpreadsByToken(rows.map((row) => row.tokenId))
      const leaderNamesByRow = await resolveOpenLeaderNames(
        rows.map((row) => ({
          id: row.id,
          leaderId: row.leaderId,
          leader: row.leader,
          metadata: row.pendingDelta?.metadata
        }))
      )

      return jsonContract(
        CopiesDataSchema,
        {
          section,
          summary,
          open: null,
          attempting: {
            items: rows.map((row) => {
              const latestOrder = row.copyOrders[0] ?? null
              const spreadInfo = spreadByToken.get(row.tokenId) ?? {
                spreadState: 'UNAVAILABLE' as const,
                spreadAgeMs: null,
                currentSpreadUsd: null
              }
              const pendingNotionalUsd =
                row.pendingDelta?.pendingDeltaNotionalUsd !== null && row.pendingDelta?.pendingDeltaNotionalUsd !== undefined
                  ? toNumber(row.pendingDelta.pendingDeltaNotionalUsd)
                  : null
              const pendingShares =
                row.pendingDelta?.pendingDeltaShares !== null && row.pendingDelta?.pendingDeltaShares !== undefined
                  ? toNumber(row.pendingDelta.pendingDeltaShares)
                  : null
              const attemptNotionalUsd =
                row.accumulatedDeltaNotionalUsd !== null && row.accumulatedDeltaNotionalUsd !== undefined
                  ? toNumber(row.accumulatedDeltaNotionalUsd)
                  : null
              const attemptShares =
                row.accumulatedDeltaShares !== null && row.accumulatedDeltaShares !== undefined ? toNumber(row.accumulatedDeltaShares) : null
              return {
                id: row.id,
                createdAt: row.createdAt.toISOString(),
                attemptedAt: toIso(row.attemptedAt),
                leaderId: row.leaderId,
                leaderName: leaderNamesByRow.get(row.id)?.[0] ?? row.leader?.name ?? null,
                leaderNames: leaderNamesByRow.get(row.id) ?? [],
                tokenId: row.tokenId,
                marketId: row.marketId ?? tokenMetadata.get(row.tokenId)?.marketId ?? null,
                marketLabel: tokenMetadata.get(row.tokenId)?.marketLabel ?? null,
                marketSlug: tokenMetadata.get(row.tokenId)?.marketSlug ?? null,
                outcome: tokenMetadata.get(row.tokenId)?.outcome ?? null,
                side: row.side,
                accumulatedDeltaNotionalUsd: pendingNotionalUsd ?? attemptNotionalUsd ?? 0,
                accumulatedDeltaShares: pendingShares ?? attemptShares ?? 0,
                spreadState: spreadInfo.spreadState,
                spreadAgeMs: spreadInfo.spreadAgeMs,
                currentSpreadUsd: spreadInfo.currentSpreadUsd,
                retries: row.retries,
                maxRetries: row.maxRetries,
                status: toAttemptingStatus(row.status),
                reason: row.reason,
                message: extractAttemptMessage(row.errorPayload, row.reason),
                lastOrderStatus: latestOrder?.status ?? null,
                lastOrderError: normalizeOrderErrorMessage(latestOrder?.errorMessage),
                pendingStatus: row.pendingDelta?.status ?? null,
                pendingBlockReason: row.pendingDelta?.blockReason ?? null
              }
            }),
            pagination: paginationMeta(pagination, total)
          },
          executions: null,
          skipped: null
        },
        {
          cacheSeconds: 5
        }
      )
    }

    if (section === 'executions') {
      const executionWhere: Prisma.CopyOrderWhereInput = {
        externalOrderId: {
          not: null
        },
        ...(tokenId ? { tokenId } : {})
      }

      const [total, rows] = await Promise.all([
        prisma.copyOrder.count({
          where: executionWhere
        }),
        prisma.copyOrder.findMany({
          where: executionWhere,
          orderBy: {
            attemptedAt: 'desc'
          },
          skip: pagination.skip,
          take: pagination.pageSize,
          select: {
            id: true,
            copyAttemptId: true,
            attemptedAt: true,
            tokenId: true,
            marketId: true,
            side: true,
            intendedNotionalUsd: true,
            intendedShares: true,
            priceLimit: true,
            externalOrderId: true,
            feePaidUsd: true,
            status: true,
            errorMessage: true,
            retryCount: true,
            lastRetryAt: true,
            copyAttempt: {
              select: {
                reason: true,
                leaderId: true,
                accumulatedDeltaNotionalUsd: true,
                leader: {
                  select: {
                    name: true
                  }
                }
              }
            }
          }
        })
      ])
      const tokenMetadata = await resolveTokenDisplayMetadata(rows.map((row) => row.tokenId))

      return jsonContract(
        CopiesDataSchema,
        {
          section,
          summary,
          open: null,
          attempting: null,
          executions: {
            items: rows.map((row) => ({
              id: row.id,
              copyAttemptId: row.copyAttemptId,
              attemptedAt: row.attemptedAt.toISOString(),
              leaderId: row.copyAttempt?.leaderId ?? null,
              leaderName: row.copyAttempt?.leader?.name ?? null,
              tokenId: row.tokenId,
              marketId: row.marketId ?? tokenMetadata.get(row.tokenId)?.marketId ?? null,
              marketLabel: tokenMetadata.get(row.tokenId)?.marketLabel ?? null,
              marketSlug: tokenMetadata.get(row.tokenId)?.marketSlug ?? null,
              outcome: tokenMetadata.get(row.tokenId)?.outcome ?? null,
              side: row.side,
              intendedNotionalUsd: toNumber(row.intendedNotionalUsd),
              intendedShares: toNumber(row.intendedShares),
              priceLimit: toNumber(row.priceLimit),
              externalOrderId: row.externalOrderId,
              feePaidUsd: toNumber(row.feePaidUsd),
              status: row.status,
              reason: row.copyAttempt?.reason ?? null,
              errorMessage: normalizeOrderErrorMessage(row.errorMessage),
              accumulatedDeltaNotionalUsd:
                row.copyAttempt?.accumulatedDeltaNotionalUsd !== null &&
                row.copyAttempt?.accumulatedDeltaNotionalUsd !== undefined
                  ? toNumber(row.copyAttempt.accumulatedDeltaNotionalUsd)
                  : null,
              retryCount: row.retryCount,
              lastRetryAt: toIso(row.lastRetryAt)
            })),
            pagination: paginationMeta(pagination, total)
          },
          skipped: null
        },
        {
          cacheSeconds: 5
        }
      )
    }

    if (tokenId) {
      const [total, details] = await Promise.all([
        prisma.copyAttempt.count({
          where: {
            ...skippedWhere,
            tokenId
          }
        }),
        prisma.copyAttempt.findMany({
          where: {
            ...skippedWhere,
            tokenId
          },
          orderBy: {
            createdAt: 'desc'
          },
          skip: pagination.skip,
          take: pagination.pageSize,
          select: {
            id: true,
            createdAt: true,
            attemptedAt: true,
            leaderId: true,
            tokenId: true,
            marketId: true,
            side: true,
            reason: true,
            accumulatedDeltaNotionalUsd: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        })
      ])
      const tokenMetadata = await resolveTokenDisplayMetadata(details.map((row) => row.tokenId))

      return jsonContract(
        CopiesDataSchema,
        {
          section,
          summary,
          open: null,
          attempting: null,
          executions: null,
          skipped: {
            mode: 'details',
            groups: null,
            details: details.map((row) => ({
              id: row.id,
              createdAt: row.createdAt.toISOString(),
              attemptedAt: toIso(row.attemptedAt),
              leaderId: row.leaderId,
              leaderName: row.leader?.name ?? null,
              tokenId: row.tokenId,
              marketId: row.marketId ?? tokenMetadata.get(row.tokenId)?.marketId ?? null,
              marketLabel: tokenMetadata.get(row.tokenId)?.marketLabel ?? null,
              marketSlug: tokenMetadata.get(row.tokenId)?.marketSlug ?? null,
              outcome: tokenMetadata.get(row.tokenId)?.outcome ?? null,
              side: row.side,
              reason: row.reason,
              accumulatedDeltaNotionalUsd: toNumber(row.accumulatedDeltaNotionalUsd)
            })),
            pagination: paginationMeta(pagination, total)
          }
        },
        {
          cacheSeconds: 5
        }
      )
    }

    const grouped = await prisma.copyAttempt.groupBy({
      by: ['tokenId', 'marketId'],
      where: skippedWhere,
      _count: {
        _all: true
      },
      _max: {
        createdAt: true
      }
    })

    const reasonCounts = await prisma.copyAttempt.groupBy({
      by: ['tokenId', 'marketId', 'reason'],
      where: skippedWhere,
      _count: {
        _all: true
      }
    })

    const sortedGroups = [...grouped].sort((a, b) => {
      const left = a._max.createdAt ? a._max.createdAt.getTime() : 0
      const right = b._max.createdAt ? b._max.createdAt.getTime() : 0
      return right - left
    })

    const total = sortedGroups.length
    const paged = sortedGroups.slice(pagination.skip, pagination.skip + pagination.pageSize)
    const tokenMetadata = await resolveTokenDisplayMetadata(paged.map((row) => row.tokenId))

    const topReasonByKey = new Map<string, string | null>()
    for (const group of reasonCounts) {
      const key = `${group.tokenId}::${group.marketId ?? ''}`
      const current = topReasonByKey.get(key)
      if (!current) {
        topReasonByKey.set(key, group.reason)
        continue
      }

      const currentCount = reasonCounts.find(
        (row) => row.tokenId === group.tokenId && row.marketId === group.marketId && row.reason === current
      )?._count._all
      if ((currentCount ?? 0) < group._count._all) {
        topReasonByKey.set(key, group.reason)
      }
    }

    return jsonContract(
      CopiesDataSchema,
      {
        section,
        summary,
        open: null,
        attempting: null,
        executions: null,
        skipped: {
          mode: 'groups',
          groups: paged.map((row) => ({
            tokenId: row.tokenId,
            marketId: row.marketId ?? tokenMetadata.get(row.tokenId)?.marketId ?? null,
            marketLabel: tokenMetadata.get(row.tokenId)?.marketLabel ?? null,
            marketSlug: tokenMetadata.get(row.tokenId)?.marketSlug ?? null,
            outcome: tokenMetadata.get(row.tokenId)?.outcome ?? null,
            skipCount: row._count._all,
            lastSkippedAt: (row._max.createdAt ?? new Date()).toISOString(),
            topReason: topReasonByKey.get(`${row.tokenId}::${row.marketId ?? ''}`) ?? null
          })),
          details: null,
          pagination: paginationMeta(pagination, total)
        }
      },
      {
        cacheSeconds: 5
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'COPIES_CONTRACT_FAILED', 'Copies response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'COPIES_FAILED', toErrorMessage(error))
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

interface OpenRowLeaderMetaInput {
  id: string
  leaderId: string | null
  leader?: { name: string } | null
  metadata: unknown
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
}

async function resolveOpenLeaderNames(rows: OpenRowLeaderMetaInput[]): Promise<Map<string, string[]>> {
  const leaderIds = new Set<string>()
  const contributorIdsByRow = new Map<string, string[]>()

  for (const row of rows) {
    if (row.leaderId) {
      leaderIds.add(row.leaderId)
    }
    const contributorIds = extractContributorLeaderIds(row.metadata)
    contributorIdsByRow.set(row.id, contributorIds)
    for (const leaderId of contributorIds) {
      leaderIds.add(leaderId)
    }
  }

  if (leaderIds.size === 0) {
    return new Map()
  }

  const leaders = await prisma.leader.findMany({
    where: {
      id: {
        in: [...leaderIds]
      }
    },
    select: {
      id: true,
      name: true
    }
  })

  const leaderNameById = new Map(leaders.map((leader) => [leader.id, leader.name]))
  const result = new Map<string, string[]>()

  for (const row of rows) {
    const contributorIds = contributorIdsByRow.get(row.id) ?? []
    const names = contributorIds
      .map((leaderId) => leaderNameById.get(leaderId))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)

    if (names.length > 0) {
      result.set(row.id, names)
      continue
    }

    if (row.leaderId && leaderNameById.has(row.leaderId)) {
      result.set(row.id, [leaderNameById.get(row.leaderId) as string])
      continue
    }

    if (row.leader?.name) {
      result.set(row.id, [row.leader.name])
    }
  }

  return result
}

function extractContributorLeaderIds(metadata: unknown): string[] {
  const root = asObject(metadata)
  const shares = asObject(root.leaderTargetShares)
  const entries: Array<{ leaderId: string; shares: number }> = []

  for (const [leaderId, value] of Object.entries(shares)) {
    const sharesValue = toNumber(value)
    if (!leaderId || sharesValue <= 0) {
      continue
    }
    entries.push({ leaderId, shares: sharesValue })
  }

  entries.sort((left, right) => right.shares - left.shares)
  return entries.map((entry) => entry.leaderId)
}

function extractMinOrderSizeShares(metadata: unknown): number | null {
  const root = asObject(metadata)
  const minOrderSize = toNumber(root.minOrderSize)
  return minOrderSize > 0 ? minOrderSize : null
}

async function resolveCurrentSpreadsByToken(
  tokenIds: string[]
): Promise<Map<string, { spreadState: 'LIVE' | 'STALE' | 'UNAVAILABLE'; spreadAgeMs: number | null; currentSpreadUsd: number | null }>> {
  const books = await fetchWorkerMarketBooks(tokenIds)
  if (!books || books.length === 0) {
    return new Map()
  }

  const now = Date.now()
  const spreads = new Map<
    string,
    { spreadState: 'LIVE' | 'STALE' | 'UNAVAILABLE'; spreadAgeMs: number | null; currentSpreadUsd: number | null }
  >()
  for (const book of books) {
    const spreadState =
      book.spreadState === 'LIVE' || book.spreadState === 'STALE' || book.spreadState === 'UNAVAILABLE'
        ? book.spreadState
        : 'UNAVAILABLE'
    const spreadAgeMs =
      typeof book.quoteUpdatedAtMs === 'number' && Number.isFinite(book.quoteUpdatedAtMs)
        ? Math.max(0, Math.trunc(now - book.quoteUpdatedAtMs))
        : null

    if (spreadState !== 'LIVE') {
      spreads.set(book.tokenId, {
        spreadState,
        spreadAgeMs,
        currentSpreadUsd: null
      })
      continue
    }

    const spreadValue =
      typeof book.spreadUsd === 'number' && Number.isFinite(book.spreadUsd) && book.spreadUsd >= 0
        ? book.spreadUsd
        : null

    if (spreadValue === null) {
      spreads.set(book.tokenId, {
        spreadState: 'UNAVAILABLE',
        spreadAgeMs,
        currentSpreadUsd: null
      })
      continue
    }

    spreads.set(book.tokenId, {
      spreadState: 'LIVE',
      spreadAgeMs,
      currentSpreadUsd: spreadValue
    })
  }

  return spreads
}

function extractAttemptMessage(payload: unknown, reason?: string | null): string | null {
  if (typeof payload === 'string') {
    return normalizeOrderErrorMessage(payload)
  }

  const root = asObject(payload)
  const direct =
    readString(root, 'message') ??
    readString(root, 'error') ??
    readString(root, 'detail') ??
    readString(root, 'reason') ??
    readString(root, 'cause')
  if (direct) {
    return normalizeOrderErrorMessage(direct)
  }

  const nestedError = asObject(root.error)
  const nested =
    readString(nestedError, 'message') ??
    readString(nestedError, 'detail') ??
    readString(nestedError, 'reason') ??
    readString(nestedError, 'cause')
  if (nested) {
    return normalizeOrderErrorMessage(nested)
  }

  return inferAttemptMessageFromContext(root, reason)
}

function inferAttemptMessageFromContext(payload: Record<string, unknown>, reason?: string | null): string | null {
  const stage = readString(payload, 'stage')
  if (reason === 'RATE_LIMIT' && stage === 'submit_order') {
    return 'not enough balance / allowance'
  }

  if (readNumber(payload, 'maxDailyNotionalTurnoverUsd') !== undefined) {
    return 'daily notional turnover cap exceeded'
  }

  if (readNumber(payload, 'maxHourlyNotionalTurnoverUsd') !== undefined) {
    return 'hourly notional turnover cap exceeded'
  }

  if (readNumber(payload, 'cooldownPerMarketSeconds') !== undefined) {
    return 'market cooldown is active'
  }

  return null
}

function normalizeOrderErrorMessage(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) {
    return null
  }

  const trimmed = errorMessage.trim()
  if (trimmed.length === 0) {
    return null
  }

  const withoutPrefix = trimmed.replace(/^CLOB order submit failed:\s*/i, '').replace(/^Error:\s*/i, '').trim()
  const extractedFromJson = extractMessageFromJsonBlob(withoutPrefix)
  if (extractedFromJson) {
    return extractedFromJson
  }

  const extractedByPattern = extractMessageWithPattern(withoutPrefix)
  if (extractedByPattern) {
    return extractedByPattern
  }

  return withoutPrefix
}

function extractMessageFromJsonBlob(blob: string): string | null {
  if (!(blob.startsWith('{') && blob.endsWith('}'))) {
    return null
  }

  try {
    const parsed = JSON.parse(blob)
    const message = extractAttemptMessage(parsed)
    if (message) {
      return message
    }
  } catch {
    return null
  }

  return null
}

function extractMessageWithPattern(text: string): string | null {
  const quotedMatches = [
    text.match(/"error"\s*:\s*"([^"]+)"/i),
    text.match(/'error'\s*:\s*'([^']+)'/i),
    text.match(/"message"\s*:\s*"([^"]+)"/i),
    text.match(/'message'\s*:\s*'([^']+)'/i)
  ]

  for (const match of quotedMatches) {
    const captured = match?.[1]?.trim()
    if (captured) {
      return captured
    }
  }

  return null
}

function toAttemptingStatus(value: string): 'PENDING' | 'RETRYING' | 'EXECUTING' {
  if (value === 'RETRYING') {
    return 'RETRYING'
  }
  if (value === 'EXECUTING') {
    return 'EXECUTING'
  }
  return 'PENDING'
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
