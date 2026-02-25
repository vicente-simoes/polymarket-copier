import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, paginationMeta, parsePagination, toIso, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'
import { fetchWorkerHealth } from '@/lib/server/worker-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SectionSchema = z.enum(['open', 'executions', 'skipped'])

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
          tokenId: z.string(),
          marketId: z.string().nullable(),
          outcome: z.string().nullable(),
          side: z.enum(['BUY', 'SELL']),
          pendingNotionalUsd: z.number(),
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
          in: ['PENDING', 'BLOCKED']
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
        copyAttempts: {
          none: {
            status: {
              in: ['PENDING', 'RETRYING', 'EXECUTING']
            }
          }
        },
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
            pendingDeltaShares: true,
            status: true,
            blockReason: true,
            expiresAt: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        })
      ])
      const outcomeByToken = await resolveOutcomeByToken(rows.map((row) => row.tokenId))

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
              leaderName: row.leader?.name ?? null,
              tokenId: row.tokenId,
              marketId: row.marketId,
              outcome: outcomeByToken.get(row.tokenId) ?? null,
              side: row.side,
              pendingNotionalUsd: toNumber(row.pendingDeltaNotionalUsd),
              pendingShares: toNumber(row.pendingDeltaShares),
              status: row.status,
              blockReason: row.blockReason,
              expiresAt: toIso(row.expiresAt)
            })),
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
      const outcomeByToken = await resolveOutcomeByToken(rows.map((row) => row.tokenId))

      return jsonContract(
        CopiesDataSchema,
        {
          section,
          summary,
          open: null,
          executions: {
            items: rows.map((row) => ({
              id: row.id,
              copyAttemptId: row.copyAttemptId,
              attemptedAt: row.attemptedAt.toISOString(),
              leaderId: row.copyAttempt?.leaderId ?? null,
              leaderName: row.copyAttempt?.leader?.name ?? null,
              tokenId: row.tokenId,
              marketId: row.marketId,
              outcome: outcomeByToken.get(row.tokenId) ?? null,
              side: row.side,
              intendedNotionalUsd: toNumber(row.intendedNotionalUsd),
              intendedShares: toNumber(row.intendedShares),
              priceLimit: toNumber(row.priceLimit),
              externalOrderId: row.externalOrderId,
              feePaidUsd: toNumber(row.feePaidUsd),
              status: row.status,
              reason: row.copyAttempt?.reason ?? null,
              errorMessage: row.errorMessage,
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
      const outcomeByToken = await resolveOutcomeByToken(details.map((row) => row.tokenId))

      return jsonContract(
        CopiesDataSchema,
        {
          section,
          summary,
          open: null,
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
              marketId: row.marketId,
              outcome: outcomeByToken.get(row.tokenId) ?? null,
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
    const outcomeByToken = await resolveOutcomeByToken(paged.map((row) => row.tokenId))

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
        executions: null,
        skipped: {
          mode: 'groups',
          groups: paged.map((row) => ({
            tokenId: row.tokenId,
            marketId: row.marketId,
            outcome: outcomeByToken.get(row.tokenId) ?? null,
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

async function resolveOutcomeByToken(tokenIds: string[]): Promise<Map<string, string>> {
  const uniqueTokenIds = [...new Set(tokenIds.filter((value) => value.length > 0))]
  if (uniqueTokenIds.length === 0) {
    return new Map()
  }

  const rows = await prisma.leaderTradeEvent.findMany({
    where: {
      tokenId: {
        in: uniqueTokenIds
      },
      outcome: {
        not: null
      }
    },
    orderBy: {
      detectedAtMs: 'desc'
    },
    select: {
      tokenId: true,
      outcome: true
    }
  })

  const outcomeByToken = new Map<string, string>()
  for (const row of rows) {
    if (!row.outcome) {
      continue
    }
    if (!outcomeByToken.has(row.tokenId)) {
      outcomeByToken.set(row.tokenId, row.outcome)
    }
  }
  return outcomeByToken
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
