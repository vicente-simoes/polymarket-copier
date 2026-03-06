import { memoizeAsync } from './memo'

export interface WorkerHealthSnapshot {
  status: string
  now?: string
  startedAt?: string
  lastHeartbeatAt?: string
  marketData?: Record<string, unknown>
  leaderIngestion?: Record<string, unknown>
  chainTriggers?: Record<string, unknown>
  targetNetting?: Record<string, unknown>
  execution?: Record<string, unknown>
  userChannel?: Record<string, unknown>
  fillReconcile?: Record<string, unknown>
  reconcile?: Record<string, unknown>
}

export interface WorkerMarketBookSnapshot {
  tokenId: string
  bestBid?: number
  bestAsk?: number
  isStale?: boolean
  priceSource?: string
  quoteUpdatedAtMs?: number
  spreadUsd?: number
  spreadState?: 'LIVE' | 'STALE' | 'UNAVAILABLE'
  wsConnected?: boolean
}

const DEFAULT_WORKER_HEALTH_BASES = ['http://worker:4001', 'http://127.0.0.1:4001', 'http://localhost:4001']

export async function fetchWorkerHealth(timeoutMs = 1_500): Promise<WorkerHealthSnapshot | null> {
  return memoizeAsync(`worker-health:${timeoutMs}:${process.env.WORKER_HEALTH_BASE_URL ?? ''}`, 1_000, async () => {
    const configured = parseHealthBaseUrls(process.env.WORKER_HEALTH_BASE_URL)
    const candidates = configured.length > 0 ? configured : DEFAULT_WORKER_HEALTH_BASES

    for (const baseUrl of candidates) {
      const normalizedBase = baseUrl.replace(/\/+$/g, '')
      const healthUrl = `${normalizedBase}/health`

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store'
        })
        if (!response.ok) {
          continue
        }

        const parsed = (await response.json()) as WorkerHealthSnapshot
        if (!parsed || typeof parsed !== 'object') {
          continue
        }

        return parsed
      } catch {
        continue
      }
    }

    return null
  })
}

export async function fetchWorkerMarketBooks(
  tokenIds: string[],
  timeoutMs = 1_500
): Promise<WorkerMarketBookSnapshot[] | null> {
  const uniqueTokenIds = [...new Set(tokenIds.map((value) => value.trim()).filter((value) => value.length > 0))]
  if (uniqueTokenIds.length === 0) {
    return []
  }

  return memoizeAsync(
    `worker-books:${timeoutMs}:${process.env.WORKER_HEALTH_BASE_URL ?? ''}:${uniqueTokenIds.join(',')}`,
    1_000,
    async () => {
      const configured = parseHealthBaseUrls(process.env.WORKER_HEALTH_BASE_URL)
      const candidates = configured.length > 0 ? configured : DEFAULT_WORKER_HEALTH_BASES
      const tokenQuery = encodeURIComponent(uniqueTokenIds.join(','))

      for (const baseUrl of candidates) {
        const normalizedBase = baseUrl.replace(/\/+$/g, '')
        const booksUrl = `${normalizedBase}/market/books?token_ids=${tokenQuery}`

        try {
          const response = await fetch(booksUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(timeoutMs),
            cache: 'no-store'
          })
          if (!response.ok) {
            continue
          }

          const parsed = (await response.json()) as { books?: unknown }
          if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.books)) {
            continue
          }

          const books: WorkerMarketBookSnapshot[] = []
          for (const rawBook of parsed.books) {
            const record = asObject(rawBook)
            const tokenId = readString(record, 'tokenId')
            if (!tokenId) {
              continue
            }

            books.push({
              tokenId,
              bestBid: readNumber(record, 'bestBid'),
              bestAsk: readNumber(record, 'bestAsk'),
              isStale: readBoolean(record, 'isStale'),
              priceSource: readString(record, 'priceSource'),
              quoteUpdatedAtMs: readNumber(record, 'quoteUpdatedAtMs'),
              spreadUsd: readNumber(record, 'spreadUsd'),
              spreadState: readSpreadState(record, 'spreadState'),
              wsConnected: readBoolean(record, 'wsConnected')
            })
          }

          return books
        } catch {
          continue
        }
      }

      return null
    }
  )
}

function parseHealthBaseUrls(raw: string | undefined): string[] {
  if (!raw) {
    return []
  }

  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
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

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return value
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key]
  return typeof value === 'boolean' ? value : undefined
}

function readSpreadState(
  record: Record<string, unknown>,
  key: string
): 'LIVE' | 'STALE' | 'UNAVAILABLE' | undefined {
  const value = record[key]
  return value === 'LIVE' || value === 'STALE' || value === 'UNAVAILABLE' ? value : undefined
}
