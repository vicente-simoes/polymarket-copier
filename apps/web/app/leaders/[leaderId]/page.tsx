'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { AlertTriangle, ExternalLink, Gauge, Settings2, Shield, Waves } from 'lucide-react'
import { fetchApi } from '@/lib/api-client'
import { formatCurrency, formatDateTime, formatNumber, shortAddress } from '@/lib/format'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { StatusPill } from '@/components/dashboard/status-pill'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface LeaderDetailData {
  id: string
  name: string
  profileAddress: string
  status: 'ACTIVE' | 'PAUSED' | 'DISABLED'
  createdAt: string
  updatedAt: string
  wallets: Array<{
    walletAddress: string
    isPrimary: boolean
    isActive: boolean
    firstSeenAt: string
    lastSeenAt: string
  }>
  profileLinks: Array<{
    copyProfileId: string
    ratio: number
    status: 'ACTIVE' | 'PAUSED' | 'REMOVED'
    settings: Record<string, unknown>
  }>
  stats: {
    targetExposureUsd: number
    followerAttributedExposureUsd: number
    trackingErrorUsd: number
    counters: {
      triggersReceived: number
      tradesDetected: number
      tradesExecuted: number
      skips: number
      skipReasons: Array<{
        reason: string
        count: number
      }>
    }
  }
  recent: {
    triggers: Array<{
      id: string
      source: 'CHAIN' | 'DATA_API'
      tokenId: string
      marketId: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      shares: number
      price: number
      notionalUsd: number
      leaderFillAtMs: string
      detectedAtMs: string
    }>
    executions: Array<{
      id: string
      copyAttemptId: string | null
      tokenId: string
      marketId: string | null
      side: 'BUY' | 'SELL'
      status: 'PLACED' | 'PARTIALLY_FILLED' | 'FILLED' | 'FAILED' | 'CANCELLED' | 'RETRYING'
      intendedNotionalUsd: number
      intendedShares: number
      priceLimit: number
      attemptedAt: string
      reason: string | null
      errorMessage: string | null
    }>
    skips: Array<{
      id: string
      tokenId: string
      marketId: string | null
      side: 'BUY' | 'SELL'
      status: 'PENDING' | 'EXECUTING' | 'EXECUTED' | 'SKIPPED' | 'EXPIRED' | 'FAILED' | 'RETRYING'
      reason: string | null
      decision: 'PENDING' | 'EXECUTED' | 'SKIPPED'
      createdAt: string
      attemptedAt: string | null
      accumulatedDeltaNotionalUsd: number
    }>
    errors: Array<{
      id: string
      severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'
      code: string | null
      message: string
      occurredAt: string
    }>
  }
  diagnostics: {
    lastAuthoritativePositionsSnapshotAt: string | null
    lastReconcile: {
      cycleAt: string | null
      status: string | null
      deltasConsidered: number | null
      deltasExecuted: number | null
      deltasSkipped: number | null
      integrityViolations: number | null
      issues: Array<{
        code: string
        message: string
        severity: string
      }>
    } | null
  }
}

function statusTone(status: 'ACTIVE' | 'PAUSED' | 'DISABLED') {
  if (status === 'ACTIVE') {
    return 'positive' as const
  }
  if (status === 'PAUSED') {
    return 'warning' as const
  }
  return 'negative' as const
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((entry): entry is string => typeof entry === 'string')
}

function toNumberOrBlank(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return ''
  }
  return String(value)
}

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'
const inputClass =
  'h-10 rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] placeholder:text-[#6f6f6f] focus-visible:border-white/20 focus-visible:ring-white/10'
const outlineButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'
const activeButtonClass = 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]'
const insetCardClass = 'rounded-xl border border-white/10 bg-white/[0.02] p-3'

