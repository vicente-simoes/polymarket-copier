'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { BarChart3, CandlestickChart, Layers3, PieChart, Wallet } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildPortfolioQuery } from '@/lib/dashboard/query-builders'
import { formatCurrency, formatDateTime, formatNumber, formatSignedCurrency } from '@/lib/format'

type PortfolioRange = '1h' | '24h' | '1w' | '1m'

interface PortfolioData {
  copyProfileId: string | null
  range: PortfolioRange
  summary: {
    exposureUsd: number
    totalValueUsd: number
    realizedPnlUsd: number
    unrealizedPnlUsd: number
    totalPnlUsd: number
    window1hPnlUsd: number
    window24hPnlUsd: number
    window1wPnlUsd: number
    window1mPnlUsd: number
    lastUpdatedAt: string | null
  }
  chart: {
    points: Array<{
      timestamp: string
      exposureUsd: number
      totalValueUsd: number
      totalPnlUsd: number
      realizedPnlUsd: number
      unrealizedPnlUsd: number
    }>
    pointCount: number
    maxPoints: number
  }
  exposureBreakdown: {
    byLeaderTop: Array<{
      leaderId: string
      leaderName: string
      exposureUsd: number
    }>
    byOutcomeTop: Array<{
      tokenId: string
      marketId: string | null
      marketName: string | null
      outcome: string | null
      exposureUsd: number
      isOther: boolean
    }>
  }
  positions: {
    items: Array<{
      tokenId: string
      marketId: string | null
      marketName: string | null
      outcome: string | null
      shares: number
      currentPrice: number
      costBasisUsd: number
      currentValueUsd: number
      unrealizedPnlUsd: number
    }>
    pagination: {
      page: number
      pageSize: number
      total: number
      totalPages: number
    }
  }
}

const RANGE_OPTIONS: PortfolioRange[] = ['1h', '24h', '1w', '1m']

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const chartFrameClass = 'h-64 w-full rounded-xl border border-white/10 bg-white/[0.02] p-2 sm:h-72'
const darkOutlineButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'

