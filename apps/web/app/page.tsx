'use client'

import Link from 'next/link'
import { Activity, AlertTriangle, ArrowUpRight, Clock3, ShieldCheck } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { StatusPill } from '@/components/dashboard/status-pill'
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatSignedCurrency
} from '@/lib/format'

interface OverviewData {
  copyProfileId: string | null
  exposure: {
    totalNotionalUsd: number
    byLeaderTop: Array<{
      leaderId: string
      leaderName: string
      exposureUsd: number
    }>
    trackingErrorUsd: number
    trackingErrorPct: number
  }
  pnl: {
    totalPnlUsd: number
    realizedPnlUsd: number
    unrealizedPnlUsd: number
    byMarketTop: Array<{
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      outcome: string | null
      pnlUsd: number
    }>
    byLeaderTop: Array<{
      leaderId: string
      leaderName: string
      realizedPnlUsd: number
      unrealizedPnlUsd: number
      totalPnlUsd: number
    }>
  }
  recentActivity: {
    executions: Array<{
      id: string
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      notionalUsd: number
      shares: number
      priceLimit: number
      status: 'PLACED' | 'PARTIALLY_FILLED' | 'FILLED' | 'FAILED' | 'CANCELLED' | 'RETRYING'
      attemptedAt: string
      leaderName: string | null
    }>
    skips: Array<{
      id: string
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      reason: string | null
      createdAt: string
      leaderName: string | null
    }>
  }
  health: {
    workerStatus: string
    copySystemEnabled: boolean
    dataFreshness: {
      lastLeaderSyncAt: string | null
      lastFollowerSyncAt: string | null
      lastReconcileAt: string | null
      lastOnchainTriggerAt: string | null
    }
    connectivity: {
      workerReachable: boolean
      polymarketApiReachable: boolean | null
      marketWsConnected: boolean | null
      userChannelConnected: boolean | null
      alchemyConnected: boolean | null
    }
    errors: {
      lastError: string | null
      errorCount1h: number
      retryBackoffCount: number
    }
  }
}

function statusTone(value: boolean | null): 'positive' | 'warning' | 'negative' | 'neutral' {
  if (value === null) {
    return 'neutral'
  }
  return value ? 'positive' : 'negative'
}

function workerTone(status: string): 'positive' | 'warning' | 'negative' | 'neutral' {
  const normalized = status.trim().toUpperCase()

  if (normalized === 'OK') {
    return 'positive'
  }
  if (normalized === 'DOWN') {
    return 'negative'
  }
  return 'neutral'
}

function executionStatusPillTone(status: OverviewData['recentActivity']['executions'][number]['status']): 'positive' | 'warning' | 'negative' | 'neutral' {
  if (status === 'PLACED' || status === 'PARTIALLY_FILLED' || status === 'FILLED') {
    return 'positive'
  }
  if (status === 'FAILED') {
    return 'negative'
  }
  if (status === 'CANCELLED' || status === 'RETRYING') {
    return 'warning'
  }
  return 'neutral'
}

function skipSidePillTone(side: OverviewData['recentActivity']['skips'][number]['side']): 'positive' | 'warning' | 'negative' | 'neutral' {
  if (side === 'BUY') {
    return 'positive'
  }
  return 'warning'
}

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const insetRowClass =
  'flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 transition-colors hover:bg-white/[0.04]'

function marketPrimaryLabel(value: { marketLabel: string | null; marketId: string | null; tokenId: string }): string {
  return value.marketLabel ?? value.marketId ?? value.tokenId
}

function marketSecondaryLabel(value: { outcome: string | null; tokenId: string }): string {
  return value.outcome ?? value.tokenId
}

