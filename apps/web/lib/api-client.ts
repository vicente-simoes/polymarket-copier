export interface ApiEnvelope<TData> {
  apiVersion: string
  generatedAt: string
  data: TData
}

export interface ApiErrorEnvelope {
  apiVersion: string
  generatedAt: string
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
  }
}

export class ApiClientError extends Error {
  status: number
  code: string | null
  details: Record<string, unknown> | undefined

  constructor(message: string, status: number, code: string | null, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isApiEnvelope<TData>(value: unknown): value is ApiEnvelope<TData> {
  if (!isObject(value)) {
    return false
  }

  return typeof value.generatedAt === 'string' && 'data' in value
}

function isApiErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!isObject(value)) {
    return false
  }

  if (!isObject(value.error)) {
    return false
  }

  return typeof value.generatedAt === 'string' && typeof value.error.message === 'string'
}

export async function fetchApi<TData>(input: string, init?: RequestInit): Promise<ApiEnvelope<TData>> {
  const response = await fetch(input, {
    ...init,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {})
    }
  })

  const payload = (await response.json()) as unknown

  if (!response.ok) {
    const errorPayload = isApiErrorEnvelope(payload) ? payload : null
    const message = errorPayload?.error?.message ?? `Request failed with status ${response.status}`
    const code = errorPayload?.error?.code ?? null
    const details = errorPayload?.error?.details

    throw new ApiClientError(message, response.status, code, details)
  }

  if (!isApiEnvelope<TData>(payload)) {
    throw new ApiClientError('Missing API response fields.', response.status, null)
  }

  return payload
}
