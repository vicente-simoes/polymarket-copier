'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, CandlestickChart, CircleDollarSign, Layers3, Radar, ScrollText } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { StatusPill } from '@/components/dashboard/status-pill'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { formatCurrency, formatDateTime, formatNumber, formatSignedCurrency } from '@/lib/format'

interface PortfolioPositionPayload {
  positions: {
    items: Array<{
      tokenId: string
      marketId: string | null
      outcome: string | null
      shares: number
      currentPrice: number
      costBasisUsd: number
      currentValueUsd: number
      unrealizedPnlUsd: number
    }>
  }
}

interface CopyExecutionsPayload {
  executions: {
    items: Array<{
      id: string
      attemptedAt: string
      leaderName: string | null
      side: 'BUY' | 'SELL'
      status: 'PLACED' | 'PARTIALLY_FILLED' | 'FILLED' | 'FAILED' | 'CANCELLED' | 'RETRYING'
      intendedNotionalUsd: number
      reason: string | null
      errorMessage: string | null
      accumulatedDeltaNotionalUsd: number | null
    }>
  } | null
}

interface CopyOpenPayload {
  open: {
    items: Array<{
      id: string
      createdAt: string
      leaderName: string | null
      side: 'BUY' | 'SELL'
      status: 'PENDING' | 'ELIGIBLE' | 'BLOCKED' | 'EXPIRED' | 'CONVERTED'
      blockReason: string | null
      pendingNotionalUsd: number
    }>
  } | null
}

interface CopySkippedPayload {
  skipped: {
    details: Array<{
      id: string
      createdAt: string
      leaderName: string | null
      side: 'BUY' | 'SELL'
      reason: string | null
      accumulatedDeltaNotionalUsd: number
    }> | null
  } | null
}

interface CombinedAttempt {
  id: string
  timestamp: string
  side: 'BUY' | 'SELL'
  leaderName: string | null
  decision: 'PENDING' | 'EXECUTED' | 'SKIPPED'
  accumulatedDeltaNotionalUsd: number | null
  reason: string | null
}

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'
const insetClass = 'rounded-xl border border-white/10 bg-white/[0.02]'
const outlineButtonClass =
  'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'

