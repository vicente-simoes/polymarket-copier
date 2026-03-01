import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, paginationMeta, parsePagination, toNumber } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'

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

    const tokenMetadata = await resolveTradeTokenMetadata(rows.map((row) => row.tokenId))

    return jsonContract(
      TradesDataSchema,
      {
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
      },
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

type TokenMetadata = {
  marketId: string | null
  marketLabel: string | null
  marketSlug: string | null
  outcome: string | null
}

async function resolveTradeTokenMetadata(tokenIds: string[]): Promise<Map<string, TokenMetadata>> {
  const uniqueTokenIds = [...new Set(tokenIds.filter((value) => value.length > 0))]
  if (uniqueTokenIds.length === 0) {
    return new Map()
  }

  const metadata = new Map<string, TokenMetadata>()

  const [tradeRows, leaderPositionRows, followerPositionRows] = await Promise.all([
    prisma.leaderTradeEvent.findMany({
      where: {
        tokenId: { in: uniqueTokenIds }
      },
      orderBy: {
        detectedAtMs: 'desc'
      },
      select: {
        tokenId: true,
        marketId: true,
        outcome: true,
        payload: true
      },
      take: Math.max(200, uniqueTokenIds.length * 8)
    }),
    prisma.leaderPositionSnapshot.findMany({
      where: {
        tokenId: { in: uniqueTokenIds }
      },
      orderBy: {
        snapshotAt: 'desc'
      },
      select: {
        tokenId: true,
        marketId: true,
        outcome: true,
        payload: true
      },
      take: Math.max(200, uniqueTokenIds.length * 8)
    }),
    prisma.followerPositionSnapshot.findMany({
      where: {
        tokenId: { in: uniqueTokenIds }
      },
      orderBy: {
        snapshotAt: 'desc'
      },
      select: {
        tokenId: true,
        marketId: true,
        outcome: true,
        payload: true
      },
      take: Math.max(200, uniqueTokenIds.length * 8)
    })
  ])

  const applyRow = (row: { tokenId: string; marketId: string | null; outcome: string | null; payload: unknown }) => {
    const current = metadata.get(row.tokenId) ?? {
      marketId: null,
      marketLabel: null,
      marketSlug: null,
      outcome: null
    }

    const payloadInfo = extractMarketMetadataFromPayload(row.payload)
    const next: TokenMetadata = {
      marketId: current.marketId ?? row.marketId ?? payloadInfo.marketId ?? null,
      marketLabel: current.marketLabel ?? payloadInfo.marketLabel ?? null,
      marketSlug: choosePreferredMarketSlug(current.marketSlug, payloadInfo.marketSlug) ?? null,
      outcome: current.outcome ?? row.outcome ?? payloadInfo.outcome ?? null
    }

    if (next.marketId || next.marketLabel || next.outcome) {
      metadata.set(row.tokenId, next)
    }
  }

  for (const row of tradeRows) {
    applyRow(row)
  }
  for (const row of leaderPositionRows) {
    applyRow(row)
  }
  for (const row of followerPositionRows) {
    applyRow(row)
  }

  return metadata
}

function extractMarketMetadataFromPayload(payload: unknown): Partial<TokenMetadata> {
  const root = asObject(payload)
  const raw = asObject(root.raw)

  const title = readString(raw, 'title')
  const slug = readString(raw, 'slug')
  const eventSlug = readString(raw, 'eventSlug')
  const marketSlug = buildPolymarketEventPath(eventSlug, slug)
  const marketId = readString(raw, 'conditionId') ?? readString(raw, 'market')
  const outcome = readString(raw, 'outcome')

  return {
    marketId: marketId ?? null,
    marketLabel: title ?? slug ?? eventSlug ?? null,
    marketSlug: marketSlug ?? null,
    outcome: outcome ?? null
  }
}

function buildPolymarketEventPath(eventSlug: string | undefined, marketSlug: string | undefined): string | undefined {
  const normalizedEvent = normalizeSlugSegment(eventSlug)
  const normalizedMarket = normalizeSlugSegment(marketSlug)

  if (normalizedEvent && normalizedMarket && normalizedEvent !== normalizedMarket) {
    return `${normalizedEvent}/${normalizedMarket}`
  }

  return normalizedMarket ?? normalizedEvent
}

function normalizeSlugSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  return normalized.length > 0 ? normalized : undefined
}

function choosePreferredMarketSlug(
  currentSlug: string | null | undefined,
  nextSlug: string | null | undefined
): string | undefined {
  const normalizedCurrent = normalizeSlugSegment(currentSlug ?? undefined)
  const normalizedNext = normalizeSlugSegment(nextSlug ?? undefined)

  if (!normalizedCurrent) {
    return normalizedNext
  }
  if (!normalizedNext) {
    return normalizedCurrent
  }
  if (!normalizedCurrent.includes('/') && normalizedNext.includes('/')) {
    return normalizedNext
  }
  return normalizedCurrent
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
