function appendIfPresent(params: URLSearchParams, key: string, value: string | null | undefined): void {
  if (value === null || value === undefined) {
    return
  }
  const normalized = value.trim()
  if (normalized.length === 0) {
    return
  }
  params.set(key, normalized)
}

function asPage(value: number): number {
  const parsed = Math.trunc(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1
  }
  return parsed
}

function asPageSize(value?: number): number {
  if (value === undefined) {
    return 50
  }
  const parsed = Math.trunc(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 50
  }
  return parsed
}

export function buildLeadersQuery(args: {
  page: number
  pageSize?: number
  search?: string
  status?: 'ALL' | 'ACTIVE' | 'PAUSED' | 'DISABLED'
}): string {
  const params = new URLSearchParams()
  params.set('page', String(asPage(args.page)))
  params.set('pageSize', String(asPageSize(args.pageSize)))
  appendIfPresent(params, 'search', args.search)
  if (args.status && args.status !== 'ALL') {
    params.set('status', args.status)
  }
  return `/api/v1/leaders?${params.toString()}`
}

export function buildTradesQuery(args: {
  page: number
  pageSize?: number
  leaderId?: string
  source?: 'ALL' | 'CHAIN' | 'DATA_API'
  search?: string
}): string {
  const params = new URLSearchParams()
  params.set('page', String(asPage(args.page)))
  params.set('pageSize', String(asPageSize(args.pageSize)))
  appendIfPresent(params, 'leaderId', args.leaderId)
  if (args.source && args.source !== 'ALL') {
    params.set('source', args.source)
  }
  appendIfPresent(params, 'search', args.search)
  return `/api/v1/trades?${params.toString()}`
}

export function buildCopiesQuery(args: {
  section: 'open' | 'attempting' | 'executions' | 'skipped'
  page: number
  pageSize?: number
  tokenId?: string | null
}): string {
  const params = new URLSearchParams()
  params.set('section', args.section)
  params.set('page', String(asPage(args.page)))
  params.set('pageSize', String(asPageSize(args.pageSize)))
  if (args.section === 'skipped') {
    appendIfPresent(params, 'tokenId', args.tokenId ?? undefined)
  }
  return `/api/v1/copies?${params.toString()}`
}

export function buildPortfolioQuery(args: {
  range: '1h' | '24h' | '1w' | '1m'
  page: number
  pageSize?: number
}): string {
  const params = new URLSearchParams()
  params.set('range', args.range)
  params.set('page', String(asPage(args.page)))
  params.set('pageSize', String(asPageSize(args.pageSize)))
  return `/api/v1/portfolio?${params.toString()}`
}