export default function PositionDetailPage() {
  const params = useParams<{ tokenId: string }>()
  const tokenId = useMemo(() => params?.tokenId ?? '', [params])

  const positionQuery = tokenId
    ? `/api/v1/portfolio?range=24h&tokenId=${encodeURIComponent(tokenId)}&page=1&pageSize=1`
    : '/api/v1/portfolio?range=24h&page=1&pageSize=1'
  const executionsQuery = tokenId
    ? `/api/v1/copies?section=executions&tokenId=${encodeURIComponent(tokenId)}&page=1&pageSize=50`
    : '/api/v1/copies?section=executions&page=1&pageSize=50'
  const openQuery = tokenId
    ? `/api/v1/copies?section=open&tokenId=${encodeURIComponent(tokenId)}&page=1&pageSize=50`
    : '/api/v1/copies?section=open&page=1&pageSize=50'
  const skippedQuery = tokenId
    ? `/api/v1/copies?section=skipped&tokenId=${encodeURIComponent(tokenId)}&page=1&pageSize=50`
    : '/api/v1/copies?section=skipped&page=1&pageSize=50'

  const positionState = useApiQuery<PortfolioPositionPayload>(positionQuery, {
    enabled: Boolean(tokenId),
    refreshIntervalMs: 20_000
  })
  const executionsState = useApiQuery<CopyExecutionsPayload>(executionsQuery, {
    enabled: Boolean(tokenId),
    refreshIntervalMs: 20_000
  })
  const openState = useApiQuery<CopyOpenPayload>(openQuery, {
    enabled: Boolean(tokenId),
    refreshIntervalMs: 20_000
  })
  const skippedState = useApiQuery<CopySkippedPayload>(skippedQuery, {
    enabled: Boolean(tokenId),
    refreshIntervalMs: 20_000
  })

  const isLoading = positionState.isLoading || executionsState.isLoading || openState.isLoading || skippedState.isLoading
  const hasError = positionState.error || executionsState.error || openState.error || skippedState.error

  if (!tokenId) {
    return <EmptyState title="Missing token id" description="Open this page from the portfolio positions list." />
  }

  if (isLoading && !positionState.data) {
    return <LoadingState title="Loading position detail" description="Fetching position and copy attempt history." />
  }

  if (hasError && !positionState.data) {
    return (
      <ErrorState
        title="Position detail unavailable"
        description={hasError ?? 'Unknown error'}
        actionLabel="Retry"
        onAction={() => {
          void positionState.refresh()
          void executionsState.refresh()
          void openState.refresh()
          void skippedState.refresh()
        }}
      />
    )
  }

  const position = positionState.data?.positions.items[0] ?? null

  const attempts: CombinedAttempt[] = [
    ...((openState.data?.open?.items ?? []).map((row) => ({
      id: row.id,
      timestamp: row.createdAt,
      side: row.side,
      leaderName: row.leaderName,
      decision: 'PENDING' as const,
      accumulatedDeltaNotionalUsd: row.pendingNotionalUsd,
      reason: row.blockReason ?? row.status
    })) as CombinedAttempt[]),
    ...((executionsState.data?.executions?.items ?? []).map((row) => ({
      id: row.id,
      timestamp: row.attemptedAt,
      side: row.side,
      leaderName: row.leaderName,
      decision: 'EXECUTED' as const,
      accumulatedDeltaNotionalUsd: row.accumulatedDeltaNotionalUsd,
      reason: row.status === 'FAILED' ? row.errorMessage ?? row.reason : row.reason
    })) as CombinedAttempt[]),
    ...((skippedState.data?.skipped?.details ?? []).map((row) => ({
      id: row.id,
      timestamp: row.createdAt,
      side: row.side,
      leaderName: row.leaderName,
      decision: 'SKIPPED' as const,
      accumulatedDeltaNotionalUsd: row.accumulatedDeltaNotionalUsd,
      reason: row.reason
    })) as CombinedAttempt[])
  ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 50)

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-12 top-0 h-40 w-40 rounded-full bg-[#86efac]/8 blur-3xl" />
          <div className="absolute left-1/3 bottom-0 h-24 w-24 rounded-full bg-cyan-400/6 blur-2xl" />
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Portfolio</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Position detail</h2>
            <p className="text-sm text-[#919191]">Token {tokenId}</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button asChild variant="outline" size="sm" className={outlineButtonClass}>
              <Link href="/portfolio">
                <ArrowLeft className="size-4" />
                Back to portfolio
              </Link>
            </Button>
            <TimestampBadge
              value={positionState.generatedAt ?? executionsState.generatedAt ?? openState.generatedAt ?? skippedState.generatedAt}
            />
          </div>
        </div>
      </section>

      {position ? (
        <>
          <Card className={`${panelClass} gap-4 py-5`}>
            <CardHeader className="px-5 pb-0 md:px-6">
              <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Asset</CardDescription>
              <CardTitle className="text-[#E7E7E7]">{position.outcome ?? 'Unknown outcome'}</CardTitle>
              <CardDescription className="truncate text-[#919191]">{position.marketId ?? tokenId}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 px-5 md:px-6 sm:grid-cols-2 xl:grid-cols-4">
              <div className={`${insetClass} p-3`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Shares</p>
                  <Layers3 className="size-4 text-[#86efac]" />
                </div>
                <p className="mt-2 text-lg font-semibold text-[#E7E7E7]">{formatNumber(position.shares)}</p>
              </div>
              <div className={`${insetClass} p-3`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Price / Share</p>
                  <Radar className="size-4 text-cyan-300" />
                </div>
                <p className="mt-2 text-lg font-semibold text-[#E7E7E7]">{formatNumber(position.currentPrice, 4)}</p>
              </div>
              <div className={`${insetClass} p-3`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Cost Basis</p>
                  <CircleDollarSign className="size-4 text-amber-300" />
                </div>
                <p className="mt-2 text-lg font-semibold text-[#E7E7E7]">{formatCurrency(position.costBasisUsd)}</p>
              </div>
              <div className={`${insetClass} p-3`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Current Value</p>
                  <CandlestickChart className="size-4 text-emerald-300" />
                </div>
                <p className="mt-2 text-lg font-semibold text-[#E7E7E7]">{formatCurrency(position.currentValueUsd)}</p>
              </div>
              <div className={`${insetClass} p-3 sm:col-span-2`}>
                <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Unrealized PnL</p>
                <p className="mt-2 text-lg font-semibold text-[#E7E7E7]">{formatSignedCurrency(position.unrealizedPnlUsd)}</p>
              </div>
              <div className={`${insetClass} p-3`}>
                <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Asset ID</p>
                <p className="mt-2 break-all font-mono text-xs text-[#CFCFCF]">{position.tokenId}</p>
              </div>
              <div className={`${insetClass} p-3`}>
                <p className="text-xs uppercase tracking-[0.14em] text-[#919191]">Market ID</p>
                <p className="mt-2 break-all font-mono text-xs text-[#CFCFCF]">{position.marketId ?? 'n/a'}</p>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <EmptyState title="Position not found" description="This token is not present in the latest follower snapshot." />
      )}

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Activity</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <ScrollText className="size-4 text-[#86efac]" />
            Copy attempts (token)
          </CardTitle>
          <CardDescription className="text-[#919191]">Pending, executed, and skipped attempts for this outcome token.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 md:px-6">
          {attempts.length === 0 ? (
            <EmptyState title="No copy attempts" description="No executed or skipped attempts recorded for this token." />
          ) : (
            <>
              <div className={`hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block`}>
                <Table>
                  <TableHeader className="[&_tr]:border-white/10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Date & time</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Decision</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Accum. delta</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-white/5">
                    {attempts.map((attempt) => (
                      <TableRow key={attempt.id} className="hover:bg-white/[0.03]">
                        <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(attempt.timestamp)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{attempt.side}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{attempt.leaderName ?? 'n/a'}</TableCell>
                        <TableCell className="px-3">
                          <StatusPill
                            label={attempt.decision}
                            tone={
                              attempt.decision === 'EXECUTED'
                                ? 'positive'
                                : attempt.decision === 'SKIPPED'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          />
                        </TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">
                          {attempt.accumulatedDeltaNotionalUsd !== null ? formatCurrency(attempt.accumulatedDeltaNotionalUsd) : 'n/a'}
                        </TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{attempt.reason ?? 'n/a'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 md:hidden">
                {attempts.map((attempt) => (
                  <details key={attempt.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-[#E7E7E7]">
                          {attempt.side} · {attempt.leaderName ?? 'n/a'}
                        </p>
                        <StatusPill
                          label={attempt.decision}
                          tone={
                            attempt.decision === 'EXECUTED'
                              ? 'positive'
                              : attempt.decision === 'SKIPPED'
                                ? 'warning'
                            : 'neutral'
                          }
                        />
                      </div>
                      <p className="text-xs text-[#919191]">{formatDateTime(attempt.timestamp)}</p>
                    </summary>
                    <div className="mt-2 space-y-1 text-sm [&_p]:break-words">
                      <p className="text-[#CFCFCF]">
                        Accumulated delta:{' '}
                        {attempt.accumulatedDeltaNotionalUsd !== null ? formatCurrency(attempt.accumulatedDeltaNotionalUsd) : 'n/a'}
                      </p>
                      <p className="text-[#E7E7E7]">Reason: {attempt.reason ?? 'n/a'}</p>
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
