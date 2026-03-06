import { Prisma } from '@prisma/client'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, toIso, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'
import { memoizeAsync } from '@/lib/server/memo'
import { resolveTokenDisplayMetadata } from '@/lib/server/token-display-metadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface FollowerCurrentPositionRow {
  tokenId: string
  marketId: string | null
  outcome: string | null
  shares: Prisma.Decimal
  currentPrice: Prisma.Decimal | null
  costBasisUsd: Prisma.Decimal | null
  currentValueUsd: Prisma.Decimal | null
}

const PositionDetailDataSchema = z.object({
  position: z
    .object({
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
    .nullable(),
  executions: z.array(
    z.object({
      id: z.string(),
      attemptedAt: z.string(),
      leaderName: z.string().nullable(),
      side: z.enum(['BUY', 'SELL']),
      status: z.enum(['PLACED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED', 'RETRYING']),
      intendedNotionalUsd: z.number(),
      reason: z.string().nullable(),
      errorMessage: z.string().nullable(),
      accumulatedDeltaNotionalUsd: z.number().nullable()
    })
  ),
  openAttempts: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      leaderName: z.string().nullable(),
      side: z.enum(['BUY', 'SELL']),
      status: z.enum(['PENDING', 'ELIGIBLE', 'BLOCKED', 'EXPIRED', 'CONVERTED']),
      blockReason: z.string().nullable(),
      pendingNotionalUsd: z.number()
    })
  ),
  skippedAttempts: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      leaderName: z.string().nullable(),
      side: z.enum(['BUY', 'SELL']),
      reason: z.string().nullable(),
      accumulatedDeltaNotionalUsd: z.number()
    })
  )
})

export async function GET(_request: NextRequest, context: { params: Promise<{ tokenId: string }> }) {
  try {
    const params = await context.params
    const data = await memoizeAsync(`route:portfolio-position-detail:${params.tokenId}`, 3_000, () =>
      buildPositionDetailData(params.tokenId)
    )

    return jsonContract(PositionDetailDataSchema, data, {
      cacheSeconds: 5
    })
  } catch (error) {
    return jsonError(500, 'PORTFOLIO_POSITION_DETAIL_FAILED', toErrorMessage(error))
  }
}

async function buildPositionDetailData(tokenId: string): Promise<z.input<typeof PositionDetailDataSchema>> {
  const copyProfile = await prisma.copyProfile.findFirst({
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
    return {
      position: null,
      executions: [],
      openAttempts: [],
      skippedAttempts: []
    }
  }

  const [positionRow, executionRows, openRows, skippedRows] = await Promise.all([
    prisma
      .$queryRaw<FollowerCurrentPositionRow[]>(
        Prisma.sql`
          SELECT
            "tokenId",
            "marketId",
            "outcome",
            "shares",
            "currentPrice",
            "costBasisUsd",
            "currentValueUsd"
          FROM "FollowerCurrentPosition"
          WHERE "copyProfileId" = ${copyProfile.id}
            AND "tokenId" = ${tokenId}
          LIMIT 1
        `
      )
      .then((rows) => rows[0] ?? null),
    prisma.copyOrder.findMany({
      where: {
        tokenId,
        externalOrderId: {
          not: null
        }
      },
      orderBy: {
        attemptedAt: 'desc'
      },
      take: 50,
      select: {
        id: true,
        attemptedAt: true,
        side: true,
        status: true,
        intendedNotionalUsd: true,
        errorMessage: true,
        copyAttempt: {
          select: {
            reason: true,
            accumulatedDeltaNotionalUsd: true,
            leader: {
              select: {
                name: true
              }
            }
          }
        }
      }
    }),
    prisma.pendingDelta.findMany({
      where: {
        copyProfileId: copyProfile.id,
        tokenId,
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
        ]
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        side: true,
        status: true,
        blockReason: true,
        pendingDeltaNotionalUsd: true,
        leader: {
          select: {
            name: true
          }
        }
      }
    }),
    prisma.copyAttempt.findMany({
      where: {
        tokenId,
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
      take: 50,
      select: {
        id: true,
        createdAt: true,
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

  const metadata = await resolveTokenDisplayMetadata([tokenId])
  const token = metadata.get(tokenId)

  return {
    position: positionRow
      ? {
          tokenId: positionRow.tokenId,
          marketId: positionRow.marketId ?? token?.marketId ?? null,
          marketName: token?.marketLabel ?? null,
          outcome: positionRow.outcome ?? token?.outcome ?? null,
          shares: toNumber(positionRow.shares),
          currentPrice: toNumber(positionRow.currentPrice),
          costBasisUsd: toNumber(positionRow.costBasisUsd),
          currentValueUsd:
            toNumber(positionRow.currentValueUsd) || toNumber(positionRow.shares) * toNumber(positionRow.currentPrice),
          unrealizedPnlUsd:
            (toNumber(positionRow.currentValueUsd) || toNumber(positionRow.shares) * toNumber(positionRow.currentPrice)) -
            toNumber(positionRow.costBasisUsd)
        }
      : null,
    executions: executionRows.map((row) => ({
      id: row.id,
      attemptedAt: row.attemptedAt.toISOString(),
      leaderName: row.copyAttempt?.leader?.name ?? null,
      side: row.side,
      status: row.status,
      intendedNotionalUsd: toNumber(row.intendedNotionalUsd),
      reason: row.copyAttempt?.reason ?? null,
      errorMessage: normalizeOrderErrorMessage(row.errorMessage),
      accumulatedDeltaNotionalUsd:
        row.copyAttempt?.accumulatedDeltaNotionalUsd !== null && row.copyAttempt?.accumulatedDeltaNotionalUsd !== undefined
          ? toNumber(row.copyAttempt.accumulatedDeltaNotionalUsd)
          : null
    })),
    openAttempts: openRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      leaderName: row.leader?.name ?? null,
      side: row.side,
      status: row.status,
      blockReason: row.blockReason,
      pendingNotionalUsd: toNumber(row.pendingDeltaNotionalUsd)
    })),
    skippedAttempts: skippedRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      leaderName: row.leader?.name ?? null,
      side: row.side,
      reason: row.reason,
      accumulatedDeltaNotionalUsd: toNumber(row.accumulatedDeltaNotionalUsd)
    }))
  }
}

function normalizeOrderErrorMessage(errorMessage: string | null | undefined): string | null {
  if (!errorMessage) {
    return null
  }

  const trimmed = errorMessage.trim()
  if (trimmed.length === 0) {
    return null
  }

  return trimmed.replace(/^CLOB order submit failed:\s*/i, '').replace(/^Error:\s*/i, '').trim()
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