export default function LeaderDetailPage() {
  const params = useParams<{ leaderId: string }>()
  const leaderId = useMemo(() => params?.leaderId ?? '', [params])
  const query = leaderId ? `/api/v1/leaders/${leaderId}` : '/api/v1/leaders'

  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<LeaderDetailData>(query, {
    enabled: Boolean(leaderId)
  })

  const [ratio, setRatio] = useState('')
  const [allowList, setAllowList] = useState('')
  const [denyList, setDenyList] = useState('')
  const [maxExposurePerLeaderUsd, setMaxExposurePerLeaderUsd] = useState('')
  const [maxExposurePerMarketUsd, setMaxExposurePerMarketUsd] = useState('')
  const [maxDailyTurnoverUsd, setMaxDailyTurnoverUsd] = useState('')
  const [maxSlippageBps, setMaxSlippageBps] = useState('')
  const [maxPricePerShareUsd, setMaxPricePerShareUsd] = useState('')
  const [minNotionalUsd, setMinNotionalUsd] = useState('')
  const [minDeltaNotionalUsd, setMinDeltaNotionalUsd] = useState('')
  const [minDeltaShares, setMinDeltaShares] = useState('')
  const [mutationMessage, setMutationMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!data) {
      return
    }

    const activeLink = data.profileLinks.find((link) => link.status === 'ACTIVE') ?? data.profileLinks[0]
    if (!activeLink) {
      return
    }

    const settings = activeLink.settings

    setRatio(String(activeLink.ratio))
    setAllowList(asStringArray(settings.allowList).join(', '))
    setDenyList(asStringArray(settings.denyList).join(', '))
    setMaxExposurePerLeaderUsd(toNumberOrBlank(settings.maxExposurePerLeaderUsd))
    setMaxExposurePerMarketUsd(toNumberOrBlank(settings.maxExposurePerMarketOutcomeUsd))
    setMaxDailyTurnoverUsd(toNumberOrBlank(settings.maxDailyNotionalTurnoverUsd))
    setMaxSlippageBps(toNumberOrBlank(settings.maxSlippageBps))
    setMaxPricePerShareUsd(toNumberOrBlank(settings.maxPricePerShareUsd))
    setMinNotionalUsd(toNumberOrBlank(settings.minNotionalPerOrderUsd))
    setMinDeltaNotionalUsd(toNumberOrBlank(settings.minDeltaNotionalUsd))
    setMinDeltaShares(toNumberOrBlank(settings.minDeltaShares))
  }, [data])

  async function updateStatus(status: 'ACTIVE' | 'PAUSED') {
    if (!leaderId) {
      return
    }

    setIsSaving(true)
    setMutationMessage(null)

    try {
      await fetchApi(`/api/v1/leaders/${leaderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
      })
      setMutationMessage(`Leader ${status === 'ACTIVE' ? 'resumed' : 'paused'}.`)
      await refresh()
    } catch (updateError) {
      setMutationMessage(updateError instanceof Error ? updateError.message : String(updateError))
    } finally {
      setIsSaving(false)
    }
  }

  async function saveSettings() {
    if (!leaderId) {
      return
    }

    setIsSaving(true)
    setMutationMessage(null)

    try {
      const payload: Record<string, unknown> = {
        ratio: Number(ratio),
        settings: {
          allowList: allowList.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
          denyList: denyList.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0),
          ...(maxExposurePerLeaderUsd.trim().length > 0 ? { maxExposurePerLeaderUsd: Number(maxExposurePerLeaderUsd) } : {}),
          ...(maxExposurePerMarketUsd.trim().length > 0
            ? { maxExposurePerMarketOutcomeUsd: Number(maxExposurePerMarketUsd) }
            : {}),
          ...(maxDailyTurnoverUsd.trim().length > 0 ? { maxDailyNotionalTurnoverUsd: Number(maxDailyTurnoverUsd) } : {}),
          ...(maxSlippageBps.trim().length > 0 ? { maxSlippageBps: Number(maxSlippageBps) } : {}),
          ...(maxPricePerShareUsd.trim().length > 0 ? { maxPricePerShareUsd: Number(maxPricePerShareUsd) } : {}),
          ...(minNotionalUsd.trim().length > 0 ? { minNotionalPerOrderUsd: Number(minNotionalUsd) } : {}),
          ...(minDeltaNotionalUsd.trim().length > 0 ? { minDeltaNotionalUsd: Number(minDeltaNotionalUsd) } : {}),
          ...(minDeltaShares.trim().length > 0 ? { minDeltaShares: Number(minDeltaShares) } : {})
        }
      }

      await fetchApi(`/api/v1/leaders/${leaderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      setMutationMessage('Leader rules saved.')
      await refresh()
    } catch (saveError) {
      setMutationMessage(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setIsSaving(false)
    }
  }

  if (!leaderId) {
    return <EmptyState title="Missing leader id" description="Open this page from the leaders list." />
  }

  if (isLoading && !data) {
    return <LoadingState title="Loading leader" description="Fetching controls, stats, and diagnostics." />
  }

  if (error && !data) {
    return <ErrorState title="Leader unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="Leader not found" description="This leader might have been removed." />
  }

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-12 top-0 h-44 w-44 rounded-full bg-[#86efac]/8 blur-3xl" />
          <div className="absolute left-1/4 bottom-0 h-24 w-24 rounded-full bg-cyan-400/6 blur-2xl" />
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Leader Detail</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">{data.name}</h2>
            <p className="text-sm text-[#919191]">
              Profile {shortAddress(data.profileAddress)} · Last sync {formatDateTime(data.diagnostics.lastAuthoritativePositionsSnapshotAt)}
            </p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <StatusPill label={data.status} tone={statusTone(data.status)} />
              <div className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-[#919191]">
                Wallets {formatNumber(data.wallets.length, 0)}
              </div>
              <div className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-[#919191]">
                Links {formatNumber(data.profileLinks.length, 0)}
              </div>
            </div>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button asChild variant="outline" size="sm" className={outlineButtonClass}>
              <Link href="/leaders">Back to leaders</Link>
            </Button>
            <Button asChild variant="outline" size="sm" className={outlineButtonClass}>
              <Link href={`https://polymarket.com/${data.profileAddress}`} target="_blank" rel="noreferrer">
                <ExternalLink className="size-4" />
                View on Polymarket
              </Link>
            </Button>
            <TimestampBadge value={generatedAt} />
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Target Exposure</p>
            <Gauge className="size-4 text-[#86efac]" />
          </div>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(data.stats.targetExposureUsd)}</p>
          <p className="text-xs text-[#919191]">Configured target for this leader</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Attributed Exposure</p>
            <Shield className="size-4 text-cyan-300" />
          </div>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(data.stats.followerAttributedExposureUsd)}</p>
          <p className="text-xs text-[#919191]">Follower attribution</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Tracking Error</p>
            <Waves className="size-4 text-amber-300" />
          </div>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(data.stats.trackingErrorUsd)}</p>
          <p className="text-xs text-[#919191]">Leader vs follower delta</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Pipeline Counters</p>
            <Settings2 className="size-4 text-emerald-300" />
          </div>
          <p className="mt-2 text-sm font-medium text-[#E7E7E7]">
            T {formatNumber(data.stats.counters.triggersReceived, 0)} · E {formatNumber(data.stats.counters.tradesExecuted, 0)} · S {formatNumber(data.stats.counters.skips, 0)}
          </p>
          <div className="mt-2 space-y-1 text-xs text-[#919191]">
            {data.stats.counters.skipReasons.length === 0 ? (
              <p>No skip reason breakdown yet.</p>
            ) : (
              data.stats.counters.skipReasons.slice(0, 3).map((row) => (
                <p key={row.reason}>
                  {row.reason}: {formatNumber(row.count, 0)}
                </p>
              ))
            )}
          </div>
        </div>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Controls</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Leader controls</CardTitle>
          <CardDescription className="text-[#919191]">Pause/resume and per-leader rule overrides.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          <div className="flex flex-wrap items-center gap-2">
            {data.status === 'ACTIVE' ? (
              <Button disabled={isSaving} variant="outline" className={outlineButtonClass} onClick={() => void updateStatus('PAUSED')}>
                Pause copying
              </Button>
            ) : (
              <Button
                disabled={isSaving || data.status === 'DISABLED'}
                variant="outline"
                className={outlineButtonClass}
                onClick={() => void updateStatus('ACTIVE')}
              >
                Resume copying
              </Button>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <Input className={inputClass} value={ratio} onChange={(event) => setRatio(event.target.value)} placeholder="Ratio" />
            <Input className={inputClass} value={maxSlippageBps} onChange={(event) => setMaxSlippageBps(event.target.value)} placeholder="Max slippage bps" />
            <Input className={inputClass} value={maxPricePerShareUsd} onChange={(event) => setMaxPricePerShareUsd(event.target.value)} placeholder="Max price per share (USD)" />
            <Input className={inputClass} value={maxExposurePerLeaderUsd} onChange={(event) => setMaxExposurePerLeaderUsd(event.target.value)} placeholder="Max exposure per leader (USD)" />
            <Input className={inputClass} value={maxExposurePerMarketUsd} onChange={(event) => setMaxExposurePerMarketUsd(event.target.value)} placeholder="Max exposure per market/outcome (USD)" />
            <Input className={inputClass} value={maxDailyTurnoverUsd} onChange={(event) => setMaxDailyTurnoverUsd(event.target.value)} placeholder="Max daily turnover (USD)" />
            <Input className={inputClass} value={minNotionalUsd} onChange={(event) => setMinNotionalUsd(event.target.value)} placeholder="Min notional per order (USD)" />
            <Input className={inputClass} value={minDeltaNotionalUsd} onChange={(event) => setMinDeltaNotionalUsd(event.target.value)} placeholder="Min delta threshold (USD)" />
            <Input className={inputClass} value={minDeltaShares} onChange={(event) => setMinDeltaShares(event.target.value)} placeholder="Min delta threshold (shares)" />
            <Input className={inputClass} value={allowList} onChange={(event) => setAllowList(event.target.value)} placeholder="Allow list market IDs (comma-separated)" />
            <Input className={inputClass} value={denyList} onChange={(event) => setDenyList(event.target.value)} placeholder="Deny list market IDs (comma-separated)" />
          </div>

          <Button className={`${activeButtonClass} w-full sm:w-auto`} disabled={isSaving} onClick={() => void saveSettings()}>
            Save leader rules
          </Button>

          {mutationMessage ? <p className="text-sm text-[#CFCFCF]">{mutationMessage}</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Signals</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Recent triggers</CardTitle>
            <CardDescription className="text-[#919191]">Leader trade signals and source.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 md:px-6">
            {data.recent.triggers.length === 0 ? (
              <p className="text-sm text-[#919191]">No triggers yet.</p>
            ) : (
              <div className="space-y-2">
                {data.recent.triggers.map((trigger) => (
                  <div key={trigger.id} className={insetCardClass}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-[#E7E7E7]">{trigger.side} · {trigger.tokenId}</p>
                      <StatusPill label={trigger.source} tone={trigger.source === 'CHAIN' ? 'positive' : 'warning'} />
                    </div>
                    <p className="text-xs text-[#919191]">
                      Fill {formatDateTime(new Date(Number(trigger.leaderFillAtMs)).toISOString())} · Detected {formatDateTime(new Date(Number(trigger.detectedAtMs)).toISOString())}
                    </p>
                    <p className="text-xs text-[#919191]">
                      {formatNumber(trigger.shares)} shares @ {formatNumber(trigger.price, 4)} · {formatCurrency(trigger.notionalUsd)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Execution</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Recent executions</CardTitle>
            <CardDescription className="text-[#919191]">What we tried to execute for this leader.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 md:px-6">
            {data.recent.executions.length === 0 ? (
              <p className="text-sm text-[#919191]">No executions yet.</p>
            ) : (
              <div className="space-y-2">
                {data.recent.executions.map((execution) => (
                  <div key={execution.id} className={insetCardClass}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-[#E7E7E7]">{execution.side} · {execution.tokenId}</p>
                      <StatusPill
                        label={execution.status}
                        tone={execution.status === 'FILLED' ? 'positive' : execution.status === 'FAILED' ? 'negative' : 'neutral'}
                      />
                    </div>
                    <p className="text-xs text-[#919191]">
                      {formatDateTime(execution.attemptedAt)} · {formatCurrency(execution.intendedNotionalUsd)} · {formatNumber(execution.intendedShares)} shares
                    </p>
                    {execution.errorMessage ? <p className="text-xs text-rose-300">{execution.errorMessage}</p> : null}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Diagnostics</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Skips and errors</CardTitle>
          <CardDescription className="text-[#919191]">Skipped attempts and related errors for this leader.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          {data.recent.skips.length === 0 ? (
            <p className="text-sm text-[#919191]">No skipped attempts.</p>
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block">
                <Table>
                  <TableHeader className="[&_tr]:border-white/10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Time</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Token</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Decision</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Accum. delta</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-white/5">
                    {data.recent.skips.map((skip) => (
                      <TableRow key={skip.id} className="hover:bg-white/[0.03]">
                        <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(skip.createdAt)}</TableCell>
                        <TableCell className="px-3 font-mono text-xs text-[#CFCFCF]">{skip.tokenId}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{skip.side}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{skip.decision}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(skip.accumulatedDeltaNotionalUsd)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{skip.reason ?? 'n/a'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 md:hidden">
                {data.recent.skips.map((skip) => (
                  <div key={skip.id} className={insetCardClass}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-[#E7E7E7]">{skip.side} · {skip.tokenId}</p>
                      <StatusPill label={skip.decision} tone="neutral" />
                    </div>
                    <p className="text-xs text-[#919191]">{formatDateTime(skip.createdAt)}</p>
                    <p className="text-xs text-[#919191]">Accumulated delta {formatCurrency(skip.accumulatedDeltaNotionalUsd)}</p>
                    <p className="text-sm text-[#E7E7E7]">{skip.reason ?? 'n/a'}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          <details className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <summary className="cursor-pointer text-sm font-medium text-[#E7E7E7]">Diagnostics</summary>
            <div className="mt-3 space-y-2 text-sm [&_p]:break-words">
              <p className="text-[#E7E7E7]">Last snapshot: <span className="text-[#CFCFCF]">{formatDateTime(data.diagnostics.lastAuthoritativePositionsSnapshotAt)}</span></p>
              <p className="text-[#E7E7E7]">Last reconcile cycle: <span className="text-[#CFCFCF]">{formatDateTime(data.diagnostics.lastReconcile?.cycleAt ?? null)}</span></p>
              <p className="text-[#E7E7E7]">Last reconcile status: <span className="text-[#CFCFCF]">{data.diagnostics.lastReconcile?.status ?? 'n/a'}</span></p>
              <p className="text-[#E7E7E7]">
                Deltas considered/executed/skipped:{' '}
                {data.diagnostics.lastReconcile?.deltasConsidered !== null ? formatNumber(data.diagnostics.lastReconcile?.deltasConsidered ?? 0, 0) : 'n/a'}
                {' / '}
                {data.diagnostics.lastReconcile?.deltasExecuted !== null ? formatNumber(data.diagnostics.lastReconcile?.deltasExecuted ?? 0, 0) : 'n/a'}
                {' / '}
                {data.diagnostics.lastReconcile?.deltasSkipped !== null ? formatNumber(data.diagnostics.lastReconcile?.deltasSkipped ?? 0, 0) : 'n/a'}
              </p>
              <p className="text-[#E7E7E7]">
                Integrity violations:{' '}
                {data.diagnostics.lastReconcile?.integrityViolations !== null
                  ? formatNumber(data.diagnostics.lastReconcile?.integrityViolations ?? 0, 0)
                  : 'n/a'}
              </p>
              {data.diagnostics.lastReconcile?.issues.length ? (
                <div className="space-y-1">
                  {data.diagnostics.lastReconcile.issues.map((issue) => (
                    <p key={`${issue.code}-${issue.message}`} className="text-xs text-[#919191]">
                      [{issue.severity}] {issue.code}: {issue.message}
                    </p>
                  ))}
                </div>
              ) : null}

              <div className="pt-2">
                <p className="mb-1 flex items-center gap-2 text-xs text-[#919191]">
                  <AlertTriangle className="size-3.5" />
                  Recent errors
                </p>
                {data.recent.errors.length === 0 ? (
                  <p className="text-xs text-[#919191]">No errors for this leader.</p>
                ) : (
                  <div className="space-y-1">
                    {data.recent.errors.map((errorRow) => (
                      <p key={errorRow.id} className="text-xs text-[#919191]">
                        {formatDateTime(errorRow.occurredAt)} [{errorRow.severity}] {errorRow.message}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </details>
        </CardContent>
      </Card>
    </div>
  )
}