export default function OverviewPage() {
  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<OverviewData>('/api/v1/overview', {
    refreshIntervalMs: 20_000
  })

  if (isLoading && !data) {
    return <LoadingState title="Loading overview" description="Collecting exposure, PnL, and health metrics." />
  }

  if (error && !data) {
    return <ErrorState title="Overview unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="No overview data" description="Add a copy profile and leaders to populate this page." />
  }

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-12 -top-12 h-44 w-44 rounded-full bg-[#86efac]/10 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-28 w-28 rounded-full bg-cyan-400/5 blur-2xl" />
        </div>

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Overview</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">System snapshot</h2>
            <p className="max-w-2xl text-sm text-[#919191]">Exposure, PnL, activity, and health in one view.</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <div className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-100">
                Profile {data.copyProfileId ?? 'not configured'}
              </div>
              <div className="rounded-full border border-emerald-400/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-100">
                Worker {data.health.workerStatus}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <TimestampBadge value={generatedAt} />
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-[#919191]">Total Exposure</p>
            <ArrowUpRight className="size-4 text-[#86efac]" />
          </div>
          <p className="mt-3 text-2xl font-semibold text-[#E7E7E7]">{formatCurrency(data.exposure.totalNotionalUsd)}</p>
          <p className="mt-1 text-xs text-[#919191]">Active follower notional attributed to leaders.</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-[#919191]">Tracking Error</p>
            <Activity className="size-4 text-cyan-300" />
          </div>
          <p className="mt-3 text-2xl font-semibold text-[#E7E7E7]">{formatCurrency(data.exposure.trackingErrorUsd)}</p>
          <p className="mt-1 text-xs text-[#919191]">{formatPercent(data.exposure.trackingErrorPct)} of target sizing.</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-[#919191]">Total PnL</p>
            <ShieldCheck className="size-4 text-emerald-300" />
          </div>
          <p className="mt-3 text-2xl font-semibold text-[#E7E7E7]">{formatSignedCurrency(data.pnl.totalPnlUsd)}</p>
          <p className="mt-1 text-xs text-[#919191]">Realized {formatSignedCurrency(data.pnl.realizedPnlUsd)}</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs uppercase tracking-[0.2em] text-[#919191]">Copy System</p>
            <Clock3 className="size-4 text-amber-300" />
          </div>
          <div className="mt-3">
            <StatusPill
              label={data.health.copySystemEnabled ? 'Enabled' : 'Disabled'}
              tone={data.health.copySystemEnabled ? 'positive' : 'warning'}
              className="border-white/10"
            />
          </div>
          <p className="mt-2 text-xs text-[#919191]">Worker: {data.health.workerStatus}</p>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Exposure</CardDescription>
            <CardTitle className="text-[#E7E7E7]">By leader</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-5 md:px-6">
            {data.exposure.byLeaderTop.length === 0 ? (
              <p className="text-sm text-[#919191]">No leader exposure yet.</p>
            ) : (
              data.exposure.byLeaderTop.map((leader) => (
                <div key={leader.leaderId} className={insetRowClass}>
                  <Link className="font-medium text-[#E7E7E7] hover:text-white hover:underline" href={`/leaders/${leader.leaderId}`}>
                    {leader.leaderName}
                  </Link>
                  <span className="text-sm text-[#CFCFCF]">{formatCurrency(leader.exposureUsd)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">PnL</CardDescription>
            <CardTitle className="text-[#E7E7E7]">By leader</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-5 md:px-6">
            {data.pnl.byLeaderTop.length === 0 ? (
              <p className="text-sm text-[#919191]">No leader PnL records yet.</p>
            ) : (
              data.pnl.byLeaderTop.map((leader) => (
                <div key={leader.leaderId} className={insetRowClass}>
                  <Link className="font-medium text-[#E7E7E7] hover:text-white hover:underline" href={`/leaders/${leader.leaderId}`}>
                    {leader.leaderName}
                  </Link>
                  <span className="text-sm text-[#CFCFCF]">{formatSignedCurrency(leader.totalPnlUsd)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">PnL</CardDescription>
            <CardTitle className="text-[#E7E7E7]">By market</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-5 md:px-6">
            {data.pnl.byMarketTop.length === 0 ? (
              <p className="text-sm text-[#919191]">No market PnL records yet.</p>
            ) : (
              data.pnl.byMarketTop.map((market) => (
                <div key={`${market.tokenId}-${market.marketId ?? 'none'}`} className={insetRowClass}>
                  <div>
                    <p className="text-sm font-medium text-[#E7E7E7]">{marketPrimaryLabel(market)}</p>
                    <p className="text-xs text-[#919191]">{marketSecondaryLabel(market)}</p>
                  </div>
                  <span className="text-sm text-[#CFCFCF]">{formatSignedCurrency(market.pnlUsd)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Execution feed</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Recent executions</CardTitle>
          </CardHeader>
          <CardContent className="px-5 md:px-6">
            {data.recentActivity.executions.length === 0 ? (
              <p className="text-sm text-[#919191]">No executions yet.</p>
            ) : (
              <>
                <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block">
                  <Table>
                    <TableHeader className="[&_tr]:border-white/10">
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Time</TableHead>
                        <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
                        <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market</TableHead>
                        <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
                        <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Notional</TableHead>
                        <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody className="[&_tr]:border-white/5">
                      {data.recentActivity.executions.map((row) => (
                        <TableRow key={row.id} className="hover:bg-white/[0.03]">
                          <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(row.attemptedAt)}</TableCell>
                          <TableCell className="px-3 text-[#E7E7E7]">{row.leaderName ?? 'n/a'}</TableCell>
                          <TableCell className="px-3">
                            <p className="text-sm text-[#E7E7E7]">{marketPrimaryLabel(row)}</p>
                            <p className="text-xs text-[#919191]">{marketSecondaryLabel(row)}</p>
                          </TableCell>
                          <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                          <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(row.notionalUsd)}</TableCell>
                          <TableCell className="px-3">
                            <StatusPill label={row.status} tone={executionStatusPillTone(row.status)} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="space-y-2 md:hidden">
                  {data.recentActivity.executions.map((row) => (
                    <div key={row.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-[#919191]">{formatDateTime(row.attemptedAt)}</p>
                        <StatusPill label={row.status} tone={executionStatusPillTone(row.status)} />
                      </div>
                      <p className="mt-1 font-medium text-[#E7E7E7]">
                        {row.side} {formatCurrency(row.notionalUsd)}
                      </p>
                      <p className="text-xs text-[#919191]">{row.leaderName ?? 'n/a'} · {marketPrimaryLabel(row)}</p>
                      <p className="text-xs text-[#919191]">{marketSecondaryLabel(row)}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Guardrails</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Recent skips</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 px-5 md:px-6">
            {data.recentActivity.skips.length === 0 ? (
              <p className="text-sm text-[#919191]">No skipped attempts recorded.</p>
            ) : (
              data.recentActivity.skips.map((row) => (
                <div key={row.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-[#919191]">{formatDateTime(row.createdAt)}</p>
                    <StatusPill label={row.side} tone={skipSidePillTone(row.side)} />
                  </div>
                  <p className="mt-1 font-medium text-[#E7E7E7]">{row.leaderName ?? 'n/a'} · {marketPrimaryLabel(row)}</p>
                  <p className="mt-1 text-xs text-[#919191]">{marketSecondaryLabel(row)}</p>
                  <p className="mt-1 text-sm text-[#919191]">{row.reason ?? 'No reason provided'}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Health</CardDescription>
          <CardTitle className="text-[#E7E7E7]">General health</CardTitle>
          <CardDescription className="text-[#919191]">Freshness, connectivity, and error counters.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Worker</p>
              <StatusPill label={data.health.workerStatus} tone={workerTone(data.health.workerStatus)} className="mt-2" />
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Polymarket API</p>
              <StatusPill
                label={data.health.connectivity.polymarketApiReachable === null ? 'Unknown' : data.health.connectivity.polymarketApiReachable ? 'Reachable' : 'Unreachable'}
                tone={statusTone(data.health.connectivity.polymarketApiReachable)}
                className="mt-2"
              />
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Market WS</p>
              <StatusPill
                label={data.health.connectivity.marketWsConnected === null ? 'Unknown' : data.health.connectivity.marketWsConnected ? 'Connected' : 'Disconnected'}
                tone={statusTone(data.health.connectivity.marketWsConnected)}
                className="mt-2"
              />
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Alchemy</p>
              <StatusPill
                label={data.health.connectivity.alchemyConnected === null ? 'Unknown' : data.health.connectivity.alchemyConnected ? 'Connected' : 'Disconnected'}
                tone={statusTone(data.health.connectivity.alchemyConnected)}
                className="mt-2"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Last leader sync</p>
              <p className="mt-1 text-sm text-[#E7E7E7]">{formatDateTime(data.health.dataFreshness.lastLeaderSyncAt)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Last follower sync</p>
              <p className="mt-1 text-sm text-[#E7E7E7]">{formatDateTime(data.health.dataFreshness.lastFollowerSyncAt)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Last reconcile</p>
              <p className="mt-1 text-sm text-[#E7E7E7]">{formatDateTime(data.health.dataFreshness.lastReconcileAt)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Last on-chain trigger</p>
              <p className="mt-1 text-sm text-[#E7E7E7]">{formatDateTime(data.health.dataFreshness.lastOnchainTriggerAt)}</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Errors (1h)</p>
              <p className="mt-1 text-sm font-medium text-[#E7E7E7]">{formatNumber(data.health.errors.errorCount1h, 0)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Backoff count</p>
              <p className="mt-1 text-sm font-medium text-[#E7E7E7]">{formatNumber(data.health.errors.retryBackoffCount, 0)}</p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[#919191]">
                <AlertTriangle className="size-3.5" />
                Last error
              </p>
              <p className="mt-1 text-sm text-[#E7E7E7]">{data.health.errors.lastError ?? 'None'}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
