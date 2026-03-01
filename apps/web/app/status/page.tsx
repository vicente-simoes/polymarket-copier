'use client'

import { useState } from 'react'
import { AlertTriangle, Database, Radio, Server, Shield } from 'lucide-react'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { StatusPill } from '@/components/dashboard/status-pill'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime, formatLatencyMs, formatNumber } from '@/lib/format'

interface StatusData {
  cards: {
    worker: {
      status: 'OK' | 'DOWN' | 'UNKNOWN'
      lastUpdatedAt: string | null
      lastEventAt: string | null
    }
    database: {
      status: 'OK' | 'DOWN' | 'UNKNOWN'
      lastUpdatedAt: string | null
      latencyMs: number | null
      sizeBytes: number | null
    }
    redis: {
      status: 'OK' | 'DOWN' | 'UNKNOWN'
      lastUpdatedAt: string | null
    }
    websocket: {
      status: 'OK' | 'DOWN' | 'UNKNOWN'
      lastUpdatedAt: string | null
      connected: boolean | null
    }
  }
  details: {
    worker: {
      loops: {
        tradeDetectionRunning: boolean | null
        reconcileRunning: boolean | null
        executionRunning: boolean | null
      }
      controls: {
        envCopySystemEnabled: boolean
        profileCopySystemEnabled: boolean | null
        panicModeEnabled: boolean
        dryRunModeEnabled: boolean
      }
      reconcileIntervalSeconds: number
      nextReconcileInSeconds: number | null
      lastReconcileSummary: Record<string, unknown>
      errorCounts: {
        last15m: number
        last1h: number
        last24h: number
      }
      lastError: {
        message: string
        code: string | null
        component: string
        severity: string
        occurredAt: string
        stack: string | null
      } | null
      retryBackoff: {
        totalBackoffSkips: number
        retryingAttempts: number
        retryDueNow: number
        nextRetryAt: string | null
        nextRetryInSeconds: number | null
        retryingByTokenTop: Array<{
          tokenId: string
          count: number
        }>
      }
      orderAttemptOutcomes1h: Record<string, number>
      orderAttemptOutcomes24h: Record<string, number>
      skipReasons1h: Record<string, number>
      skipReasons24h: Record<string, number>
    }
    database: {
      latencyMs: number | null
      sizeBytes: number | null
      migration: {
        latestMigration: string | null
        latestAppliedAt: string | null
      }
      tableCounts: {
        leaders: number
        leaderPositionSnapshots: number
        followerPositionSnapshots: number
        copyOrders: number
        copyAttempts: number
        errors: number
      }
    }
    redis: {
      details: Record<string, unknown>
      queueCounts: Record<string, number>
      oldestPendingJobAgeSeconds: number | null
      memoryUsedBytes: number | null
      evictionWarnings: number | null
    }
    websocket: {
      activeSubscriptionCount: number | null
      messageRatePerMin: number | null
      connectionUptimeSeconds: number | null
      reconnectCount: number | null
      lastDisconnectReason: string | null
      lastTriggerLagMs: number | null
      lastWsLagMs: number | null
      lastDetectLagMs: number | null
      wsBackedTokenCount: number | null
      restBackedTokenCount: number | null
      fallbackUsage1h: number
      fallbackUsage24h: number
    }
  }
}

function tone(status: 'OK' | 'DOWN' | 'UNKNOWN') {
  if (status === 'OK') {
    return 'positive' as const
  }
  if (status === 'DOWN') {
    return 'negative' as const
  }
  return 'neutral' as const
}

