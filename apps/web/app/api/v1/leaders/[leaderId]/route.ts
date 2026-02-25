import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, parseLeaderProfileAddress, toIso, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LeaderStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'DISABLED'])

const UpdateLeaderBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    profileAddress: z.string().trim().min(1).optional(),
    status: LeaderStatusSchema.optional(),
    copyProfileId: z.string().trim().min(1).optional(),
    ratio: z.number().min(0).max(1).optional(),
    settings: z.record(z.string(), z.unknown()).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.'
  })

const LeaderDetailDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  profileAddress: z.string(),
  status: LeaderStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  wallets: z.array(
    z.object({
      walletAddress: z.string(),
      isPrimary: z.boolean(),
      isActive: z.boolean(),
      firstSeenAt: z.string(),
      lastSeenAt: z.string()
    })
  ),
  profileLinks: z.array(
    z.object({
      copyProfileId: z.string(),
      ratio: z.number(),
      status: z.enum(['ACTIVE', 'PAUSED', 'REMOVED']),
      settings: z.record(z.string(), z.unknown())
    })
  ),
  stats: z.object({
    targetExposureUsd: z.number(),
    followerAttributedExposureUsd: z.number(),
    trackingErrorUsd: z.number(),
    counters: z.object({
      triggersReceived: z.number().int().nonnegative(),
      tradesDetected: z.number().int().nonnegative(),
      tradesExecuted: z.number().int().nonnegative(),
      skips: z.number().int().nonnegative(),
      skipReasons: z.array(
        z.object({
          reason: z.string(),
          count: z.number().int().nonnegative()
        })
      )
    })
  }),
  recent: z.object({
    triggers: z.array(
      z.object({
        id: z.string(),
        source: z.enum(['CHAIN', 'DATA_API']),
        tokenId: z.string(),
        marketId: z.string().nullable(),
        outcome: z.string().nullable(),
        side: z.enum(['BUY', 'SELL']),
        shares: z.number(),
        price: z.number(),
        notionalUsd: z.number(),
        leaderFillAtMs: z.string(),
        detectedAtMs: z.string()
      })
    ),
    executions: z.array(
      z.object({
        id: z.string(),
        copyAttemptId: z.string().nullable(),
        tokenId: z.string(),
        marketId: z.string().nullable(),
        side: z.enum(['BUY', 'SELL']),
        status: z.enum(['PLACED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED', 'RETRYING']),
        intendedNotionalUsd: z.number(),
        intendedShares: z.number(),
        priceLimit: z.number(),
        attemptedAt: z.string(),
        reason: z.string().nullable(),
        errorMessage: z.string().nullable()
      })
    ),
    skips: z.array(
      z.object({
        id: z.string(),
        tokenId: z.string(),
        marketId: z.string().nullable(),
        side: z.enum(['BUY', 'SELL']),
        status: z.enum(['PENDING', 'EXECUTING', 'EXECUTED', 'SKIPPED', 'EXPIRED', 'FAILED', 'RETRYING']),
        reason: z.string().nullable(),
        decision: z.enum(['PENDING', 'EXECUTED', 'SKIPPED']),
        createdAt: z.string(),
        attemptedAt: z.string().nullable(),
        accumulatedDeltaNotionalUsd: z.number()
      })
    ),
    errors: z.array(
      z.object({
        id: z.string(),
        severity: z.enum(['INFO', 'WARN', 'ERROR', 'CRITICAL']),
        code: z.string().nullable(),
        message: z.string(),
        occurredAt: z.string()
      })
    )
  }),
  diagnostics: z.object({
    lastAuthoritativePositionsSnapshotAt: z.string().nullable(),
    lastReconcile: z
      .object({
        cycleAt: z.string().nullable(),
        status: z.string().nullable(),
        deltasConsidered: z.number().nullable(),
        deltasExecuted: z.number().nullable(),
        deltasSkipped: z.number().nullable(),
        integrityViolations: z.number().nullable(),
        issues: z.array(
          z.object({
            code: z.string(),
            message: z.string(),
            severity: z.string()
          })
        )
      })
      .nullable()
  })
})

const LeaderMutationDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  profileAddress: z.string(),
  status: LeaderStatusSchema
})

export async function GET(_request: NextRequest, context: { params: Promise<{ leaderId: string }> }) {
  try {
    const params = await context.params
    const leaderId = params.leaderId

    const leader = await prisma.leader.findUnique({
      where: {
        id: leaderId
      },
      select: {
        id: true,
        name: true,
        profileAddress: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        wallets: {
          where: {
            isActive: true
          },
          orderBy: [
            {
              isPrimary: 'desc'
            },
            {
              createdAt: 'asc'
            }
          ],
          select: {
            walletAddress: true,
            isPrimary: true,
            isActive: true,
            firstSeenAt: true,
            lastSeenAt: true
          }
        },
        profileLinks: {
          orderBy: {
            createdAt: 'asc'
          },
          select: {
            copyProfileId: true,
            ratio: true,
            status: true,
            settings: true
          }
        }
      }
    })

    if (!leader) {
      return jsonError(404, 'LEADER_NOT_FOUND', 'Leader not found.')
    }

    const latestLeaderSnapshot = await prisma.leaderPositionSnapshot.findFirst({
      where: {
        leaderId
      },
      orderBy: {
        snapshotAt: 'desc'
      },
      select: {
        snapshotAt: true
      }
    })

    const [latestLeaderRows, tradeEventCounts, executedCount, skippedCount, skipReasonCounts, recentTriggers, recentExecutions, recentSkips, recentErrors] =
      await Promise.all([
        latestLeaderSnapshot
          ? prisma.leaderPositionSnapshot.findMany({
              where: {
                leaderId,
                snapshotAt: latestLeaderSnapshot.snapshotAt
              },
              select: {
                currentValueUsd: true
              }
            })
          : Promise.resolve([]),
        prisma.leaderTradeEvent.groupBy({
          by: ['source'],
          where: {
            leaderId
          },
          _count: {
            _all: true
          }
        }),
        prisma.copyAttempt.count({
          where: {
            leaderId,
            decision: 'EXECUTED'
          }
        }),
        prisma.copyAttempt.count({
          where: {
            leaderId,
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
        }),
        prisma.copyAttempt.groupBy({
          by: ['reason'],
          where: {
            leaderId,
            reason: {
              not: null
            },
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
          },
          _count: {
            _all: true
          }
        }),
        prisma.leaderTradeEvent.findMany({
          where: {
            leaderId
          },
          orderBy: {
            detectedAtMs: 'desc'
          },
          take: 20,
          select: {
            id: true,
            source: true,
            tokenId: true,
            marketId: true,
            outcome: true,
            side: true,
            shares: true,
            price: true,
            notionalUsd: true,
            leaderFillAtMs: true,
            detectedAtMs: true
          }
        }),
        prisma.copyOrder.findMany({
          where: {
            copyAttempt: {
              leaderId
            }
          },
          orderBy: {
            attemptedAt: 'desc'
          },
          take: 20,
          select: {
            id: true,
            copyAttemptId: true,
            tokenId: true,
            marketId: true,
            side: true,
            status: true,
            intendedNotionalUsd: true,
            intendedShares: true,
            priceLimit: true,
            attemptedAt: true,
            errorMessage: true,
            copyAttempt: {
              select: {
                reason: true
              }
            }
          }
        }),
        prisma.copyAttempt.findMany({
          where: {
            leaderId,
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
          },
          orderBy: {
            createdAt: 'desc'
          },
          take: 20,
          select: {
            id: true,
            tokenId: true,
            marketId: true,
            side: true,
            status: true,
            reason: true,
            decision: true,
            createdAt: true,
            attemptedAt: true,
            accumulatedDeltaNotionalUsd: true
          }
        }),
        prisma.errorEvent.findMany({
          where: {
            relatedLeaderId: leaderId
          },
          orderBy: {
            occurredAt: 'desc'
          },
          take: 20,
          select: {
            id: true,
            severity: true,
            code: true,
            message: true,
            occurredAt: true
          }
        })
      ])

    const targetExposureUsd = latestLeaderRows.reduce((sum, row) => sum + Math.abs(toNumber(row.currentValueUsd)), 0)

    const ledgers = await prisma.leaderTokenLedger.findMany({
      where: {
        leaderId
      },
      select: {
        tokenId: true,
        shares: true
      }
    })

    const activeProfileId = leader.profileLinks.find((link) => link.status === 'ACTIVE')?.copyProfileId ?? null
    const latestFollowerSnapshotAt = activeProfileId
      ? await prisma.followerPositionSnapshot.findFirst({
          where: {
            copyProfileId: activeProfileId
          },
          orderBy: {
            snapshotAt: 'desc'
          },
          select: {
            snapshotAt: true
          }
        })
      : null

    const followerRows =
      activeProfileId && latestFollowerSnapshotAt
        ? await prisma.followerPositionSnapshot.findMany({
            where: {
              copyProfileId: activeProfileId,
              snapshotAt: latestFollowerSnapshotAt.snapshotAt
            },
            select: {
              tokenId: true,
              currentPrice: true,
              currentValueUsd: true,
              shares: true
            }
          })
        : []

    const tokenPriceById = new Map<string, number>()
    for (const row of followerRows) {
      const fallbackPrice =
        Math.abs(toNumber(row.shares)) > 0 ? Math.abs(toNumber(row.currentValueUsd)) / Math.abs(toNumber(row.shares)) : 0
      tokenPriceById.set(row.tokenId, toNumber(row.currentPrice) || fallbackPrice)
    }

    const followerAttributedExposureUsd = ledgers.reduce((sum, row) => {
      const markPrice = tokenPriceById.get(row.tokenId) ?? 0
      return sum + Math.abs(toNumber(row.shares) * markPrice)
    }, 0)

    const tradeCountMap = new Map<string, number>()
    for (const row of tradeEventCounts) {
      tradeCountMap.set(row.source, row._count._all)
    }

    const skipReasonBreakdown = skipReasonCounts
      .filter((row) => row.reason !== null)
      .map((row) => ({
        reason: row.reason as string,
        count: row._count._all
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const workerStatus = await prisma.systemStatus.findUnique({
      where: {
        component: 'WORKER'
      },
      select: {
        details: true
      }
    })

    const reconcile = asObject(workerStatus?.details).reconcile
    const reconcileObject = asObject(reconcile)
    const reconcileIssues = Array.isArray(reconcileObject.issues)
      ? reconcileObject.issues.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      : []

    return jsonContract(
      LeaderDetailDataSchema,
      {
        id: leader.id,
        name: leader.name,
        profileAddress: leader.profileAddress,
        status: leader.status,
        createdAt: leader.createdAt.toISOString(),
        updatedAt: leader.updatedAt.toISOString(),
        wallets: leader.wallets.map((wallet) => ({
          walletAddress: wallet.walletAddress,
          isPrimary: wallet.isPrimary,
          isActive: wallet.isActive,
          firstSeenAt: wallet.firstSeenAt.toISOString(),
          lastSeenAt: wallet.lastSeenAt.toISOString()
        })),
        profileLinks: leader.profileLinks.map((link) => ({
          copyProfileId: link.copyProfileId,
          ratio: toNumber(link.ratio),
          status: link.status,
          settings: asObject(link.settings)
        })),
        stats: {
          targetExposureUsd,
          followerAttributedExposureUsd,
          trackingErrorUsd: Math.abs(targetExposureUsd - followerAttributedExposureUsd),
          counters: {
            triggersReceived: tradeCountMap.get('CHAIN') ?? 0,
            tradesDetected: recentTriggers.length,
            tradesExecuted: executedCount,
            skips: skippedCount,
            skipReasons: skipReasonBreakdown
          }
        },
        recent: {
          triggers: recentTriggers.map((row) => ({
            id: row.id,
            source: row.source,
            tokenId: row.tokenId,
            marketId: row.marketId,
            outcome: row.outcome,
            side: row.side,
            shares: toNumber(row.shares),
            price: toNumber(row.price),
            notionalUsd: toNumber(row.notionalUsd),
            leaderFillAtMs: row.leaderFillAtMs.toString(),
            detectedAtMs: row.detectedAtMs.toString()
          })),
          executions: recentExecutions.map((row) => ({
            id: row.id,
            copyAttemptId: row.copyAttemptId,
            tokenId: row.tokenId,
            marketId: row.marketId,
            side: row.side,
            status: row.status,
            intendedNotionalUsd: toNumber(row.intendedNotionalUsd),
            intendedShares: toNumber(row.intendedShares),
            priceLimit: toNumber(row.priceLimit),
            attemptedAt: row.attemptedAt.toISOString(),
            reason: row.copyAttempt?.reason ?? null,
            errorMessage: row.errorMessage
          })),
          skips: recentSkips.map((row) => ({
            id: row.id,
            tokenId: row.tokenId,
            marketId: row.marketId,
            side: row.side,
            status: row.status,
            reason: row.reason,
            decision: row.decision,
            createdAt: row.createdAt.toISOString(),
            attemptedAt: toIso(row.attemptedAt),
            accumulatedDeltaNotionalUsd: toNumber(row.accumulatedDeltaNotionalUsd)
          })),
          errors: recentErrors.map((row) => ({
            id: row.id,
            severity: row.severity,
            code: row.code,
            message: row.message,
            occurredAt: row.occurredAt.toISOString()
          }))
        },
        diagnostics: {
          lastAuthoritativePositionsSnapshotAt: toIso(latestLeaderSnapshot?.snapshotAt ?? null),
          lastReconcile: reconcileObject && Object.keys(reconcileObject).length > 0
            ? {
                cycleAt: typeof reconcileObject.cycleAt === 'string' ? reconcileObject.cycleAt : null,
                status: typeof reconcileObject.status === 'string' ? reconcileObject.status : null,
                deltasConsidered: firstNumber(
                  reconcileObject.deltasConsidered,
                  reconcileObject.considered,
                  reconcileObject.tokensEvaluated
                ),
                deltasExecuted: firstNumber(
                  reconcileObject.deltasExecuted,
                  reconcileObject.executed,
                  reconcileObject.executedCount
                ),
                deltasSkipped: firstNumber(
                  reconcileObject.deltasSkipped,
                  reconcileObject.skipped,
                  reconcileObject.skippedCount
                ),
                integrityViolations:
                  typeof reconcileObject.integrityViolations === 'number' ? reconcileObject.integrityViolations : null,
                issues: reconcileIssues.map((issue) => ({
                  code: typeof issue.code === 'string' ? issue.code : 'UNKNOWN',
                  message: typeof issue.message === 'string' ? issue.message : 'n/a',
                  severity: typeof issue.severity === 'string' ? issue.severity : 'n/a'
                }))
              }
            : null
        }
      },
      {
        cacheSeconds: 5
      }
    )
  } catch (error) {
    return jsonError(500, 'LEADER_DETAIL_FAILED', toErrorMessage(error))
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ leaderId: string }> }) {
  try {
    const params = await context.params
    const leaderId = params.leaderId
    const body = UpdateLeaderBodySchema.parse(await request.json())

    const parsedProfileAddress = body.profileAddress ? parseLeaderProfileAddress(body.profileAddress) : undefined
    if (body.profileAddress && !parsedProfileAddress) {
      return jsonError(400, 'INVALID_PROFILE_ADDRESS', 'Expected a Polymarket profile URL or 0x profile address.')
    }
    const profileAddress = body.profileAddress ? parsedProfileAddress ?? undefined : undefined

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.leader.findUnique({
        where: {
          id: leaderId
        },
        select: {
          id: true
        }
      })

      if (!existing) {
        return null
      }

      const nextLeader = await tx.leader.update({
        where: {
          id: leaderId
        },
        data: {
          name: body.name,
          profileAddress,
          status: body.status
        },
        select: {
          id: true,
          name: true,
          profileAddress: true,
          status: true
        }
      })

      if (body.status === 'DISABLED') {
        await tx.copyProfileLeader.updateMany({
          where: {
            leaderId
          },
          data: {
            status: 'REMOVED'
          }
        })
      }

      if (body.ratio !== undefined || body.settings !== undefined || body.copyProfileId) {
        const selectedProfileId =
          body.copyProfileId ??
          (
            await tx.copyProfileLeader.findFirst({
              where: {
                leaderId,
                status: {
                  in: ['ACTIVE', 'PAUSED']
                }
              },
              orderBy: {
                createdAt: 'asc'
              },
              select: {
                copyProfileId: true
              }
            })
          )?.copyProfileId ??
          (
            await tx.copyProfile.findFirst({
              where: {
                status: {
                  in: ['ACTIVE', 'PAUSED']
                }
              },
              orderBy: {
                createdAt: 'asc'
              },
              select: {
                id: true
              }
            })
          )?.id

        if (selectedProfileId) {
          const profile = await tx.copyProfile.findUnique({
            where: {
              id: selectedProfileId
            },
            select: {
              defaultRatio: true
            }
          })

          await tx.copyProfileLeader.upsert({
            where: {
              copyProfileId_leaderId: {
                copyProfileId: selectedProfileId,
                leaderId
              }
            },
            create: {
              copyProfileId: selectedProfileId,
              leaderId,
              ratio: String(body.ratio ?? toNumber(profile?.defaultRatio)),
              status: 'ACTIVE',
              settings: body.settings ? toJsonValue(body.settings) : undefined
            },
            update: {
              ratio: body.ratio !== undefined ? String(body.ratio) : undefined,
              settings: body.settings ? toJsonValue(body.settings) : undefined,
              status: body.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'
            }
          })
        }
      }

      return nextLeader
    })

    if (!updated) {
      return jsonError(404, 'LEADER_NOT_FOUND', 'Leader not found.')
    }

    return jsonContract(LeaderMutationDataSchema, updated)
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return jsonError(409, 'LEADER_ALREADY_EXISTS', 'Leader with this profile address already exists.')
    }

    if (error instanceof z.ZodError) {
      return jsonError(400, 'INVALID_REQUEST_BODY', 'Request body failed validation.', {
        issues: error.issues
      })
    }

    return jsonError(500, 'LEADER_UPDATE_FAILED', toErrorMessage(error))
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ leaderId: string }> }) {
  try {
    const params = await context.params
    const leaderId = params.leaderId

    const result = await prisma.$transaction(async (tx) => {
      const leader = await tx.leader.findUnique({
        where: {
          id: leaderId
        },
        select: {
          id: true,
          name: true,
          profileAddress: true
        }
      })
      if (!leader) {
        return null
      }

      const updatedLeader = await tx.leader.update({
        where: {
          id: leaderId
        },
        data: {
          status: 'DISABLED'
        },
        select: {
          id: true,
          name: true,
          profileAddress: true,
          status: true
        }
      })

      await tx.copyProfileLeader.updateMany({
        where: {
          leaderId
        },
        data: {
          status: 'REMOVED'
        }
      })

      return updatedLeader
    })

    if (!result) {
      return jsonError(404, 'LEADER_NOT_FOUND', 'Leader not found.')
    }

    return jsonContract(LeaderMutationDataSchema, result)
  } catch (error) {
    return jsonError(500, 'LEADER_DELETE_FAILED', toErrorMessage(error))
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return null
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { code?: unknown }).code === 'P2002'
}

function toJsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