function chartLabel(timestamp: string): string {
  const date = new Date(timestamp)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function outcomeLabel(row: {
  tokenId: string
  marketName: string | null
  outcome: string | null
  isOther: boolean
}): string {
  if (row.isOther) {
    return 'Other'
  }
  if (row.marketName) {
    return row.marketName
  }
  if (row.outcome) {
    return row.outcome
  }
  return row.tokenId
}

export default function PortfolioPage() {
  const [range, setRange] = useState<PortfolioRange>('24h')
  const [page, setPage] = useState(1)

  const query = useMemo(() => {
    return buildPortfolioQuery({
      range,
      page,
      pageSize: 50
    })
  }, [range, page])

  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<PortfolioData>(query, {
    refreshIntervalMs: 20_000
  })

  if (isLoading && !data) {
    return <LoadingState title="Loading portfolio" description="Fetching summary cards and chart series." />
  }

  if (error && !data) {
    return <ErrorState title="Portfolio unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="No portfolio data" description="Run the worker reconcile cycle to populate snapshots." />
  }

  const chartPoints = data.chart.points.map((point) => ({
    ...point,
    label: chartLabel(point.timestamp)
  }))
  const outcomeChartData = data.exposureBreakdown.byOutcomeTop.map((outcome) => ({
    ...outcome,
    label: outcomeLabel(outcome)
  }))

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-10 top-4 h-40 w-40 rounded-full bg-cyan-400/6 blur-3xl" />
          <div className="absolute right-0 bottom-0 h-56 w-56 rounded-full bg-[#86efac]/8 blur-3xl" />
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Portfolio</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Exposure & PnL</h2>
            <p className="max-w-2xl text-sm text-[#919191]">PnL, exposure concentration, and open positions.</p>
            <div className="flex flex-wrap gap-2 pt-1">
              <div className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-[#919191]">
                Profile {data.copyProfileId ?? 'not configured'}
              </div>
              <div className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-[#919191]">
                Range {range}
              </div>
            </div>
          </div>
          <TimestampBadge value={generatedAt} />
        </div>

        <div className="relative mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Exposure</p>
              <Layers3 className="size-4 text-cyan-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(data.summary.exposureUsd)}</p>
            <p className="text-xs text-[#919191]">Updated {formatDateTime(data.summary.lastUpdatedAt)}</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Portfolio Value</p>
              <Wallet className="size-4 text-[#86efac]" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(data.summary.totalValueUsd)}</p>
            <p className="text-xs text-[#919191]">Current marked value</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Total PnL</p>
              <CandlestickChart className="size-4 text-emerald-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatSignedCurrency(data.summary.totalPnlUsd)}</p>
            <p className="text-xs text-[#919191]">
              Realized {formatSignedCurrency(data.summary.realizedPnlUsd)} · Unrealized {formatSignedCurrency(data.summary.unrealizedPnlUsd)}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Positions</p>
              <PieChart className="size-4 text-amber-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatNumber(data.positions.pagination.total, 0)}</p>
            <p className="text-xs text-[#919191]">Tracked open position rows</p>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={`${panelClass} p-4`}>
          <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">1h PnL</p>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatSignedCurrency(data.summary.window1hPnlUsd)}</p>
          <p className="text-xs text-[#919191]">Combined realized + unrealized</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">24h PnL</p>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatSignedCurrency(data.summary.window24hPnlUsd)}</p>
          <p className="text-xs text-[#919191]">Combined realized + unrealized</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">1w PnL</p>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatSignedCurrency(data.summary.window1wPnlUsd)}</p>
          <p className="text-xs text-[#919191]">Combined realized + unrealized</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">1m PnL</p>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatSignedCurrency(data.summary.window1mPnlUsd)}</p>
          <p className="text-xs text-[#919191]">Combined realized + unrealized</p>
        </div>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Trend</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <BarChart3 className="size-4 text-[#86efac]" />
            PnL graph
          </CardTitle>
          <CardDescription className="text-[#919191]">
            Range {range} · {data.chart.pointCount}/{data.chart.maxPoints} points
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-5 md:px-6">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {RANGE_OPTIONS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === range ? 'default' : 'outline'}
                className={`shrink-0 ${option === range
                  ? 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]'
                  : darkOutlineButtonClass
                }`}
                onClick={() => {
                  setRange(option)
                  setPage(1)
                }}
              >
                {option}
              </Button>
            ))}
          </div>

          <div className={chartFrameClass}>
            {chartPoints.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-[#919191]">No chart points for this range.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartPoints}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                  <XAxis dataKey="label" minTickGap={24} tick={{ fill: '#919191', fontSize: 11 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickLine={{ stroke: 'rgba(255,255,255,0.1)' }} height={34} />
                  <YAxis
                    tickFormatter={(value) => `$${Math.trunc(value)}`}
                    width={56}
                    tick={{ fill: '#919191', fontSize: 11 }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                    tickLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                  />
                  <Tooltip
                    formatter={(value: number) => formatCurrency(value)}
                    labelFormatter={(value) => String(value)}
                    contentStyle={{
                      borderRadius: 12,
                      border: '1px solid rgba(255,255,255,0.12)',
                      background: 'rgba(13,13,13,0.96)',
                      color: '#E7E7E7'
                    }}
                    labelStyle={{ color: '#CFCFCF' }}
                    itemStyle={{ color: '#E7E7E7' }}
                  />
                  <Line type="monotone" dataKey="totalPnlUsd" stroke="#86efac" strokeWidth={2} dot={false} name="Total PnL" />
                  <Line type="monotone" dataKey="exposureUsd" stroke="#38bdf8" strokeWidth={2} dot={false} name="Exposure" />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Breakdown</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Exposure by leader</CardTitle>
            <CardDescription className="text-[#919191]">Top 4 leaders by exposure.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 md:px-6">
            {data.exposureBreakdown.byLeaderTop.length === 0 ? (
              <p className="text-sm text-[#919191]">No leader exposure found.</p>
            ) : (
              <div className="h-56 w-full rounded-xl border border-white/10 bg-white/[0.02] p-2 sm:h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.exposureBreakdown.byLeaderTop} layout="vertical" margin={{ left: 12, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis
                      type="number"
                      tickFormatter={(value) => `$${Math.trunc(value)}`}
                      tick={{ fill: '#919191', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                    />
                    <YAxis
                      type="category"
                      dataKey="leaderName"
                      width={88}
                      tick={{ fill: '#CFCFCF', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                    />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value)}
                      contentStyle={{
                        borderRadius: 12,
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(13,13,13,0.96)',
                        color: '#E7E7E7'
                      }}
                    />
                    <Bar dataKey="exposureUsd" fill="#86efac" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Breakdown</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Exposure by market/outcome</CardTitle>
            <CardDescription className="text-[#919191]">Top 10 outcomes plus Other.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 md:px-6">
            {outcomeChartData.length === 0 ? (
              <p className="text-sm text-[#919191]">No outcome exposure found.</p>
            ) : (
              <div className="h-64 w-full rounded-xl border border-white/10 bg-white/[0.02] p-2 sm:h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={outcomeChartData} layout="vertical" margin={{ left: 12, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
                    <XAxis
                      type="number"
                      tickFormatter={(value) => `$${Math.trunc(value)}`}
                      tick={{ fill: '#919191', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                    />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={96}
                      tickFormatter={(value) => String(value).slice(0, 20)}
                      tick={{ fill: '#CFCFCF', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                      tickLine={{ stroke: 'rgba(255,255,255,0.1)' }}
                    />
                    <Tooltip
                      formatter={(value: number) => formatCurrency(value)}
                      labelFormatter={(_, payload) => {
                        const point = payload?.[0]?.payload as { marketName?: string | null; outcome?: string | null; marketId?: string | null; tokenId?: string; label?: string } | undefined
                        const market = point?.marketName ?? point?.marketId ?? point?.tokenId ?? 'n/a'
                        const outcome = point?.outcome ?? null
                        if (outcome) {
                          return `${market} · ${outcome}`
                        }
                        return point?.label ?? market
                      }}
                      contentStyle={{
                        borderRadius: 12,
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'rgba(13,13,13,0.96)',
                        color: '#E7E7E7'
                      }}
                    />
                    <Bar dataKey="exposureUsd" fill="#38bdf8" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Positions</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Current holdings</CardTitle>
          <CardDescription className="text-[#919191]">Tap a row to open position detail.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          {data.positions.items.length === 0 ? (
            <EmptyState title="No open positions" description="Positions will appear after fills settle." />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block">
                <Table>
                  <TableHeader className="[&_tr]:border-white/10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="sticky left-0 bg-[#101010] px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market / Outcome</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Shares</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Price</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Cost basis</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Current value</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Unrealized PnL</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-white/5">
                    {data.positions.items.map((position) => (
                      <TableRow key={position.tokenId} className="hover:bg-white/[0.03]">
                        <TableCell className="sticky left-0 bg-[#101010] px-3">
                          <Link href={`/portfolio/positions/${position.tokenId}`} className="text-[#E7E7E7] hover:text-white hover:underline">
                            {position.marketName ?? position.marketId ?? position.tokenId}
                          </Link>
                          <p className="text-xs text-[#919191]">{position.outcome ?? 'Unknown outcome'}</p>
                        </TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatNumber(position.shares)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatNumber(position.currentPrice, 4)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(position.costBasisUsd)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(position.currentValueUsd)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{formatSignedCurrency(position.unrealizedPnlUsd)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 md:hidden">
                {data.positions.items.map((position) => (
                  <details key={position.tokenId} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <summary className="cursor-pointer list-none">
                      <p className="font-medium text-[#E7E7E7]">{position.outcome ?? 'Unknown outcome'}</p>
                      <p className="text-xs text-[#919191]">{position.marketName ?? position.marketId ?? position.tokenId}</p>
                      <p className="text-sm text-[#E7E7E7]">{formatCurrency(position.currentValueUsd)}</p>
                    </summary>
                    <div className="mt-3 space-y-1 text-sm text-[#E7E7E7]">
                      <p>Shares: {formatNumber(position.shares)}</p>
                      <p>Price: {formatNumber(position.currentPrice, 4)}</p>
                      <p>Cost basis: {formatCurrency(position.costBasisUsd)}</p>
                      <p>Unrealized PnL: {formatSignedCurrency(position.unrealizedPnlUsd)}</p>
                      <Button asChild size="sm" variant="outline" className={darkOutlineButtonClass}>
                        <Link href={`/portfolio/positions/${position.tokenId}`}>View details</Link>
                      </Button>
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-xs text-[#919191]">
              Showing <span className="text-[#E7E7E7]">{data.positions.items.length}</span> of{' '}
              <span className="text-[#E7E7E7]">{data.positions.pagination.total}</span> positions
            </p>
            <PaginationControls
              page={data.positions.pagination.page}
              totalPages={data.positions.pagination.totalPages}
              onPageChange={(nextPage) => setPage(nextPage)}
              className="flex items-center gap-3 [&_button]:rounded-xl [&_button]:border-white/10 [&_button]:bg-white/[0.02] [&_button]:text-[#E7E7E7] [&_button:hover]:bg-white/[0.06] [&_p]:text-[#919191]"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
