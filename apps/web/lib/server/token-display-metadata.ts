import { Prisma } from '@copybot/db'
import {
  extractTokenDisplayMetadataFromPayload,
  mergeTokenDisplayMetadata,
  toTokenDisplayMetadataView,
  type TokenDisplayMetadataObservation,
  type TokenDisplayMetadataRecord,
  type TokenDisplayMetadataView
} from '@copybot/shared'
import { prisma } from '@/lib/server/db'
import { webLogger } from '@/lib/server/logger'

type MetadataHistoryRow = {
  tokenId: string
  marketId: string | null
  outcome: string | null
  payload: Prisma.JsonValue | null
  observedAt: Date
}

export async function resolveTokenDisplayMetadata(tokenIds: string[]): Promise<Map<string, TokenDisplayMetadataView>> {
  const uniqueTokenIds = [...new Set(tokenIds.map((tokenId) => tokenId.trim()).filter((tokenId) => tokenId.length > 0))]
  if (uniqueTokenIds.length === 0) {
    return new Map()
  }

  const rows: Array<{
    tokenId: string
    marketId: string | null
    title: string | null
    slug: string | null
    eventSlug: string | null
    outcome: string | null
  }> = await prisma.tokenMetadata.findMany({
    where: {
      tokenId: {
        in: uniqueTokenIds
      }
    },
    select: {
      tokenId: true,
      marketId: true,
      title: true,
      slug: true,
      eventSlug: true,
      outcome: true
    }
  })

  const resolved = new Map<string, TokenDisplayMetadataView>(
    rows.map((row) => [
      row.tokenId,
      toTokenDisplayMetadataView({
        marketId: row.marketId,
        title: row.title,
        slug: row.slug,
        eventSlug: row.eventSlug,
        outcome: row.outcome
      })
    ])
  )

  const missingTokenIds = uniqueTokenIds.filter((tokenId) => !resolved.has(tokenId))
  if (missingTokenIds.length === 0) {
    return resolved
  }

  const fallbackRecords = await resolveFallbackTokenMetadataRecords(missingTokenIds)
  for (const [tokenId, record] of fallbackRecords) {
    resolved.set(tokenId, toTokenDisplayMetadataView(record))
  }

  webLogger.info('token_metadata.fallback_used', {
    requestedTokenCount: uniqueTokenIds.length,
    missingTokenCount: missingTokenIds.length,
    recoveredTokenCount: fallbackRecords.size,
    unresolvedTokenCount: missingTokenIds.filter((tokenId) => !fallbackRecords.has(tokenId)).length
  })

  return resolved
}

async function resolveFallbackTokenMetadataRecords(tokenIds: string[]): Promise<Map<string, TokenDisplayMetadataRecord>> {
  const [leaderPositionRows, leaderTradeRows, followerPositionRows] = await Promise.all([
    loadFallbackRows('LeaderPositionSnapshot', 'snapshotAt', tokenIds),
    loadFallbackRows('LeaderTradeEvent', 'leaderFillAtMs', tokenIds),
    loadFallbackRows('FollowerPositionSnapshot', 'snapshotAt', tokenIds)
  ])

  const records = new Map<string, TokenDisplayMetadataRecord>()
  for (const row of leaderPositionRows) {
    applyFallbackRow(records, row)
  }
  for (const row of leaderTradeRows) {
    applyFallbackRow(records, row)
  }
  for (const row of followerPositionRows) {
    applyFallbackRow(records, row)
  }

  return records
}

async function loadFallbackRows(
  tableName: 'LeaderPositionSnapshot' | 'LeaderTradeEvent' | 'FollowerPositionSnapshot',
  observedAtColumn: 'snapshotAt' | 'leaderFillAtMs',
  tokenIds: string[]
): Promise<MetadataHistoryRow[]> {
  if (tokenIds.length === 0) {
    return []
  }

  if (observedAtColumn === 'leaderFillAtMs') {
    return prisma.$queryRaw<MetadataHistoryRow[]>(
      Prisma.sql`
        SELECT DISTINCT ON ("tokenId")
          "tokenId",
          "marketId",
          "outcome",
          "payload",
          to_timestamp(("leaderFillAtMs"::double precision) / 1000.0) AS "observedAt"
        FROM "LeaderTradeEvent"
        WHERE "tokenId" IN (${Prisma.join(tokenIds)})
        ORDER BY "tokenId" ASC, "leaderFillAtMs" DESC
      `
    )
  }

  if (tableName === 'LeaderPositionSnapshot') {
    return prisma.$queryRaw<MetadataHistoryRow[]>(
      Prisma.sql`
        SELECT DISTINCT ON ("tokenId")
          "tokenId",
          "marketId",
          "outcome",
          "payload",
          "snapshotAt" AS "observedAt"
        FROM "LeaderPositionSnapshot"
        WHERE "tokenId" IN (${Prisma.join(tokenIds)})
        ORDER BY "tokenId" ASC, "snapshotAt" DESC
      `
    )
  }

  return prisma.$queryRaw<MetadataHistoryRow[]>(
    Prisma.sql`
      SELECT DISTINCT ON ("tokenId")
        "tokenId",
        "marketId",
        "outcome",
        "payload",
        "snapshotAt" AS "observedAt"
      FROM "FollowerPositionSnapshot"
      WHERE "tokenId" IN (${Prisma.join(tokenIds)})
      ORDER BY "tokenId" ASC, "snapshotAt" DESC
    `
  )
}

function applyFallbackRow(records: Map<string, TokenDisplayMetadataRecord>, row: MetadataHistoryRow) {
  const observation = buildObservationFromRow(row)
  if (!observation) {
    return
  }

  const current = records.get(observation.tokenId) ?? null
  const merged = mergeTokenDisplayMetadata(current, observation)
  records.set(observation.tokenId, merged)
}

function buildObservationFromRow(row: MetadataHistoryRow): TokenDisplayMetadataObservation | null {
  const tokenId = row.tokenId.trim()
  if (tokenId.length === 0) {
    return null
  }

  const payloadMetadata = extractTokenDisplayMetadataFromPayload(row.payload)
  return {
    tokenId,
    marketId: row.marketId ?? payloadMetadata.marketId ?? null,
    title: payloadMetadata.title ?? null,
    slug: payloadMetadata.slug ?? null,
    eventSlug: payloadMetadata.eventSlug ?? null,
    outcome: row.outcome ?? payloadMetadata.outcome ?? null,
    firstSeenAt: row.observedAt,
    lastSeenAt: row.observedAt
  }
}
