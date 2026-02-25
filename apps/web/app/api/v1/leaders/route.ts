import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import {
  jsonContract,
  jsonError,
  paginationMeta,
  parseLeaderProfileAddress,
  parsePagination,
  toIso,
  toNumber
} from '@/lib/server/api'
import { prisma } from '@/lib/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const LeaderStatusSchema = z.enum(['ACTIVE', 'PAUSED', 'DISABLED'])

const CreateLeaderBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  profileAddress: z.string().trim().min(1),
  status: LeaderStatusSchema.optional(),
  copyProfileId: z.string().trim().min(1).optional(),
  ratio: z.number().min(0).max(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional()
})

const LeaderListDataSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      profileAddress: z.string(),
      status: LeaderStatusSchema,
      createdAt: z.string(),
      tradeWallets: z.array(z.string()),
      primaryTradeWallet: z.string().nullable(),
      lastSyncAt: z.string().nullable(),
      copyConfig: z.object({
        copyProfileId: z.string().nullable(),
        ratio: z.number().nullable(),
        allowDenyConfigured: z.boolean(),
        capsConfigured: z.boolean()
      }),
      metrics: z.object({
        exposureUsd: z.number(),
        trackingErrorUsd: z.number(),
        pnlContributionUsd: z.number(),
        executedCount: z.number().int(),
        skippedCount: z.number().int()
      })
    })
  ),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive()
  })
})

const CreatedLeaderDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  profileAddress: z.string(),
  status: LeaderStatusSchema,
  copyProfileLink: z
    .object({
      copyProfileId: z.string(),
      ratio: z.number()
    })
    .nullable()
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)
    const search = url.searchParams.get('search')?.trim() ?? ''
    const statusFilter = url.searchParams.get('status')

    const where: Prisma.LeaderWhereInput = {}
    if (statusFilter && LeaderStatusSchema.safeParse(statusFilter).success) {
      where.status = statusFilter as z.infer<typeof LeaderStatusSchema>
    }
    if (search.length > 0) {
      where.OR = [
        {
          name: {
            contains: search,
            mode: 'insensitive'
          }
        },
        {
          profileAddress: {
            contains: search,
            mode: 'insensitive'
          }
        },
        {
          wallets: {
            some: {
              walletAddress: {
                contains: search.toLowerCase(),
                mode: 'insensitive'
              }
            }
          }
        }
      ]
    }

    const [total, leaders] = await Promise.all([
      prisma.leader.count({ where }),
      prisma.leader.findMany({
        where,
        orderBy: {
          createdAt: 'asc'
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        select: {
          id: true,
          name: true,
          profileAddress: true,
          status: true,
          createdAt: true,
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
              isPrimary: true
            }
          }
        }
      })
    ])

    const leaderIds = leaders.map((leader) => leader.id)

    const [latestSnapshots, profileLinks, pendingByLeader, attemptByLeaderDecision, pnlSummaries] = await Promise.all([
      leaderIds.length === 0
        ? Promise.resolve([])
        : prisma.leaderPositionSnapshot.groupBy({
            by: ['leaderId'],
            where: {
              leaderId: {
                in: leaderIds
              }
            },
            _max: {
              snapshotAt: true
            }
          }),
      leaderIds.length === 0
        ? Promise.resolve([])
        : prisma.copyProfileLeader.findMany({
            where: {
              leaderId: {
                in: leaderIds
              },
              status: 'ACTIVE'
            },
            orderBy: {
              createdAt: 'asc'
            },
            select: {
              leaderId: true,
              copyProfileId: true,
              ratio: true,
              settings: true
            }
          }),
      leaderIds.length === 0
        ? Promise.resolve([])
        : prisma.pendingDelta.groupBy({
            by: ['leaderId'],
            where: {
              leaderId: {
                in: leaderIds
              },
              status: {
                in: ['PENDING', 'BLOCKED', 'ELIGIBLE']
              }
            },
            _sum: {
              pendingDeltaNotionalUsd: true
            }
          }),
      leaderIds.length === 0
        ? Promise.resolve([])
        : prisma.copyAttempt.groupBy({
            by: ['leaderId', 'decision'],
            where: {
              leaderId: {
                in: leaderIds
              }
            },
            _count: {
              _all: true
            }
          }),
      leaderIds.length === 0
        ? Promise.resolve([])
        : prisma.leaderPnlSummary.findMany({
            where: {
              leaderId: {
                in: leaderIds
              }
            },
            select: {
              leaderId: true,
              realizedPnlUsd: true
            }
          })
    ])

    const latestSnapshotPairs = latestSnapshots
      .filter((row) => row._max.snapshotAt)
      .map((row) => ({
        leaderId: row.leaderId,
        snapshotAt: row._max.snapshotAt as Date
      }))

    const exposureRows =
      latestSnapshotPairs.length === 0
        ? []
        : await prisma.leaderPositionSnapshot.findMany({
            where: {
              OR: latestSnapshotPairs.map((row) => ({
                leaderId: row.leaderId,
                snapshotAt: row.snapshotAt
              }))
            },
            select: {
              leaderId: true,
              snapshotAt: true,
              currentValueUsd: true
            }
          })

    const exposureByLeader = new Map<string, number>()
    const lastSyncByLeader = new Map<string, Date>()
    for (const row of exposureRows) {
      const previous = exposureByLeader.get(row.leaderId) ?? 0
      exposureByLeader.set(row.leaderId, previous + Math.abs(toNumber(row.currentValueUsd)))

      const knownLastSync = lastSyncByLeader.get(row.leaderId)
      if (!knownLastSync || row.snapshotAt.getTime() > knownLastSync.getTime()) {
        lastSyncByLeader.set(row.leaderId, row.snapshotAt)
      }
    }

    const profileLinkByLeader = new Map<
      string,
      {
        copyProfileId: string
        ratio: number
        allowDenyConfigured: boolean
        capsConfigured: boolean
      }
    >()
    for (const link of profileLinks) {
      if (profileLinkByLeader.has(link.leaderId)) {
        continue
      }

      const settings = asObject(link.settings)
      const allowDenyConfigured = toStringArray(settings.allowList).length > 0 || toStringArray(settings.denyList).length > 0
      const capsConfigured =
        toNumber(settings.maxExposurePerLeaderUsd) > 0 ||
        toNumber(settings.maxExposurePerMarketOutcomeUsd) > 0 ||
        toNumber(settings.maxDailyNotionalTurnoverUsd) > 0

      profileLinkByLeader.set(link.leaderId, {
        copyProfileId: link.copyProfileId,
        ratio: toNumber(link.ratio),
        allowDenyConfigured,
        capsConfigured
      })
    }

    const trackingErrorByLeader = new Map<string, number>()
    for (const row of pendingByLeader) {
      if (!row.leaderId) {
        continue
      }
      trackingErrorByLeader.set(row.leaderId, Math.abs(toNumber(row._sum.pendingDeltaNotionalUsd)))
    }

    const executedCountByLeader = new Map<string, number>()
    const skippedCountByLeader = new Map<string, number>()
    for (const row of attemptByLeaderDecision) {
      if (!row.leaderId) {
        continue
      }
      if (row.decision === 'EXECUTED') {
        executedCountByLeader.set(row.leaderId, row._count._all)
      }
      if (row.decision === 'SKIPPED') {
        skippedCountByLeader.set(row.leaderId, row._count._all)
      }
    }

    const pnlByLeader = new Map<string, number>()
    for (const row of pnlSummaries) {
      pnlByLeader.set(row.leaderId, toNumber(row.realizedPnlUsd))
    }

    const items = leaders.map((leader) => {
      const link = profileLinkByLeader.get(leader.id)
      const primaryWallet = leader.wallets.find((wallet) => wallet.isPrimary)?.walletAddress ?? leader.wallets[0]?.walletAddress ?? null

      return {
        id: leader.id,
        name: leader.name,
        profileAddress: leader.profileAddress,
        status: leader.status,
        createdAt: leader.createdAt.toISOString(),
        tradeWallets: leader.wallets.map((wallet) => wallet.walletAddress),
        primaryTradeWallet: primaryWallet,
        lastSyncAt: toIso(lastSyncByLeader.get(leader.id)),
        copyConfig: {
          copyProfileId: link?.copyProfileId ?? null,
          ratio: link?.ratio ?? null,
          allowDenyConfigured: link?.allowDenyConfigured ?? false,
          capsConfigured: link?.capsConfigured ?? false
        },
        metrics: {
          exposureUsd: exposureByLeader.get(leader.id) ?? 0,
          trackingErrorUsd: trackingErrorByLeader.get(leader.id) ?? 0,
          pnlContributionUsd: pnlByLeader.get(leader.id) ?? 0,
          executedCount: executedCountByLeader.get(leader.id) ?? 0,
          skippedCount: skippedCountByLeader.get(leader.id) ?? 0
        }
      }
    })

    return jsonContract(
      LeaderListDataSchema,
      {
        items,
        pagination: paginationMeta(pagination, total)
      },
      {
        cacheSeconds: 5
      }
    )
  } catch (error) {
    return jsonError(500, 'LEADERS_LIST_FAILED', toErrorMessage(error))
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = CreateLeaderBodySchema.parse(await request.json())
    const profileAddress = parseLeaderProfileAddress(body.profileAddress)
    if (!profileAddress) {
      return jsonError(400, 'INVALID_PROFILE_ADDRESS', 'Expected a Polymarket profile URL or 0x profile address.')
    }

    const result = await prisma.$transaction(async (tx) => {
      const createdLeader = await tx.leader.create({
        data: {
          name: body.name,
          profileAddress,
          status: body.status ?? 'ACTIVE'
        },
        select: {
          id: true,
          name: true,
          profileAddress: true,
          status: true
        }
      })

      const profile =
        body.copyProfileId
          ? await tx.copyProfile.findUnique({
              where: {
                id: body.copyProfileId
              },
              select: {
                id: true,
                defaultRatio: true
              }
            })
          : await tx.copyProfile.findFirst({
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
                defaultRatio: true
              }
            })

      if (!profile) {
        return {
          leader: createdLeader,
          link: null
        }
      }

      const ratio = body.ratio ?? toNumber(profile.defaultRatio)
      const link = await tx.copyProfileLeader.upsert({
        where: {
          copyProfileId_leaderId: {
            copyProfileId: profile.id,
            leaderId: createdLeader.id
          }
        },
        create: {
          copyProfileId: profile.id,
          leaderId: createdLeader.id,
          ratio: String(ratio),
          status: 'ACTIVE',
          settings: body.settings ? toJsonValue(body.settings) : undefined
        },
        update: {
          ratio: String(ratio),
          status: 'ACTIVE',
          settings: body.settings ? toJsonValue(body.settings) : undefined
        },
        select: {
          copyProfileId: true,
          ratio: true
        }
      })

      return {
        leader: createdLeader,
        link: {
          copyProfileId: link.copyProfileId,
          ratio: toNumber(link.ratio)
        }
      }
    })

    return jsonContract(
      CreatedLeaderDataSchema,
      {
        id: result.leader.id,
        name: result.leader.name,
        profileAddress: result.leader.profileAddress,
        status: result.leader.status,
        copyProfileLink: result.link
      },
      {
        status: 201
      }
    )
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return jsonError(409, 'LEADER_ALREADY_EXISTS', 'Leader with this profile address already exists.')
    }

    if (error instanceof z.ZodError) {
      return jsonError(400, 'INVALID_REQUEST_BODY', 'Request body failed validation.', {
        issues: error.issues
      })
    }

    return jsonError(500, 'LEADER_CREATE_FAILED', toErrorMessage(error))
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((entry): entry is string => typeof entry === 'string')
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
