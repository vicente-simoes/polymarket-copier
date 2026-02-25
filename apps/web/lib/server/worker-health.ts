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
  reconcile?: Record<string, unknown>
}

const DEFAULT_WORKER_HEALTH_BASES = ['http://worker:4001', 'http://localhost:4001']

export async function fetchWorkerHealth(timeoutMs = 1_500): Promise<WorkerHealthSnapshot | null> {
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
