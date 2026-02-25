import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, parseNumber, toIso, toNumber } from '@/lib/server/api'
import { resolveSystemConfig } from '@/lib/server/config'
import { prisma } from '@/lib/server/db'
import { fetchWorkerHealth } from '@/lib/server/worker-health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const OverviewDataSchema = z.object({
  copyProfileId: z.string().nullable(),
  exposure: z.object({
    totalNotionalUsd: z.number(),
    byLeaderTop: z.array(
      z.object({
        leaderId: z.string(),
        leaderName: z.string(),
        exposureUsd: z.number()
      })
    ),
    trackingErrorUsd: z.number(),
    trackingErrorPct: z.number()
  }),
  pnl: z.object({
    totalPnlUsd: z.number(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    byMarketTop: z.array(
      z.object({
        tokenId: z.string(),
        marketId: z.string().nullable(),
        outcome: z.string().nullable(),
        pnlUsd: z.number()
      })
    ),
    byLeaderTop: z.array(
      z.object({
        leaderId: z.string(),
        leaderName: z.string(),
        realizedPnlUsd: z.number(),
        unrealizedPnlUsd: z.number(),
        totalPnlUsd: z.number()
      })
    )
  }),
  recentActivity: z.object({
    executions: z.array(
      z.object({
        id: z.string(),
        tokenId: z.string(),
        marketId: z.string().nullable(),
        side: z.enum(['BUY', 'SELL']),
        notionalUsd: z.number(),
        shares: z.number(),
        priceLimit: z.number(),
        status: z.enum(['PLACED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED', 'RETRYING']),
        attemptedAt: z.string(),
        leaderName: z.string().nullable()
      })
    ),
    skips: z.array(
      z.object({
        id: z.string(),
        tokenId: z.string(),
        marketId: z.string().nullable(),
        side: z.enum(['BUY', 'SELL']),
        reason: z.string().nullable(),
        createdAt: z.string(),
        leaderName: z.string().nullable()
      })
    )
  }),
  health: z.object({
    workerStatus: z.string(),
    copySystemEnabled: z.boolean(),
    dataFreshness: z.object({
      lastLeaderSyncAt: z.string().nullable(),
      lastFollowerSyncAt: z.string().nullable(),
      lastReconcileAt: z.string().nullable(),
      lastOnchainTriggerAt: z.string().nullable()
    }),
    connectivity: z.object({
      workerReachable: z.boolean(),
      polymarketApiReachable: z.boolean().nullable(),
      marketWsConnected: z.boolean().nullable(),
      userChannelConnected: z.boolean().nullable(),
      alchemyConnected: z.boolean().nullable()
    }),
    errors: z.object({
      lastError: z.string().nullable(),
      errorCount1h: z.number().int().nonnegative(),
      retryBackoffCount: z.number().int().nonnegative()
    })
  })
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const recentLimit = Math.max(1, Math.min(25, Math.trunc(parseNumber(url.searchParams.get('recentLimit'), 10))))
    const requestedProfileId = url.searchParams.get('copyProfileId')

    const copyProfile =
      requestedProfileId
        ? await prisma.copyProfile.findUnique({
            where: {
              id: requestedProfileId
            },
            select: {
              id: true,
              defaultRatio: true,
              config: true
            }
          })
        : await prisma.copyProfile.findFirst({
            where: {
              status: {
                in: ['ACTIVE', 'PAUSED']
              }
            },
            orderBy: {
              createdAt: 'asc'
            },
            select: {
              id: true,
              defaultRatio: true,
              config: true
            }
          })

    const config = resolveSystemConfig(copyProfile?.config, toNumber(copyProfile?.defaultRatio) || 0.01)

    const latestFollowerSnapshot =
      copyProfile &&
      (await prisma.followerPositionSnapshot.findFirst({
        where: {
          copyProfileId: copyProfile.id
        },
        orderBy: {
          snapshotAt: 'desc'
        },
        select: {
          snapshotAt: true
        }
      }))

    const [positions, pendingDeltas, leaderLedgers, leaderPnl, recentExecutions, recentSkips, latestLeaderSnapshot, lastTrigger, errorCount1h, lastError, workerStatusRow] =
      await Promise.all([
        copyProfile && latestFollowerSnapshot
          ? prisma.followerPositionSnapshot.findMany({
              where: {
                copyProfileId: copyProfile.id,
                snapshotAt: latestFollowerSnapshot.snapshotAt
              },
              select: {
                tokenId: true,
                marketId: true,
                outcome: true,
                shares: true,
                costBasisUsd: true,
                currentPrice: true,
                currentValueUsd: true
              }
            })
          : Promise.resolve([]),
        copyProfile
          ? prisma.pendingDelta.findMany({
              where: {
                copyProfileId: copyProfile.id,
                status: {
                  in: ['PENDING', 'BLOCKED', 'ELIGIBLE']
                }
              },
              select: {
                pendingDeltaNotionalUsd: true
              }
            })
          : Promise.resolve([]),
        prisma.leaderTokenLedger.findMany({
          select: {
            leaderId: true,
            tokenId: true,
            shares: true,
            costUsd: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        }),
        prisma.leaderPnlSummary.findMany({
          select: {
            leaderId: true,
            realizedPnlUsd: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        }),
        prisma.copyOrder.findMany({
          where: {
            status: {
              in: ['PLACED', 'PARTIALLY_FILLED', 'FILLED']
            }
          },
          orderBy: {
            attemptedAt: 'desc'
          },
          take: recentLimit,
          select: {
            id: true,
            tokenId: true,
            marketId: true,
            side: true,
            intendedNotionalUsd: true,
            intendedShares: true,
            priceLimit: true,
            status: true,
            attemptedAt: true,
            copyAttempt: {
              select: {
                leader: {
                  select: {
                    name: true
                  }
                }
              }
            }
          }
        }),
        prisma.copyAttempt.findMany({
          where: {
            OR: [
              {
                decision: 'SKIPPED'
              },
              {
                status: {
                  in: ['FAILED', 'EXPIRED']
                }
              }
            ]
          },
          orderBy: {
            createdAt: 'desc'
          },
          take: recentLimit,
          select: {
            id: true,
            tokenId: true,
            marketId: true,
            side: true,
            reason: true,
            createdAt: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        }),
        prisma.leaderPositionSnapshot.findFirst({
          orderBy: {
            snapshotAt: 'desc'
          },
          select: {
            snapshotAt: true
          }
        }),
        prisma.leaderTradeEvent.findFirst({
          where: {
            source: 'CHAIN'
          },
          orderBy: {
            detectedAtMs: 'desc'
          },
          select: {
            detectedAtMs: true
          }
        }),
        prisma.errorEvent.count({
          where: {
            severity: {
              in: ['ERROR', 'CRITICAL']
            },
            occurredAt: {
              gte: new Date(Date.now() - 3_600_000)
            }
          }
        }),
        prisma.errorEvent.findFirst({
          orderBy: {
            occurredAt: 'desc'
          },
          select: {
            message: true
          }
        }),
        prisma.systemStatus.findUnique({
          where: {
            component: 'WORKER'
          },
          select: {
            status: true,
            details: true
          }
        })
      ])

    const tokenPriceById = new Map<string, number>()
    let totalNotionalExposureUsd = 0
    let totalCurrentValueUsd = 0
    let unrealizedPnlUsd = 0

    const pnlByMarketRows: Array<{
      tokenId: string
      marketId: string | null
      outcome: string | null
      pnlUsd: number
    }> = []

    for (const row of positions) {
      const shares = toNumber(row.shares)
      const currentPrice = toNumber(row.currentPrice)
      const currentValue = toNumber(row.currentValueUsd) || shares * currentPrice
      const costBasis = toNumber(row.costBasisUsd)
      const markPrice = currentPrice || (shares !== 0 ? currentValue / shares : 0)

      tokenPriceById.set(row.tokenId, markPrice)
      totalNotionalExposureUsd += Math.abs(currentValue)
      totalCurrentValueUsd += currentValue

      const marketPnl = currentValue - costBasis
      unrealizedPnlUsd += marketPnl
      pnlByMarketRows.push({
        tokenId: row.tokenId,
        marketId: row.marketId,
        outcome: row.outcome,
        pnlUsd: marketPnl
      })
    }

    const trackingErrorUsd = pendingDeltas.reduce((sum, row) => sum + Math.abs(toNumber(row.pendingDeltaNotionalUsd)), 0)
    const trackingErrorPct = totalNotionalExposureUsd > 0 ? (trackingErrorUsd / totalNotionalExposureUsd) * 100 : 0

    const leaderPnlMap = new Map<
      string,
      {
        leaderName: string
        realizedPnlUsd: number
        unrealizedPnlUsd: number
        exposureUsd: number
      }
    >()

    for (const row of leaderPnl) {
      leaderPnlMap.set(row.leaderId, {
        leaderName: row.leader.name,
        realizedPnlUsd: toNumber(row.realizedPnlUsd),
        unrealizedPnlUsd: 0,
        exposureUsd: 0
      })
    }

    for (const row of leaderLedgers) {
      const tokenPrice = tokenPriceById.get(row.tokenId) ?? 0
      const shares = toNumber(row.shares)
      const costUsd = toNumber(row.costUsd)
      const markValueUsd = shares * tokenPrice

      const current = leaderPnlMap.get(row.leaderId) ?? {
        leaderName: row.leader.name,
        realizedPnlUsd: 0,
        unrealizedPnlUsd: 0,
        exposureUsd: 0
      }

      current.unrealizedPnlUsd += markValueUsd - costUsd
      current.exposureUsd += Math.abs(markValueUsd)
      leaderPnlMap.set(row.leaderId, current)
    }

    const byLeaderExposure = [...leaderPnlMap.entries()]
      .map(([leaderId, row]) => ({
        leaderId,
        leaderName: row.leaderName,
        exposureUsd: row.exposureUsd
      }))
      .sort((a, b) => b.exposureUsd - a.exposureUsd)
      .slice(0, 4)

    const byLeaderPnl = [...leaderPnlMap.entries()]
      .map(([leaderId, row]) => ({
        leaderId,
        leaderName: row.leaderName,
        realizedPnlUsd: row.realizedPnlUsd,
        unrealizedPnlUsd: row.unrealizedPnlUsd,
        totalPnlUsd: row.realizedPnlUsd + row.unrealizedPnlUsd
      }))
      .sort((a, b) => b.totalPnlUsd - a.totalPnlUsd)
      .slice(0, 5)

    const byMarketTop = pnlByMarketRows.sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5)
    const realizedPnlUsd = leaderPnl.reduce((sum, row) => sum + toNumber(row.realizedPnlUsd), 0)
    const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd

    const workerHealth = await fetchWorkerHealth()
    const systemDetails = asObject(workerStatusRow?.details)
    const reconcileDetails = asObject(systemDetails.reconcile)
    const lastReconcileAt =
      workerHealth && typeof workerHealth.reconcile?.lastSuccessAtMs === 'number'
        ? new Date(workerHealth.reconcile.lastSuccessAtMs).toISOString()
        : (typeof reconcileDetails.cycleAt === 'string' ? reconcileDetails.cycleAt : null)

    const lastFollowerSyncAt = toIso(latestFollowerSnapshot?.snapshotAt ?? null)
    const lastLeaderSyncAt = toIso(latestLeaderSnapshot?.snapshotAt ?? null)
    const lastOnchainTriggerAt = lastTrigger ? new Date(Number(lastTrigger.detectedAtMs)).toISOString() : null

    const workerReachable = workerHealth !== null
    const marketWsConnected =
      workerHealth && typeof workerHealth.marketData?.ws === 'object'
        ? toBoolean((workerHealth.marketData?.ws as Record<string, unknown>).connected)
        : null
    const userChannelConnected =
      workerHealth && typeof workerHealth.userChannel === 'object'
        ? toBoolean((workerHealth.userChannel as Record<string, unknown>).connected)
        : null
    const alchemyConnected =
      workerHealth && typeof workerHealth.chainTriggers === 'object'
        ? toBoolean((workerHealth.chainTriggers as Record<string, unknown>).connected)
        : null

    const retryBackoffCount =
      workerHealth && typeof workerHealth.execution === 'object'
        ? toNumber((workerHealth.execution as Record<string, unknown>).totalBackoffSkips)
        : 0

    const polymarketApiReachable =
      workerHealth && typeof workerHealth.execution === 'object'
        ? !Boolean((workerHealth.execution as Record<string, unknown>).lastError)
        : null

    return jsonContract(
      OverviewDataSchema,
      {
        copyProfileId: copyProfile?.id ?? null,
        exposure: {
          totalNotionalUsd: totalNotionalExposureUsd,
          byLeaderTop: byLeaderExposure,
          trackingErrorUsd,
          trackingErrorPct
        },
        pnl: {
          totalPnlUsd,
          realizedPnlUsd,
          unrealizedPnlUsd,
          byMarketTop,
          byLeaderTop: byLeaderPnl
        },
        recentActivity: {
          executions: recentExecutions.map((row) => ({
            id: row.id,
            tokenId: row.tokenId,
            marketId: row.marketId,
            side: row.side,
            notionalUsd: toNumber(row.intendedNotionalUsd),
            shares: toNumber(row.intendedShares),
            priceLimit: toNumber(row.priceLimit),
            status: row.status,
            attemptedAt: row.attemptedAt.toISOString(),
            leaderName: row.copyAttempt?.leader?.name ?? null
          })),
          skips: recentSkips.map((row) => ({
            id: row.id,
            tokenId: row.tokenId,
            marketId: row.marketId,
            side: row.side,
            reason: row.reason,
            createdAt: row.createdAt.toISOString(),
            leaderName: row.leader?.name ?? null
          }))
        },
        health: {
          workerStatus: workerHealth?.status ?? workerStatusRow?.status ?? 'DOWN',
          copySystemEnabled: config.masterSwitches.copySystemEnabled,
          dataFreshness: {
            lastLeaderSyncAt,
            lastFollowerSyncAt,
            lastReconcileAt,
            lastOnchainTriggerAt
          },
          connectivity: {
            workerReachable,
            polymarketApiReachable,
            marketWsConnected,
            userChannelConnected,
            alchemyConnected
          },
          errors: {
            lastError: lastError?.message ?? null,
            errorCount1h,
            retryBackoffCount
          }
        }
      },
      {
        cacheSeconds: 10
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'OVERVIEW_CONTRACT_FAILED', 'Overview response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'OVERVIEW_FAILED', toErrorMessage(error))
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value
  }
  return null
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
