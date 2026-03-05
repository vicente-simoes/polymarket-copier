export interface TokenDisplayMetadataObservation {
  tokenId: string
  marketId?: string | null
  title?: string | null
  slug?: string | null
  eventSlug?: string | null
  outcome?: string | null
  firstSeenAt?: Date | null
  lastSeenAt: Date
}

export interface TokenDisplayMetadataRecord {
  tokenId: string
  marketId: string | null
  title: string | null
  slug: string | null
  eventSlug: string | null
  outcome: string | null
  firstSeenAt: Date
  lastSeenAt: Date
}

export interface TokenDisplayMetadataView {
  marketId: string | null
  marketLabel: string | null
  marketSlug: string | null
  outcome: string | null
}

interface NormalizedTokenDisplayMetadataObservation {
  tokenId: string
  marketId: string | null
  title: string | null
  slug: string | null
  eventSlug: string | null
  outcome: string | null
  firstSeenAt: Date | null
  lastSeenAt: Date
}

export function extractTokenDisplayMetadataFromPayload(
  payload: unknown
): Partial<Omit<TokenDisplayMetadataObservation, 'tokenId' | 'lastSeenAt'>> {
  const root = asObject(payload)
  const raw = asObject(root.raw)
  const record = Object.keys(raw).length > 0 ? raw : root

  return {
    marketId:
      readString(record, 'conditionId') ??
      readString(record, 'market') ??
      readString(root, 'marketId') ??
      null,
    title:
      readString(record, 'title') ??
      readString(root, 'marketTitle') ??
      readString(root, 'marketName') ??
      null,
    slug: readString(record, 'slug') ?? null,
    eventSlug: readString(record, 'eventSlug') ?? null,
    outcome:
      readString(record, 'outcome') ??
      readString(root, 'outcome') ??
      null
  }
}

export function buildPolymarketMarketPath(
  eventSlug?: string | null,
  slug?: string | null
): string | null {
  const normalizedEvent = normalizeSlugSegment(eventSlug)
  const normalizedSlug = normalizeSlugSegment(slug)

  if (normalizedEvent && normalizedSlug && normalizedEvent !== normalizedSlug) {
    return `${normalizedEvent}/${normalizedSlug}`
  }

  return normalizedSlug ?? normalizedEvent ?? null
}

export function toTokenDisplayMetadataView(
  record: Pick<TokenDisplayMetadataRecord, 'marketId' | 'title' | 'slug' | 'eventSlug' | 'outcome'>
): TokenDisplayMetadataView {
  return {
    marketId: record.marketId ?? null,
    marketLabel: record.title ?? record.slug ?? record.eventSlug ?? null,
    marketSlug: buildPolymarketMarketPath(record.eventSlug, record.slug),
    outcome: record.outcome ?? null
  }
}

export function mergeTokenDisplayMetadata(
  existing: TokenDisplayMetadataRecord | null,
  incoming: TokenDisplayMetadataObservation
): TokenDisplayMetadataRecord {
  const normalizedIncoming = normalizeObservation(incoming)
  if (!existing) {
    return {
      tokenId: normalizedIncoming.tokenId,
      marketId: normalizedIncoming.marketId,
      title: normalizedIncoming.title,
      slug: normalizedIncoming.slug,
      eventSlug: normalizedIncoming.eventSlug,
      outcome: normalizedIncoming.outcome,
      firstSeenAt: normalizedIncoming.firstSeenAt ?? normalizedIncoming.lastSeenAt,
      lastSeenAt: normalizedIncoming.lastSeenAt
    }
  }

  const firstSeenAt = normalizedIncoming.firstSeenAt ?? normalizedIncoming.lastSeenAt
  return {
    tokenId: existing.tokenId,
    marketId: existing.marketId ?? normalizedIncoming.marketId,
    title: existing.title ?? normalizedIncoming.title,
    slug: existing.slug ?? normalizedIncoming.slug,
    eventSlug: existing.eventSlug ?? normalizedIncoming.eventSlug,
    outcome: existing.outcome ?? normalizedIncoming.outcome,
    firstSeenAt: existing.firstSeenAt.getTime() <= firstSeenAt.getTime() ? existing.firstSeenAt : firstSeenAt,
    lastSeenAt:
      existing.lastSeenAt.getTime() >= normalizedIncoming.lastSeenAt.getTime()
        ? existing.lastSeenAt
        : normalizedIncoming.lastSeenAt
  }
}

function normalizeObservation(
  observation: TokenDisplayMetadataObservation
): NormalizedTokenDisplayMetadataObservation {
  return {
    tokenId: observation.tokenId.trim(),
    marketId: normalizeOptionalString(observation.marketId),
    title: normalizeOptionalString(observation.title),
    slug: normalizeOptionalString(observation.slug),
    eventSlug: normalizeOptionalString(observation.eventSlug),
    outcome: normalizeOptionalString(observation.outcome),
    firstSeenAt: observation.firstSeenAt ?? null,
    lastSeenAt: observation.lastSeenAt
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function readString(record: Record<string, unknown>, key: string): string | null {
  return normalizeOptionalString(record[key])
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function normalizeSlugSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  return normalized.length > 0 ? normalized : null
}
