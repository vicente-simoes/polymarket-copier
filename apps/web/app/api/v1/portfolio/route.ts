import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import {
  jsonContract,
  jsonError,
  paginationMeta,
  parsePagination,
  round,
  toIso,
  toNumber
} from '@/lib/server/api'
import { prisma } from '@/lib/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RangeSchema = z.enum(['1h', '24h', '1w', '1m'])

const PortfolioDataSchema = z.object({
  copyProfileId: z.string().nullable(),
  range: RangeSchema,
  summary: z.object({
    exposureUsd: z.number(),
    totalValueUsd: z.number(),
    realizedPnlUsd: z.number(),
    unrealizedPnlUsd: z.number(),
    totalPnlUsd: z.number(),
    window1hPnlUsd: z.number(),
    window24hPnlUsd: z.number(),
    window1wPnlUsd: z.number(),
    window1mPnlUsd: z.number(),
    lastUpdatedAt: z.string().nullable()
  }),
  chart: z.object({
    points: z.array(
      z.object({
        timestamp: z.string(),
        exposureUsd: z.number(),
        totalValueUsd: z.number(),
        totalPnlUsd: z.number(),
        realizedPnlUsd: z.number(),
        unrealizedPnlUsd: z.number()
      })
    ),
    pointCount: z.number().int().nonnegative(),
    maxPoints: z.number().int().positive()
  }),
  exposureBreakdown: z.object({
    byLeaderTop: z.array(
      z.object({
        leaderId: z.string(),
        leaderName: z.string(),
        exposureUsd: z.number()
      })
    ),
    byOutcomeTop: z.array(
      z.object({
        tokenId: z.string(),
        marketId: z.string().nullable(),
        marketName: z.string().nullable(),
        outcome: z.string().nullable(),
        exposureUsd: z.number(),
        isOther: z.boolean()
      })
    )
  }),
  positions: z.object({
    items: z.array(
      z.object({
        tokenId: z.string(),
        marketId: z.string().nullable(),
        marketName: z.string().nullable(),
        outcome: z.string().nullable(),
        shares: z.number(),
        currentPrice: z.number(),
        costBasisUsd: z.number(),
        currentValueUsd: z.number(),
        unrealizedPnlUsd: z.number()
      })
    ),
    pagination: z.object({
      page: z.number().int().positive(),
      pageSize: z.number().int().positive(),
      total: z.number().int().nonnegative(),
      totalPages: z.number().int().positive()
    })
  })
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const requestedProfileId = url.searchParams.get('copyProfileId')
    const tokenIdFilter = url.searchParams.get('tokenId')?.trim()
    const range = RangeSchema.safeParse(url.searchParams.get('range')).success
      ? (url.searchParams.get('range') as z.infer<typeof RangeSchema>)
      : '24h'
    const pagination = parsePagination(url)

    const copyProfile =
      requestedProfileId
        ? await prisma.copyProfile.findUnique({
            where: {
              id: requestedProfileId
            },
            select: {
              id: true
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
              id: true
            }
          })

    if (!copyProfile) {
      return jsonContract(PortfolioDataSchema, {
        copyProfileId: null,
        range,
        summary: {
          exposureUsd: 0,
          totalValueUsd: 0,
          realizedPnlUsd: 0,
          unrealizedPnlUsd: 0,
          totalPnlUsd: 0,
          window1hPnlUsd: 0,
          window24hPnlUsd: 0,
          window1wPnlUsd: 0,
          window1mPnlUsd: 0,
          lastUpdatedAt: null
        },
        chart: {
          points: [],
          pointCount: 0,
          maxPoints: rangeToConfig(range).maxPoints
        },
        exposureBreakdown: {
          byLeaderTop: [],
          byOutcomeTop: []
        },
        positions: {
          items: [],
          pagination: paginationMeta(pagination, 0)
        }
      })
    }

    const latestSnapshot = await prisma.followerPositionSnapshot.findFirst({
      where: {
        copyProfileId: copyProfile.id
      },
      orderBy: {
        snapshotAt: 'desc'
      },
      select: {
        snapshotAt: true
      }
    })

    const positions =
      latestSnapshot
        ? await prisma.followerPositionSnapshot.findMany({
            where: {
              copyProfileId: copyProfile.id,
              snapshotAt: latestSnapshot.snapshotAt
            },
            select: {
              tokenId: true,
              marketId: true,
              payload: true,
              outcome: true,
              shares: true,
              currentPrice: true,
              costBasisUsd: true,
              currentValueUsd: true
            }
          })
        : []

    const basePositions = positions
      .map((row) => {
        const shares = toNumber(row.shares)
        const currentPrice = toNumber(row.currentPrice)
        const currentValueUsd = toNumber(row.currentValueUsd) || shares * currentPrice
        const costBasisUsd = toNumber(row.costBasisUsd)
        const unrealizedPnlUsd = currentValueUsd - costBasisUsd

        return {
          tokenId: row.tokenId,
          marketId: row.marketId,
          marketName: extractMarketNameFromPayload(row.payload),
          outcome: row.outcome,
          shares,
          currentPrice,
          costBasisUsd,
          currentValueUsd,
          unrealizedPnlUsd
        }
      })
    const fallbackMarketNames = await resolveMarketNamesByToken(
      basePositions.filter((row) => !row.marketName).map((row) => row.tokenId)
    )

    const sortedPositions = basePositions
      .map((row) => ({
        ...row,
        marketName: row.marketName ?? fallbackMarketNames.get(row.tokenId) ?? null
      }))
      .sort((a, b) => Math.abs(b.currentValueUsd) - Math.abs(a.currentValueUsd))

    const filteredPositions = tokenIdFilter
      ? sortedPositions.filter((row) => row.tokenId === tokenIdFilter)
      : sortedPositions
    const totalPositions = filteredPositions.length
    const pagedPositions = filteredPositions.slice(pagination.skip, pagination.skip + pagination.pageSize)

    const realizedPnlRows = await prisma.$queryRaw<Array<{ realizedPnlUsd: Prisma.Decimal | null }>>(
      Prisma.sql`
        SELECT SUM("realizedPnlUsd") AS "realizedPnlUsd"
        FROM "LeaderPnlSummary"
        WHERE "copyProfileId" = ${copyProfile.id}
      `
    )
    const realizedPnlUsd = realizedPnlRows[0]?.realizedPnlUsd ?? null

    const realizedTotal = toNumber(realizedPnlUsd)
    const unrealizedTotal = sortedPositions.reduce((sum, row) => sum + row.unrealizedPnlUsd, 0)
    const exposureTotal = sortedPositions.reduce((sum, row) => sum + Math.abs(row.currentValueUsd), 0)
    const totalValueUsd = sortedPositions.reduce((sum, row) => sum + row.currentValueUsd, 0)
    const totalPnlUsd = realizedTotal + unrealizedTotal

    const rangeConfig = rangeToConfig(range)
    const since = new Date(Date.now() - rangeConfig.windowMs)

    const snapshots = await prisma.portfolioSnapshot.findMany({
      where: {
        copyProfileId: copyProfile.id,
        snapshotAt: {
          gte: since
        }
      },
      orderBy: {
        snapshotAt: 'desc'
      },
      take: rangeConfig.maxPoints,
      select: {
        snapshotAt: true,
        exposureUsd: true,
        totalValueUsd: true,
        realizedPnlUsd: true,
        unrealizedPnlUsd: true,
        totalPnlUsd: true,
        window1hPnlUsd: true,
        window24hPnlUsd: true,
        window7dPnlUsd: true,
        window30dPnlUsd: true
      }
    })

    const points = [...snapshots]
      .reverse()
      .map((row) => ({
        timestamp: row.snapshotAt.toISOString(),
        exposureUsd: toNumber(row.exposureUsd),
        totalValueUsd: toNumber(row.totalValueUsd),
        totalPnlUsd: toNumber(row.totalPnlUsd),
        realizedPnlUsd: toNumber(row.realizedPnlUsd),
        unrealizedPnlUsd: toNumber(row.unrealizedPnlUsd)
      }))

    const summaryFromSnapshots = snapshots[0]
    const summary = {
      exposureUsd: points.length > 0 ? points[points.length - 1]?.exposureUsd ?? exposureTotal : exposureTotal,
      totalValueUsd: points.length > 0 ? points[points.length - 1]?.totalValueUsd ?? totalValueUsd : totalValueUsd,
      realizedPnlUsd: realizedTotal,
      unrealizedPnlUsd: unrealizedTotal,
      totalPnlUsd,
      window1hPnlUsd: toNumber(summaryFromSnapshots?.window1hPnlUsd),
      window24hPnlUsd: toNumber(summaryFromSnapshots?.window24hPnlUsd),
      window1wPnlUsd: toNumber(summaryFromSnapshots?.window7dPnlUsd),
      window1mPnlUsd: toNumber(summaryFromSnapshots?.window30dPnlUsd),
      lastUpdatedAt: toIso(latestSnapshot?.snapshotAt ?? null)
    }

    if (points.length === 0 && latestSnapshot) {
      points.push({
        timestamp: latestSnapshot.snapshotAt.toISOString(),
        exposureUsd: exposureTotal,
        totalValueUsd,
        totalPnlUsd,
        realizedPnlUsd: realizedTotal,
        unrealizedPnlUsd: unrealizedTotal
      })
    }

    const priceByToken = new Map(sortedPositions.map((position) => [position.tokenId, position.currentPrice]))
    const leaderLedgers = await prisma.$queryRaw<Array<{ leaderId: string; tokenId: string; shares: Prisma.Decimal; leaderName: string }>>(
      Prisma.sql`
        SELECT
          ltl."leaderId",
          ltl."tokenId",
          ltl."shares",
          l."name" AS "leaderName"
        FROM "LeaderTokenLedger" ltl
        INNER JOIN "Leader" l ON l."id" = ltl."leaderId"
        WHERE ltl."copyProfileId" = ${copyProfile.id}
      `
    )

    const leaderExposureMap = new Map<string, { leaderName: string; exposureUsd: number }>()
    for (const row of leaderLedgers) {
      const current = leaderExposureMap.get(row.leaderId) ?? {
        leaderName: row.leaderName,
        exposureUsd: 0
      }
      const markPrice = priceByToken.get(row.tokenId) ?? 0
      current.exposureUsd += Math.abs(toNumber(row.shares) * markPrice)
      leaderExposureMap.set(row.leaderId, current)
    }

    const byLeaderTop = [...leaderExposureMap.entries()]
      .map(([leaderId, row]) => ({
        leaderId,
        leaderName: row.leaderName,
        exposureUsd: round(row.exposureUsd, 6)
      }))
      .sort((a, b) => b.exposureUsd - a.exposureUsd)
      .slice(0, 4)

    const byOutcomeSorted = [...sortedPositions]
      .map((row) => ({
        tokenId: row.tokenId,
        marketId: row.marketId,
        marketName: row.marketName,
        outcome: row.outcome,
        exposureUsd: Math.abs(row.currentValueUsd)
      }))
      .sort((a, b) => b.exposureUsd - a.exposureUsd)

    const topOutcomes = byOutcomeSorted.slice(0, 10).map((row) => ({
      ...row,
      isOther: false
    }))
    const otherExposure = byOutcomeSorted.slice(10).reduce((sum, row) => sum + row.exposureUsd, 0)
    if (otherExposure > 0) {
      topOutcomes.push({
        tokenId: 'OTHER',
        marketId: null,
        marketName: 'Other',
        outcome: 'Other',
        exposureUsd: otherExposure,
        isOther: true
      })
    }

    return jsonContract(
      PortfolioDataSchema,
      {
        copyProfileId: copyProfile.id,
        range,
        summary,
        chart: {
          points,
          pointCount: points.length,
          maxPoints: rangeConfig.maxPoints
        },
        exposureBreakdown: {
          byLeaderTop,
          byOutcomeTop: topOutcomes
        },
        positions: {
          items: pagedPositions,
          pagination: paginationMeta(pagination, totalPositions)
        }
      },
      {
        cacheSeconds: 15
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'PORTFOLIO_CONTRACT_FAILED', 'Portfolio response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'PORTFOLIO_FAILED', toErrorMessage(error))
  }
}

function rangeToConfig(range: z.infer<typeof RangeSchema>): { windowMs: number; maxPoints: number } {
  if (range === '1h') {
    return {
      windowMs: 60 * 60 * 1_000,
      maxPoints: 90
    }
  }
  if (range === '24h') {
    return {
      windowMs: 24 * 60 * 60 * 1_000,
      maxPoints: 180
    }
  }
  if (range === '1w') {
    return {
      windowMs: 7 * 24 * 60 * 60 * 1_000,
      maxPoints: 200
    }
  }
  return {
    windowMs: 30 * 24 * 60 * 60 * 1_000,
    maxPoints: 180
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function extractMarketNameFromPayload(payload: unknown): string | null {
  const obj = asObject(payload)
  const direct =
    readString(obj.marketTitle) ??
    readString(obj.marketName) ??
    readString(obj.title) ??
    readString(obj.slug)
  if (direct) {
    return direct
  }

  const raw = asObject(obj.raw)
  return (
    readString(raw.title) ??
    readString(raw.slug) ??
    null
  )
}

async function resolveMarketNamesByToken(tokenIds: string[]): Promise<Map<string, string>> {
  const uniqueTokenIds = [...new Set(tokenIds.map((tokenId) => tokenId.trim()).filter((tokenId) => tokenId.length > 0))]
  const names = new Map<string, string>()
  if (uniqueTokenIds.length === 0) {
    return names
  }
  const lookupTake = Math.max(200, uniqueTokenIds.length * 8)

  const leaderPositionRows = await prisma.leaderPositionSnapshot.findMany({
    where: {
      tokenId: {
        in: uniqueTokenIds
      }
    },
    orderBy: {
      snapshotAt: 'desc'
    },
    select: {
      tokenId: true,
      payload: true
    },
    take: lookupTake
  })

  for (const row of leaderPositionRows) {
    if (names.has(row.tokenId)) {
      continue
    }
    const name = extractMarketNameFromPayload(row.payload)
    if (name) {
      names.set(row.tokenId, name)
    }
  }

  const unresolved = uniqueTokenIds.filter((tokenId) => !names.has(tokenId))
  if (unresolved.length === 0) {
    return names
  }

  const leaderTradeRows = await prisma.leaderTradeEvent.findMany({
    where: {
      tokenId: {
        in: unresolved
      }
    },
    orderBy: {
      leaderFillAtMs: 'desc'
    },
    select: {
      tokenId: true,
      payload: true
    },
    take: lookupTake
  })

  for (const row of leaderTradeRows) {
    if (names.has(row.tokenId)) {
      continue
    }
    const name = extractMarketNameFromPayload(row.payload)
    if (name) {
      names.set(row.tokenId, name)
    }
  }

  return names
}
