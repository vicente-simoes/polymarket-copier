import { NextResponse } from 'next/server'
import { z } from 'zod'
import { webLogger } from '@/lib/server/logger'

export const API_VERSION = 'v1' as const
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200

export interface Pagination {
  page: number
  pageSize: number
  skip: number
}

export interface PaginationMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export function parsePagination(input: URL): Pagination {
  const page = clampInteger(parseNumber(input.searchParams.get('page'), 1), 1, 1_000_000)
  const pageSize = clampInteger(parseNumber(input.searchParams.get('pageSize'), DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE)
  const skip = (page - 1) * pageSize

  return {
    page,
    pageSize,
    skip
  }
}

export function paginationMeta(pagination: Pagination, total: number): PaginationMeta {
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pagination.pageSize))
  }
}

export function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export function parseNumber(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return parsed
}

export function parseBoolean(raw: string | null, fallback = false): boolean {
  if (raw === null) {
    return fallback
  }

  if (raw.toLowerCase() === 'true') {
    return true
  }

  if (raw.toLowerCase() === 'false') {
    return false
  }

  return fallback
}

export function toNumber(value: unknown): number {
  if (value === null || value === undefined) {
    return 0
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }

  if (typeof value === 'bigint') {
    return Number(value)
  }

  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const parsed = Number((value as { toString(): string }).toString())
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

export function toIso(value: Date | null | undefined): string | null {
  if (!value) {
    return null
  }

  return value.toISOString()
}

export function round(value: number, decimals = 8): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function normalizeAddress(input: string): string {
  return input.trim().toLowerCase()
}

export function parseLeaderProfileAddress(input: string): string | null {
  const raw = input.trim()
  if (raw.length === 0) {
    return null
  }

  if (isHexAddress(raw)) {
    return normalizeAddress(raw)
  }

  try {
    const url = new URL(raw)
    const pathname = url.pathname.replace(/\/+$/g, '')
    const lastSegment = pathname.split('/').filter((segment) => segment.length > 0).at(-1)
    if (lastSegment && isHexAddress(lastSegment)) {
      return normalizeAddress(lastSegment)
    }
  } catch {
    return null
  }

  return null
}

export function isHexAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value)
}

export function jsonContract<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  data: z.input<TSchema>,
  options?: {
    status?: number
    cacheSeconds?: number
  }
): NextResponse {
  const parsed = schema.parse(data)
  const payload = {
    apiVersion: API_VERSION,
    generatedAt: new Date().toISOString(),
    data: parsed
  }

  const headers = new Headers()
  if (options?.cacheSeconds && options.cacheSeconds > 0) {
    headers.set('Cache-Control', `public, s-maxage=${options.cacheSeconds}, stale-while-revalidate=${options.cacheSeconds}`)
  } else {
    headers.set('Cache-Control', 'no-store')
  }

  return NextResponse.json(payload, {
    status: options?.status ?? 200,
    headers
  })
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): NextResponse {
  const event = status >= 500 ? 'api.response_error' : 'api.response_warning'
  if (status >= 500) {
    webLogger.error(event, {
      status,
      code,
      message,
      details: details ?? {}
    })
  } else {
    webLogger.warn(event, {
      status,
      code,
      message,
      details: details ?? {}
    })
  }

  return NextResponse.json(
    {
      apiVersion: API_VERSION,
      generatedAt: new Date().toISOString(),
      error: {
        code,
        message,
        details: details ?? {}
      }
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  )
}
