'use client'

import Link from 'next/link'
import { FormEvent, useMemo, useState } from 'react'
import { Activity, Clock3, DatabaseZap, Filter, RadioTower } from 'lucide-react'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { StatusPill } from '@/components/dashboard/status-pill'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildTradesQuery } from '@/lib/dashboard/query-builders'
import { formatCurrency, formatDateTime, formatLatencyMs, formatNumber } from '@/lib/format'

interface TradesData {
  items: Array<{
    id: string
    leaderId: string
    leaderName: string
    leaderFillAtMs: string
    wsReceivedAtMs: string | null
    detectedAtMs: string
    detectLagMs: number
    isBackfill: boolean
    wsLagMs: number | null
    marketId: string | null
    marketLabel: string | null
    marketSlug: string | null
    tokenId: string
    outcome: string | null
    side: 'BUY' | 'SELL'
    shares: number
    price: number
    notionalUsd: number
    source: 'CHAIN' | 'DATA_API'
    sourceLabel: 'WebSocket' | 'REST fallback API'
  }>
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

interface LeaderListForFilter {
  items: Array<{
    id: string
    name: string
  }>
}

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const inputClass =
  'h-10 rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] placeholder:text-[#6f6f6f] focus-visible:border-white/20 focus-visible:ring-white/10'

const outlineButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'

function toPolymarketMarketUrl(marketSlug: string | null | undefined): string | null {
  if (!marketSlug) {
    return null
  }
  const normalized = marketSlug.trim().replace(/^\/+|\/+$/g, '')
  if (!normalized) {
    return null
  }
  const encodedPath = normalized
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  if (!encodedPath) {
    return null
  }

  return `https://polymarket.com/event/${encodedPath}`
}

function MarketLink({
  marketSlug,
  marketLabel,
  fallback
}: {
  marketSlug: string | null | undefined
  marketLabel: string | null | undefined
  fallback: string
}) {
  const label = marketLabel ?? fallback
  const href = toPolymarketMarketUrl(marketSlug)
  if (!href) {
    return <span className="text-[#E7E7E7]">{label}</span>
  }
  return (
    <Link href={href} target="_blank" rel="noreferrer" className="text-[#E7E7E7] underline-offset-4 hover:underline">
      {label}
    </Link>
  )
}

export default function TradesPage() {
  const [page, setPage] = useState(1)
  const [leaderFilter, setLeaderFilter] = useState('ALL')
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'CHAIN' | 'DATA_API'>('ALL')
  const [searchInput, setSearchInput] = useState('')
  const [searchFilter, setSearchFilter] = useState('')

  const query = useMemo(() => {
    return buildTradesQuery({
      page,
      pageSize: 50,
      leaderId: leaderFilter === 'ALL' ? undefined : leaderFilter,
      source: sourceFilter,
      search: searchFilter
    })
  }, [leaderFilter, sourceFilter, searchFilter, page])

  const tradesState = useApiQuery<TradesData>(query, { refreshIntervalMs: 15_000 })
  const leadersState = useApiQuery<LeaderListForFilter>('/api/v1/leaders?page=1&pageSize=200', {
    refreshIntervalMs: 30_000
  })

  if (tradesState.isLoading && !tradesState.data) {
    return <LoadingState title="Loading trades" description="Fetching leader trade log and latency metrics." />
  }

  if (tradesState.error && !tradesState.data) {
    return (
      <ErrorState
        title="Trades unavailable"
        description={tradesState.error}
        actionLabel="Retry"
        onAction={() => {
          void tradesState.refresh()
          void leadersState.refresh()
        }}
      />
    )
  }

  if (!tradesState.data) {
    return <EmptyState title="No trades data" description="Trade events appear once leader ingestion starts." />
  }

  const visibleTrades = tradesState.data.items
  const visibleNotional = visibleTrades.reduce((sum, row) => sum + row.notionalUsd, 0)
  const realtimeTrades = visibleTrades.filter((row) => !row.isBackfill)
  const backfillRows = visibleTrades.length - realtimeTrades.length
  const avgDetectLagMs =
    realtimeTrades.length > 0 ? realtimeTrades.reduce((sum, row) => sum + row.detectLagMs, 0) / realtimeTrades.length : 0
  const wsRows = visibleTrades.filter((row) => row.source === 'CHAIN').length
  const restRows = visibleTrades.filter((row) => row.source === 'DATA_API').length

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-10 top-4 h-40 w-40 rounded-full bg-cyan-400/6 blur-3xl" />
          <div className="absolute left-1/3 bottom-0 h-24 w-24 rounded-full bg-[#86efac]/8 blur-2xl" />
        </div>

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Execution Feed</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Trades</h2>
            <p className="max-w-2xl text-sm text-[#919191]">All detected leader trades with latency and source audit fields.</p>
          </div>
          <TimestampBadge value={tradesState.generatedAt} />
        </div>

        <div className="relative mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Visible Trades</p>
              <Activity className="size-4 text-[#86efac]" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatNumber(visibleTrades.length, 0)}</p>
            <p className="text-xs text-[#919191]">Current page rows</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Visible Notional</p>
              <DatabaseZap className="size-4 text-cyan-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(visibleNotional)}</p>
            <p className="text-xs text-[#919191]">Summed on current page</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Avg Detect Lag</p>
              <Clock3 className="size-4 text-amber-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">
              {realtimeTrades.length > 0 ? formatLatencyMs(avgDetectLagMs) : 'Backfill only'}
            </p>
            <p className="text-xs text-[#919191]">
              Current page average{backfillRows > 0 ? ` (excludes ${formatNumber(backfillRows, 0)} backfill)` : ''}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Source Mix</p>
              <RadioTower className="size-4 text-emerald-300" />
            </div>
            <p className="mt-2 text-sm text-[#E7E7E7]">WS {wsRows} · REST {restRows}</p>
            <p className="text-xs text-[#919191]">Current page</p>
          </div>
        </div>
      </section>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Filters</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <Filter className="size-4 text-cyan-300" />
            Filter trades
          </CardTitle>
          <CardDescription className="text-[#919191]">Filter by leader, source, or market/token search terms.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 md:px-6">
          <form
            className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 md:grid-cols-4"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault()
              setPage(1)
              setSearchFilter(searchInput)
            }}
          >
            <Select
              value={leaderFilter}
              onValueChange={(value) => {
                setLeaderFilter(value)
                setPage(1)
              }}
            >
              <SelectTrigger className={`w-full ${inputClass}`}>
                <SelectValue placeholder="Leader" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#0D0D0D] text-[#E7E7E7]">
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="ALL">
                  All leaders
                </SelectItem>
                {(leadersState.data?.items ?? []).map((leader) => (
                  <SelectItem className="focus:bg-white/[0.06] focus:text-white" key={leader.id} value={leader.id}>
                    {leader.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={sourceFilter}
              onValueChange={(value: 'ALL' | 'CHAIN' | 'DATA_API') => {
                setSourceFilter(value)
                setPage(1)
              }}
            >
              <SelectTrigger className={`w-full ${inputClass}`}>
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#0D0D0D] text-[#E7E7E7]">
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="ALL">
                  All sources
                </SelectItem>
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="CHAIN">
                  WebSocket
                </SelectItem>
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="DATA_API">
                  REST fallback API
                </SelectItem>
              </SelectContent>
            </Select>

            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search market, outcome, token id"
              className={`md:col-span-2 ${inputClass}`}
            />
            <Button type="submit" variant="outline" className={`md:col-span-1 ${outlineButtonClass}`}>
              Apply
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Log</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Trades log</CardTitle>
          <CardDescription className="text-[#919191]">50 rows per page, sorted by leader fill timestamp descending.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          {tradesState.data.items.length === 0 ? (
            <EmptyState title="No trades match filters" description="Try broadening filter criteria." />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block">
                <Table>
                  <TableHeader className="[&_tr]:border-white/10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="sticky left-0 bg-[#101010] px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader fill timestamp</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Detect lag</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Shares</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Price/share</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Notional</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-white/5">
                    {tradesState.data.items.map((row) => (
                      <TableRow key={row.id} className="hover:bg-white/[0.03]">
                        <TableCell className="sticky left-0 bg-[#101010] px-3 text-[#CFCFCF]">
                          {formatDateTime(new Date(Number(row.leaderFillAtMs)).toISOString())}
                        </TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">
                          {row.isBackfill ? 'Backfill' : formatLatencyMs(row.detectLagMs)}
                        </TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{row.leaderName}</TableCell>
                        <TableCell className="px-3">
                          <p>
                            <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                          </p>
                          <p className="text-xs text-[#CFCFCF]">{row.outcome ?? 'Unknown outcome'}</p>
                        </TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatNumber(row.shares)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatNumber(row.price, 4)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(row.notionalUsd)}</TableCell>
                        <TableCell className="px-3">
                          <StatusPill label={row.sourceLabel} tone={row.source === 'CHAIN' ? 'positive' : 'warning'} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 md:hidden">
                {tradesState.data.items.map((row) => (
                  <details key={row.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <summary className="cursor-pointer list-none">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-[#E7E7E7]">{row.side} · {formatCurrency(row.notionalUsd)}</p>
                        <StatusPill label={row.sourceLabel} tone={row.source === 'CHAIN' ? 'positive' : 'warning'} />
                      </div>
                      <p className="text-xs text-[#919191]">{formatDateTime(new Date(Number(row.leaderFillAtMs)).toISOString())}</p>
                      <p className="text-xs text-[#919191]">
                        <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                      </p>
                    </summary>
                    <div className="mt-2 space-y-1 text-sm text-[#E7E7E7]">
                      <p>Leader: {row.leaderName}</p>
                      <p>Outcome: {row.outcome ?? 'Unknown outcome'}</p>
                      <p>
                        Market:{' '}
                        <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                      </p>
                      <p className="break-all text-[#CFCFCF]">Market ID: {row.marketId ?? 'n/a'}</p>
                      <p className="break-all text-[#CFCFCF]">Token ID: {row.tokenId}</p>
                      <p>Shares: {formatNumber(row.shares)}</p>
                      <p>Price/share: {formatNumber(row.price, 4)}</p>
                      <p>Detect lag: {row.isBackfill ? 'Backfill' : formatLatencyMs(row.detectLagMs)}</p>
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-xs text-[#919191]">
              Showing <span className="text-[#E7E7E7]">{tradesState.data.items.length}</span> of{' '}
              <span className="text-[#E7E7E7]">{tradesState.data.pagination.total}</span> trades
            </p>
            <PaginationControls
              page={tradesState.data.pagination.page}
              totalPages={tradesState.data.pagination.totalPages}
              onPageChange={(nextPage) => setPage(nextPage)}
              className="flex items-center gap-3 [&_button]:rounded-xl [&_button]:border-white/10 [&_button]:bg-white/[0.02] [&_button]:text-[#E7E7E7] [&_button:hover]:bg-white/[0.06] [&_p]:text-[#919191]"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
