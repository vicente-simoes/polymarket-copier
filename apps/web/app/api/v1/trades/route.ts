import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, paginationMeta, parsePagination, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'
import { memoizeAsync } from '@/lib/server/memo'
import { resolveTokenDisplayMetadata } from '@/lib/server/token-display-metadata'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SourceSchema = z.enum(['CHAIN', 'DATA_API'])
const BACKFILL_DETECT_LAG_THRESHOLD_MS = 5 * 60 * 1000

const TradesDataSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      leaderId: z.string(),
      leaderName: z.string(),
      leaderFillAtMs: z.string(),
      wsReceivedAtMs: z.string().nullable(),
      detectedAtMs: z.string(),
      detectLagMs: z.number().int().nonnegative(),
      isBackfill: z.boolean(),
      wsLagMs: z.number().int().nonnegative().nullable(),
      marketId: z.string().nullable(),
      marketLabel: z.string().nullable(),
      marketSlug: z.string().nullable(),
      tokenId: z.string(),
      outcome: z.string().nullable(),
      side: z.enum(['BUY', 'SELL']),
      shares: z.number(),
      price: z.number(),
      notionalUsd: z.number(),
      source: SourceSchema,
      sourceLabel: z.enum(['WebSocket', 'REST fallback API'])
    })
  ),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive()
  })
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const data = await memoizeAsync(`route:trades:${url.searchParams.toString()}`, 5_000, () => buildTradesData(url))

    return jsonContract(
      TradesDataSchema,
      data,
      {
        cacheSeconds: 10
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'TRADES_CONTRACT_FAILED', 'Trades response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'TRADES_FAILED', toErrorMessage(error))
  }
}

async function buildTradesData(url: URL): Promise<z.input<typeof TradesDataSchema>> {
  const pagination = parsePagination(url)
  const search = url.searchParams.get('search')?.trim() ?? ''
  const leaderId = url.searchParams.get('leaderId')?.trim()
  const source = SourceSchema.safeParse(url.searchParams.get('source')).success
    ? (url.searchParams.get('source') as z.infer<typeof SourceSchema>)
    : undefined

  const where = {
    ...(leaderId ? { leaderId } : {}),
    ...(source ? { source } : {}),
    ...(search.length > 0
      ? {
          OR: [
            {
              tokenId: {
                contains: search,
                mode: 'insensitive' as const
              }
            },
            {
              marketId: {
                contains: search,
                mode: 'insensitive' as const
              }
            },
            {
              outcome: {
                contains: search,
                mode: 'insensitive' as const
              }
            },
            {
              leader: {
                name: {
                  contains: search,
                  mode: 'insensitive' as const
                }
              }
            }
          ]
        }
      : {})
  }

  const [total, rows] = await Promise.all([
    prisma.leaderTradeEvent.count({
      where
    }),
    prisma.leaderTradeEvent.findMany({
      where,
      orderBy: {
        leaderFillAtMs: 'desc'
      },
      skip: pagination.skip,
      take: pagination.pageSize,
      select: {
        id: true,
        leaderId: true,
        leaderFillAtMs: true,
        wsReceivedAtMs: true,
        detectedAtMs: true,
        marketId: true,
        tokenId: true,
        outcome: true,
        payload: true,
        side: true,
        shares: true,
        price: true,
        notionalUsd: true,
        source: true,
        leader: {
          select: {
            name: true
          }
        }
      }
    })
  ])

  const tokenMetadata = await resolveTokenDisplayMetadata(rows.map((row) => row.tokenId))

  return {
    items: rows.map((row) => {
      const leaderFillAtMs = Number(row.leaderFillAtMs)
      const detectedAtMs = Number(row.detectedAtMs)
      const wsReceivedAtMs = row.wsReceivedAtMs ? Number(row.wsReceivedAtMs) : null
      const detectLagMs = Math.max(0, detectedAtMs - leaderFillAtMs)
      const isBackfill = row.source === 'DATA_API' && detectLagMs >= BACKFILL_DETECT_LAG_THRESHOLD_MS

      return {
        id: row.id,
        leaderId: row.leaderId,
        leaderName: row.leader.name,
        leaderFillAtMs: String(leaderFillAtMs),
        wsReceivedAtMs: wsReceivedAtMs !== null ? String(wsReceivedAtMs) : null,
        detectedAtMs: String(detectedAtMs),
        detectLagMs,
        isBackfill,
        wsLagMs: wsReceivedAtMs !== null ? Math.max(0, wsReceivedAtMs - leaderFillAtMs) : null,
        marketId: row.marketId ?? tokenMetadata.get(row.tokenId)?.marketId ?? null,
        marketLabel: tokenMetadata.get(row.tokenId)?.marketLabel ?? null,
        marketSlug: tokenMetadata.get(row.tokenId)?.marketSlug ?? null,
        tokenId: row.tokenId,
        outcome: row.outcome ?? tokenMetadata.get(row.tokenId)?.outcome ?? null,
        side: row.side,
        shares: toNumber(row.shares),
        price: toNumber(row.price),
        notionalUsd: toNumber(row.notionalUsd),
        source: row.source,
        sourceLabel: row.source === 'CHAIN' ? ('WebSocket' as const) : ('REST fallback API' as const)
      }
    }),
    pagination: paginationMeta(pagination, total)
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