function yesNoUnknown(value: boolean | null): string {
  if (value === null) {
    return 'Unknown'
  }
  return value ? 'Yes' : 'No'
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No'
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let current = value
  let index = 0
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024
    index += 1
  }
  return `${current.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function renderCountRecord(record: Record<string, number>): string {
  const entries = Object.entries(record).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) {
    return 'n/a'
  }
  return entries.map(([key, value]) => `${key}:${value}`).join(' · ')
}

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const detailsClass = 'overflow-hidden rounded-2xl border border-white/10 bg-[#0D0D0D]/95 p-3 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] md:p-4'
const detailsSummaryClass = 'cursor-pointer pr-6 text-sm font-medium text-[#E7E7E7]'
const outlineButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'

export default function StatusPage() {
  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<StatusData>('/api/v1/status', {
    refreshIntervalMs: 10_000
  })
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)

  async function copyLastErrorDetails() {
    if (!data?.details.worker.lastError) {
      return
    }

    const payload = JSON.stringify(data.details.worker.lastError, null, 2)
    try {
      await navigator.clipboard.writeText(payload)
      setCopyFeedback('Copied')
    } catch {
      setCopyFeedback('Copy failed')
    }

    setTimeout(() => setCopyFeedback(null), 2000)
  }

  if (isLoading && !data) {
    return <LoadingState title="Loading status" description="Checking subsystem health cards and diagnostics." />
  }

  if (error && !data) {
    return <ErrorState title="Status unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="No status data" description="Worker and subsystem health has not been reported yet." />
  }

  const degradedCount = [data.cards.worker, data.cards.database, data.cards.redis, data.cards.websocket].filter(
    (card) => card.status !== 'OK'
  ).length

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-12 top-2 h-48 w-48 rounded-full bg-cyan-400/6 blur-3xl" />
          <div className="absolute left-1/3 bottom-0 h-24 w-24 rounded-full bg-[#86efac]/8 blur-2xl" />
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Observability</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Status</h2>
            <p className="max-w-2xl text-sm text-[#919191]">Health cards plus subsystem diagnostics.</p>
          </div>
          <TimestampBadge value={generatedAt} />
        </div>
        <div className="relative mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Worker Status</p>
              <Server className="size-4 text-[#86efac]" />
            </div>
            <div className="mt-2">
              <StatusPill label={data.cards.worker.status} tone={tone(data.cards.worker.status)} />
            </div>
            <p className="mt-2 text-xs text-[#919191]">Last event {formatDateTime(data.cards.worker.lastEventAt)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Database</p>
              <Database className="size-4 text-cyan-300" />
            </div>
            <div className="mt-2">
              <StatusPill label={data.cards.database.status} tone={tone(data.cards.database.status)} />
            </div>
            <p className="mt-2 text-xs text-[#919191]">Latency {formatLatencyMs(data.cards.database.latencyMs)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Realtime</p>
              <Radio className="size-4 text-emerald-300" />
            </div>
            <p className="mt-2 text-sm font-medium text-[#E7E7E7]">
              WS {data.cards.websocket.status} · Redis {data.cards.redis.status}
            </p>
            <p className="text-xs text-[#919191]">
              Connected: {yesNoUnknown(data.cards.websocket.connected)}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Subsystem Summary</p>
              <Shield className="size-4 text-amber-300" />
            </div>
            <p className="mt-2 text-sm font-medium text-[#E7E7E7]">
              {degradedCount === 0 ? 'All nominal' : `${degradedCount} degraded`}
            </p>
            <p className="text-xs text-[#919191]">
              Errors 1h: {formatNumber(data.details.worker.errorCounts.last1h, 0)}
            </p>
          </div>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SubsystemCard
          title="Worker"
          status={data.cards.worker.status}
          lines={[
            `Last event: ${formatDateTime(data.cards.worker.lastEventAt)}`,
            `Last updated: ${formatDateTime(data.cards.worker.lastUpdatedAt)}`
          ]}
        />
        <SubsystemCard
          title="Database"
          status={data.cards.database.status}
          lines={[
            `Latency: ${formatLatencyMs(data.cards.database.latencyMs)}`,
            `Size: ${formatBytes(data.cards.database.sizeBytes)}`,
            `Last updated: ${formatDateTime(data.cards.database.lastUpdatedAt)}`
          ]}
        />
        <SubsystemCard
          title="Redis"
          status={data.cards.redis.status}
          lines={[`Last updated: ${formatDateTime(data.cards.redis.lastUpdatedAt)}`]}
        />
        <SubsystemCard
          title="WebSocket (Alchemy)"
          status={data.cards.websocket.status}
          lines={[
            `Connected: ${yesNoUnknown(data.cards.websocket.connected)}`,
            `Uptime: ${data.details.websocket.connectionUptimeSeconds ?? 'n/a'}s`,
            `Last updated: ${formatDateTime(data.cards.websocket.lastUpdatedAt)}`
          ]}
        />
      </div>

      <div className="space-y-3">
        <details className={detailsClass} open>
          <summary className={detailsSummaryClass}>Worker details</summary>
          <div className="mt-3 grid gap-2 text-sm md:grid-cols-2 [&_p]:break-words">
            <p className="text-[#E7E7E7]">Trade detection loop: <span className="text-[#CFCFCF]">{yesNoUnknown(data.details.worker.loops.tradeDetectionRunning)}</span></p>
            <p className="text-[#E7E7E7]">Reconcile loop: <span className="text-[#CFCFCF]">{yesNoUnknown(data.details.worker.loops.reconcileRunning)}</span></p>
            <p className="text-[#E7E7E7]">Execution loop: <span className="text-[#CFCFCF]">{yesNoUnknown(data.details.worker.loops.executionRunning)}</span></p>
            <p className="text-[#E7E7E7]">Reconcile interval: <span className="text-[#CFCFCF]">{formatNumber(data.details.worker.reconcileIntervalSeconds, 0)}s</span></p>
            <p className="text-[#E7E7E7]">Next reconcile in: <span className="text-[#CFCFCF]">{data.details.worker.nextReconcileInSeconds ?? 'n/a'}s</span></p>
            <p className="text-[#E7E7E7]">Env copy switch: <span className="text-[#CFCFCF]">{yesNo(data.details.worker.controls.envCopySystemEnabled)}</span></p>
            <p className="text-[#E7E7E7]">Profile copy switch: <span className="text-[#CFCFCF]">{yesNoUnknown(data.details.worker.controls.profileCopySystemEnabled)}</span></p>
            <p className="text-[#E7E7E7]">Panic mode: <span className="text-[#CFCFCF]">{yesNo(data.details.worker.controls.panicModeEnabled)}</span></p>
            <p className="text-[#E7E7E7]">Dry-run mode: <span className="text-[#CFCFCF]">{yesNo(data.details.worker.controls.dryRunModeEnabled)}</span></p>
            <p className="text-[#E7E7E7]">Backoff skips (total): <span className="text-[#CFCFCF]">{formatNumber(data.details.worker.retryBackoff.totalBackoffSkips, 0)}</span></p>
            <p className="text-[#E7E7E7]">Retrying attempts: <span className="text-[#CFCFCF]">{formatNumber(data.details.worker.retryBackoff.retryingAttempts, 0)}</span></p>
            <p className="text-[#E7E7E7]">Retry due now: <span className="text-[#CFCFCF]">{formatNumber(data.details.worker.retryBackoff.retryDueNow, 0)}</span></p>
            <p className="text-[#E7E7E7]">Next retry in: <span className="text-[#CFCFCF]">{data.details.worker.retryBackoff.nextRetryInSeconds ?? 'n/a'}s</span></p>
            <p className="md:col-span-2 text-[#E7E7E7]">Retry queue by token: <span className="text-[#CFCFCF]">{renderCountRecord(Object.fromEntries(data.details.worker.retryBackoff.retryingByTokenTop.map((row) => [row.tokenId, row.count])))}</span></p>
            <p className="md:col-span-2 text-[#E7E7E7]">
              Error counts (15m / 1h / 24h): {data.details.worker.errorCounts.last15m} / {data.details.worker.errorCounts.last1h} /{' '}
              {data.details.worker.errorCounts.last24h}
            </p>
            <p className="md:col-span-2 text-[#E7E7E7]">Order outcomes (1h): <span className="text-[#CFCFCF]">{renderCountRecord(data.details.worker.orderAttemptOutcomes1h)}</span></p>
            <p className="md:col-span-2 text-[#E7E7E7]">Order outcomes (24h): <span className="text-[#CFCFCF]">{renderCountRecord(data.details.worker.orderAttemptOutcomes24h)}</span></p>
            <p className="md:col-span-2 text-[#E7E7E7]">Skip reasons (1h): <span className="text-[#CFCFCF]">{renderCountRecord(data.details.worker.skipReasons1h)}</span></p>
            <p className="md:col-span-2 text-[#E7E7E7]">Skip reasons (24h): <span className="text-[#CFCFCF]">{renderCountRecord(data.details.worker.skipReasons24h)}</span></p>
            {data.details.worker.lastError ? (
              <div className="md:col-span-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex items-center gap-2 text-sm font-medium text-[#E7E7E7]">
                    <AlertTriangle className="size-4 text-amber-300" />
                    Last error triage
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    {copyFeedback ? <p className="text-xs text-[#919191]">{copyFeedback}</p> : null}
                    <Button size="sm" variant="outline" className={outlineButtonClass} onClick={() => void copyLastErrorDetails()}>
                      Copy
                    </Button>
                  </div>
                </div>
                <p className="mt-2 text-[#E7E7E7]">
                  {data.details.worker.lastError.component} · {data.details.worker.lastError.severity} ·{' '}
                  {data.details.worker.lastError.code ?? 'NO_CODE'}
                </p>
                <p className="text-[#919191]">{formatDateTime(data.details.worker.lastError.occurredAt)}</p>
                <p className="text-[#E7E7E7]">{data.details.worker.lastError.message}</p>
                {data.details.worker.lastError.stack ? (
                  <pre className="mt-2 max-h-40 overflow-auto rounded-xl border border-white/10 bg-black/40 p-2 text-[11px] text-[#CFCFCF] md:text-xs">
                    {data.details.worker.lastError.stack}
                  </pre>
                ) : null}
              </div>
            ) : (
              <p className="md:col-span-2 text-[#E7E7E7]">Last error: <span className="text-[#CFCFCF]">none</span></p>
            )}
          </div>
        </details>

        <details className={detailsClass}>
          <summary className={detailsSummaryClass}>Database details</summary>
          <div className="mt-3 grid gap-2 text-sm md:grid-cols-2 [&_p]:break-words">
            <p className="text-[#E7E7E7]">Latency: <span className="text-[#CFCFCF]">{formatLatencyMs(data.details.database.latencyMs)}</span></p>
            <p className="text-[#E7E7E7]">Database size: <span className="text-[#CFCFCF]">{formatBytes(data.details.database.sizeBytes)}</span></p>
            <p className="text-[#E7E7E7]">Latest migration: <span className="text-[#CFCFCF]">{data.details.database.migration.latestMigration ?? 'n/a'}</span></p>
            <p className="text-[#E7E7E7]">Migration applied at: <span className="text-[#CFCFCF]">{formatDateTime(data.details.database.migration.latestAppliedAt)}</span></p>
            <p className="text-[#E7E7E7]">Leaders: <span className="text-[#CFCFCF]">{formatNumber(data.details.database.tableCounts.leaders, 0)}</span></p>
            <p className="text-[#E7E7E7]">Leader snapshots: <span className="text-[#CFCFCF]">{formatNumber(data.details.database.tableCounts.leaderPositionSnapshots, 0)}</span></p>
            <p className="text-[#E7E7E7]">Follower snapshots: <span className="text-[#CFCFCF]">{formatNumber(data.details.database.tableCounts.followerPositionSnapshots, 0)}</span></p>
            <p className="text-[#E7E7E7]">Copy orders: <span className="text-[#CFCFCF]">{formatNumber(data.details.database.tableCounts.copyOrders, 0)}</span></p>
            <p className="text-[#E7E7E7]">Copy attempts: <span className="text-[#CFCFCF]">{formatNumber(data.details.database.tableCounts.copyAttempts, 0)}</span></p>
            <p className="text-[#E7E7E7]">Errors: <span className="text-[#CFCFCF]">{formatNumber(data.details.database.tableCounts.errors, 0)}</span></p>
          </div>
        </details>

        <details className={detailsClass}>
          <summary className={detailsSummaryClass}>Redis details</summary>
          <div className="mt-3 space-y-2 text-sm [&_p]:break-words">
            <p className="text-[#E7E7E7]">Oldest pending job age: <span className="text-[#CFCFCF]">{data.details.redis.oldestPendingJobAgeSeconds ?? 'n/a'}s</span></p>
            <p className="text-[#E7E7E7]">Memory usage: <span className="text-[#CFCFCF]">{formatBytes(data.details.redis.memoryUsedBytes)}</span></p>
            <p className="text-[#E7E7E7]">Eviction warnings: <span className="text-[#CFCFCF]">{data.details.redis.evictionWarnings ?? 'n/a'}</span></p>
            {Object.keys(data.details.redis.queueCounts).length === 0 ? (
              <p className="text-[#919191]">No queue counters reported.</p>
            ) : (
              Object.entries(data.details.redis.queueCounts).map(([key, value]) => (
                <p key={key} className="text-[#E7E7E7]">
                  {key}: {formatNumber(value, 0)}
                </p>
              ))
            )}
          </div>
        </details>

        <details className={detailsClass}>
          <summary className={detailsSummaryClass}>WebSocket / Alchemy details</summary>
          <div className="mt-3 grid gap-2 text-sm md:grid-cols-2 [&_p]:break-words">
            <p className="text-[#E7E7E7]">Active subscriptions: <span className="text-[#CFCFCF]">{data.details.websocket.activeSubscriptionCount ?? 'n/a'}</span></p>
            <p className="text-[#E7E7E7]">
              Message rate (per minute):{' '}
              <span className="text-[#CFCFCF]">
                {data.details.websocket.messageRatePerMin ? data.details.websocket.messageRatePerMin.toFixed(2) : 'n/a'}
              </span>
            </p>
            <p className="text-[#E7E7E7]">Connection uptime: <span className="text-[#CFCFCF]">{data.details.websocket.connectionUptimeSeconds ?? 'n/a'}s</span></p>
            <p className="text-[#E7E7E7]">Reconnect attempts: <span className="text-[#CFCFCF]">{data.details.websocket.reconnectCount ?? 'n/a'}</span></p>
            <p className="text-[#E7E7E7]">Last trigger lag: <span className="text-[#CFCFCF]">{data.details.websocket.lastTriggerLagMs ?? 'n/a'}ms</span></p>
            <p className="text-[#E7E7E7]">Last WS lag: <span className="text-[#CFCFCF]">{data.details.websocket.lastWsLagMs ?? 'n/a'}ms</span></p>
            <p className="text-[#E7E7E7]">Last detect lag: <span className="text-[#CFCFCF]">{data.details.websocket.lastDetectLagMs ?? 'n/a'}ms</span></p>
            <p className="text-[#E7E7E7]">WS-backed tokens: <span className="text-[#CFCFCF]">{data.details.websocket.wsBackedTokenCount ?? 'n/a'}</span></p>
            <p className="text-[#E7E7E7]">REST-backed tokens: <span className="text-[#CFCFCF]">{data.details.websocket.restBackedTokenCount ?? 'n/a'}</span></p>
            <p className="text-[#E7E7E7]">Fallback usage (1h): <span className="text-[#CFCFCF]">{formatNumber(data.details.websocket.fallbackUsage1h, 0)}</span></p>
            <p className="text-[#E7E7E7]">Fallback usage (24h): <span className="text-[#CFCFCF]">{formatNumber(data.details.websocket.fallbackUsage24h, 0)}</span></p>
            <p className="md:col-span-2 text-[#E7E7E7]">Last disconnect reason: <span className="text-[#CFCFCF]">{data.details.websocket.lastDisconnectReason ?? 'n/a'}</span></p>
          </div>
        </details>
      </div>
    </div>
  )
}

function SubsystemCard({ title, status, lines }: { title: string; status: 'OK' | 'DOWN' | 'UNKNOWN'; lines: string[] }) {
  return (
    <Card className={`${panelClass} gap-3 py-5`}>
      <CardHeader className="px-5 pb-0 md:px-6">
        <CardDescription className="uppercase tracking-[0.16em] text-[#919191]">{title}</CardDescription>
        <CardTitle>
          <StatusPill label={status} tone={tone(status)} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 px-5 text-xs text-[#919191] md:px-6 [&_p]:break-words">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </CardContent>
    </Card>
  )
}
