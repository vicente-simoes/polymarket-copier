'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { CircleGauge, ClipboardList, Clock3, Layers3, ListChecks, Workflow } from 'lucide-react'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatusPill } from '@/components/dashboard/status-pill'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { buildCopiesQuery } from '@/lib/dashboard/query-builders'
import { formatCurrency, formatDateTime, formatNumber, formatRelativeSeconds } from '@/lib/format'

type Section = 'open' | 'attempting' | 'executions' | 'skipped'

interface CopiesData {
  section: Section
  summary: {
    clobAuthentication: {
      status: 'OK' | 'ERROR' | 'UNKNOWN'
      lastCheckedAt: string | null
    }
    userChannel: {
      status: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN'
      lastMessageAt: string | null
    }
    lastReconcileAt: string | null
    timeSinceLastReconcileSeconds: number | null
    pendingBelowMinCount: number
    openOrdersCount: number
  }
  open: {
    items: Array<{
      id: string
      createdAt: string
      leaderId: string | null
      leaderName: string | null
      leaderNames: string[]
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      marketSlug: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      pendingNotionalUsd: number
      minExecutableNotionalUsd: number
      minOrderSizeShares: number | null
      pendingShares: number
      status: 'PENDING' | 'ELIGIBLE' | 'BLOCKED' | 'EXPIRED' | 'CONVERTED'
      blockReason: string | null
      expiresAt: string | null
    }>
    pagination: {
      page: number
      pageSize: number
      total: number
      totalPages: number
    }
  } | null
  attempting: {
    items: Array<{
      id: string
      createdAt: string
      attemptedAt: string | null
      leaderId: string | null
      leaderName: string | null
      leaderNames: string[]
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      marketSlug: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      accumulatedDeltaNotionalUsd: number
      accumulatedDeltaShares: number
      spreadState: 'LIVE' | 'STALE' | 'UNAVAILABLE'
      spreadAgeMs: number | null
      currentSpreadUsd: number | null
      retries: number
      maxRetries: number
      status: 'PENDING' | 'RETRYING' | 'EXECUTING'
      reason: string | null
      message: string | null
      lastOrderStatus: 'PLACED' | 'PARTIALLY_FILLED' | 'FILLED' | 'FAILED' | 'CANCELLED' | 'RETRYING' | null
      lastOrderError: string | null
      pendingStatus: 'PENDING' | 'ELIGIBLE' | 'BLOCKED' | 'EXPIRED' | 'CONVERTED' | null
      pendingBlockReason: string | null
    }>
    pagination: {
      page: number
      pageSize: number
      total: number
      totalPages: number
    }
  } | null
  executions: {
    items: Array<{
      id: string
      copyAttemptId: string | null
      attemptedAt: string
      leaderId: string | null
      leaderName: string | null
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      marketSlug: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      intendedNotionalUsd: number
      intendedShares: number
      priceLimit: number
      externalOrderId: string | null
      feePaidUsd: number
      status: 'PLACED' | 'PARTIALLY_FILLED' | 'FILLED' | 'FAILED' | 'CANCELLED' | 'RETRYING'
      reason: string | null
      errorMessage: string | null
      accumulatedDeltaNotionalUsd: number | null
      retryCount: number
      lastRetryAt: string | null
    }>
    pagination: {
      page: number
      pageSize: number
      total: number
      totalPages: number
    }
  } | null
  skipped: {
    mode: 'groups' | 'details'
    groups: Array<{
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      marketSlug: string | null
      outcome: string | null
      skipCount: number
      lastSkippedAt: string
      topReason: string | null
    }> | null
    details: Array<{
      id: string
      createdAt: string
      attemptedAt: string | null
      leaderId: string | null
      leaderName: string | null
      tokenId: string
      marketId: string | null
      marketLabel: string | null
      marketSlug: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      reason: string | null
      accumulatedDeltaNotionalUsd: number
    }> | null
    pagination: {
      page: number
      pageSize: number
      total: number
      totalPages: number
    }
  } | null
}

function statusTone(status: string): 'positive' | 'warning' | 'negative' | 'neutral' {
  if (status === 'OK' || status === 'CONNECTED' || status === 'FILLED') {
    return 'positive'
  }
  if (status === 'ERROR' || status === 'DISCONNECTED' || status === 'FAILED') {
    return 'negative'
  }
  if (status === 'RETRYING' || status === 'BLOCKED') {
    return 'warning'
  }
  return 'neutral'
}

function clobAuthPillClass(status: CopiesData['summary']['clobAuthentication']['status']): string {
  if (status === 'OK') {
    return 'border-emerald-400/45 bg-emerald-500/20 text-emerald-300'
  }
  if (status === 'ERROR') {
    return 'border-rose-400/45 bg-rose-500/20 text-rose-300'
  }
  return 'border-cyan-400/45 bg-cyan-500/20 text-cyan-300'
}

function userChannelPillClass(status: CopiesData['summary']['userChannel']['status']): string {
  if (status === 'CONNECTED') {
    return 'border-cyan-400/45 bg-cyan-500/20 text-cyan-300'
  }
  if (status === 'DISCONNECTED') {
    return 'border-rose-400/45 bg-rose-500/20 text-rose-300'
  }
  return 'border-amber-400/45 bg-amber-500/20 text-amber-300'
}

function formatCurrencyDetailed(value: number, maxFractionDigits = 6): string {
  if (!Number.isFinite(value)) {
    return '$0'
  }

  return (
    '$' +
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: maxFractionDigits
    }).format(value)
  )
}

type OpenRow = NonNullable<CopiesData['open']>['items'][number]
type AttemptingRow = NonNullable<CopiesData['attempting']>['items'][number]

function openLeaderLabel(row: OpenRow): string {
  if (row.leaderNames.length > 0) {
    return row.leaderNames.join(', ')
  }
  return row.leaderName ?? 'n/a'
}

function openStatusTone(row: OpenRow): 'positive' | 'warning' | 'negative' | 'neutral' {
  if (row.blockReason) {
    return 'warning'
  }
  return statusTone(row.status)
}

function openStatusLabel(row: OpenRow): string {
  return row.status
}

function openStatusDetail(row: OpenRow): string {
  return row.blockReason ?? 'n/a'
}

function attemptingLeaderLabel(row: AttemptingRow): string {
  if (row.leaderNames.length > 0) {
    return row.leaderNames.join(', ')
  }
  return row.leaderName ?? 'n/a'
}

function attemptingStatusTone(status: AttemptingRow['status']): 'warning' | 'neutral' {
  if (status === 'RETRYING') {
    return 'warning'
  }
  return 'neutral'
}

function humanizeReasonText(value: string): string {
  if (!/^[A-Z0-9_]+$/.test(value)) {
    return value
  }

  return value
    .toLowerCase()
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function attemptingReason(row: AttemptingRow): string {
  const reason = row.message ?? row.lastOrderError ?? row.reason ?? row.pendingBlockReason ?? 'n/a'
  return humanizeReasonText(reason)
}

function attemptingPricePerShareUsd(row: AttemptingRow): number | null {
  if (!Number.isFinite(row.accumulatedDeltaShares) || row.accumulatedDeltaShares <= 0) {
    return null
  }
  if (!Number.isFinite(row.accumulatedDeltaNotionalUsd) || row.accumulatedDeltaNotionalUsd <= 0) {
    return null
  }
  return row.accumulatedDeltaNotionalUsd / row.accumulatedDeltaShares
}

function attemptingSpreadLabel(row: AttemptingRow): string {
  if (row.spreadState === 'LIVE' && row.currentSpreadUsd !== null) {
    return formatCurrencyDetailed(row.currentSpreadUsd, 6)
  }
  if (row.spreadState === 'STALE') {
    return 'STALE'
  }
  return 'n/a'
}

function attemptingSpreadDetail(row: AttemptingRow): string | null {
  if (row.spreadState !== 'STALE' || row.spreadAgeMs === null) {
    return null
  }
  return `${Math.max(1, Math.trunc(row.spreadAgeMs / 1000))}s old`
}

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

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const tableWrapClass = 'hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block'
const outlineButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'
const mobileCardClass = 'rounded-xl border border-white/10 bg-white/[0.02] p-3'

export default function CopiesPage() {
  const [section, setSection] = useState<Section>('open')
  const [page, setPage] = useState(1)
  const [selectedSkippedToken, setSelectedSkippedToken] = useState<string | null>(null)

  const query = useMemo(() => {
    return buildCopiesQuery({
      section,
      page,
      pageSize: 50,
      tokenId: selectedSkippedToken
    })
  }, [section, page, selectedSkippedToken])

  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<CopiesData>(query, {
    refreshIntervalMs: 10_000
  })

  if (isLoading && !data) {
    return <LoadingState title="Loading copy pipeline" description="Fetching pending copies, executions, and skipped attempts." />
  }

  if (error && !data) {
    return <ErrorState title="Copies unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="No copies data" description="Copy pipeline entries will appear after trade detection and reconcile cycles." />
  }

  const pagination = data.open?.pagination ?? data.attempting?.pagination ?? data.executions?.pagination ?? data.skipped?.pagination
  const visibleRows =
    section === 'open'
      ? (data.open?.items.length ?? 0)
      : section === 'attempting'
        ? (data.attempting?.items.length ?? 0)
        : section === 'executions'
        ? (data.executions?.items.length ?? 0)
        : selectedSkippedToken
          ? (data.skipped?.details?.length ?? 0)
          : (data.skipped?.groups?.length ?? 0)

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-10 top-6 h-40 w-40 rounded-full bg-[#86efac]/8 blur-3xl" />
          <div className="absolute left-1/4 bottom-0 h-24 w-24 rounded-full bg-cyan-400/6 blur-2xl" />
        </div>

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Pipeline</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Copies</h2>
            <p className="max-w-2xl text-sm text-[#919191]">Open potential copies, in-flight attempts, execution records, and skipped outcomes.</p>
          </div>
          <TimestampBadge value={generatedAt} />
        </div>

        <div className="relative mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">CLOB Auth</p>
              <CircleGauge className="size-4 text-[#86efac]" />
            </div>
            <div className="mt-2">
              <StatusPill
                label={data.summary.clobAuthentication.status}
                tone={statusTone(data.summary.clobAuthentication.status)}
                className={clobAuthPillClass(data.summary.clobAuthentication.status)}
              />
            </div>
            <p className="mt-2 text-xs text-[#919191]">{formatDateTime(data.summary.clobAuthentication.lastCheckedAt)}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">User Channel WS</p>
              <Workflow className="size-4 text-cyan-300" />
            </div>
            <div className="mt-2">
              <StatusPill
                label={data.summary.userChannel.status}
                tone={statusTone(data.summary.userChannel.status)}
                className={userChannelPillClass(data.summary.userChannel.status)}
              />
            </div>
            <p className="mt-2 text-xs text-[#919191]">{formatDateTime(data.summary.userChannel.lastMessageAt)}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Last Reconcile</p>
              <Clock3 className="size-4 text-amber-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatRelativeSeconds(data.summary.timeSinceLastReconcileSeconds)}</p>
            <p className="text-xs text-[#919191]">{formatDateTime(data.summary.lastReconcileAt)}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Pending &lt; $1</p>
              <Layers3 className="size-4 text-emerald-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatNumber(data.summary.pendingBelowMinCount, 0)}</p>
            <p className="text-xs text-[#919191]">Below minimum threshold</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Open Orders</p>
              <ClipboardList className="size-4 text-cyan-300" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatNumber(data.summary.openOrdersCount, 0)}</p>
            <p className="text-xs text-[#919191]">Venue orders outstanding</p>
          </div>
        </div>
      </section>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Sections</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <ListChecks className="size-4 text-[#86efac]" />
            Pipeline sections
          </CardTitle>
          <CardDescription className="text-[#919191]">Each section is paginated at 50 rows.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={section === 'open' ? 'default' : 'outline'}
              className={section === 'open' ? 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]' : outlineButtonClass}
              onClick={() => {
                setSection('open')
                setPage(1)
                setSelectedSkippedToken(null)
              }}
            >
              Open potential copies
            </Button>
            <Button
              size="sm"
              variant={section === 'attempting' ? 'default' : 'outline'}
              className={section === 'attempting' ? 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]' : outlineButtonClass}
              onClick={() => {
                setSection('attempting')
                setPage(1)
                setSelectedSkippedToken(null)
              }}
            >
              Attempting
            </Button>
            <Button
              size="sm"
              variant={section === 'executions' ? 'default' : 'outline'}
              className={section === 'executions' ? 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]' : outlineButtonClass}
              onClick={() => {
                setSection('executions')
                setPage(1)
                setSelectedSkippedToken(null)
              }}
            >
              Executions
            </Button>
            <Button
              size="sm"
              variant={section === 'skipped' ? 'default' : 'outline'}
              className={section === 'skipped' ? 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]' : outlineButtonClass}
              onClick={() => {
                setSection('skipped')
                setPage(1)
              }}
            >
              Skipped attempts
            </Button>
          </div>

          {section === 'open' ? <OpenSection data={data} /> : null}
          {section === 'attempting' ? <AttemptingSection data={data} /> : null}
          {section === 'executions' ? <ExecutionsSection data={data} /> : null}
          {section === 'skipped' ? (
            <SkippedSection
              data={data}
              selectedTokenId={selectedSkippedToken}
              onSelectToken={(tokenId) => {
                setSelectedSkippedToken(tokenId)
                setPage(1)
              }}
              onBackToGroups={() => {
                setSelectedSkippedToken(null)
                setPage(1)
              }}
            />
          ) : null}

          {pagination ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
              <p className="text-xs text-[#919191]">
                Showing <span className="text-[#E7E7E7]">{visibleRows}</span> of{' '}
                <span className="text-[#E7E7E7]">{pagination.total}</span> rows
              </p>
              <PaginationControls
                page={pagination.page}
                totalPages={pagination.totalPages}
                onPageChange={(nextPage) => setPage(nextPage)}
                className="flex items-center gap-3 [&_button]:rounded-xl [&_button]:border-white/10 [&_button]:bg-white/[0.02] [&_button]:text-[#E7E7E7] [&_button:hover]:bg-white/[0.06] [&_p]:text-[#919191]"
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

function OpenSection({ data }: { data: CopiesData }) {
  const rows = data.open?.items ?? []

  if (rows.length === 0) {
    return <EmptyState title="No open potential copies" description="No pending or blocked potential copies currently." />
  }

  return (
    <>
      <div className={tableWrapClass}>
        <Table>
          <TableHeader className="[&_tr]:border-white/10">
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Created at</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Pending notional</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Status/block reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-white/5">
            {rows.map((row) => (
              <TableRow key={row.id} className="hover:bg-white/[0.03]">
                <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(row.createdAt)}</TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{openLeaderLabel(row)}</TableCell>
                <TableCell className="px-3">
                  <p>
                    <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                  </p>
                  <p className="text-xs text-[#919191]">{row.outcome ?? row.tokenId}</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                <TableCell className="px-3">
                  <p className="text-[#E7E7E7]">{formatCurrencyDetailed(row.pendingNotionalUsd)}</p>
                  <p className="text-xs text-[#919191]">min {formatCurrencyDetailed(row.minExecutableNotionalUsd)}</p>
                </TableCell>
                <TableCell className="px-3">
                  <StatusPill label={openStatusLabel(row)} tone={openStatusTone(row)} />
                  <p className="mt-1 text-xs text-[#919191]">{openStatusDetail(row)}</p>
                  {row.blockReason === 'MIN_ORDER_SIZE' && row.minOrderSizeShares !== null ? (
                    <p className="text-xs text-[#919191]">min size {formatNumber(row.minOrderSizeShares, 6)} shares</p>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <details key={row.id} className={mobileCardClass}>
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-[#E7E7E7]">{row.side} · {formatCurrencyDetailed(row.pendingNotionalUsd)}</p>
                <StatusPill label={openStatusLabel(row)} tone={openStatusTone(row)} />
              </div>
              <p className="text-xs text-[#919191]">{formatDateTime(row.createdAt)}</p>
            </summary>
            <div className="mt-2 space-y-1 text-sm text-[#E7E7E7]">
              <p>Leader: {openLeaderLabel(row)}</p>
              <p>Token: {row.tokenId}</p>
              <p>
                Market:{' '}
                <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
              </p>
              <p>Outcome: {row.outcome ?? 'Unknown outcome'}</p>
              <p>Status detail: {openStatusDetail(row)}</p>
              {row.blockReason === 'MIN_ORDER_SIZE' && row.minOrderSizeShares !== null ? (
                <p>Min order size: {formatNumber(row.minOrderSizeShares, 6)} shares</p>
              ) : null}
              <p>Pending notional: {formatCurrencyDetailed(row.pendingNotionalUsd)}</p>
              <p>Min executable: {formatCurrencyDetailed(row.minExecutableNotionalUsd)}</p>
              <p>Pending shares: {formatNumber(row.pendingShares)}</p>
            </div>
          </details>
        ))}
      </div>
    </>
  )
}

function AttemptingSection({ data }: { data: CopiesData }) {
  const rows = data.attempting?.items ?? []

  if (rows.length === 0) {
    return <EmptyState title="No in-flight attempts" description="No potential copies are currently being attempted." />
  }

  return (
    <>
      <div className={tableWrapClass}>
        <Table>
          <TableHeader className="[&_tr]:border-white/10">
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Created at</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Attempt size</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Price/share</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Spread</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Status</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Why delayed/blocked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-white/5">
            {rows.map((row) => (
              <TableRow key={row.id} className="hover:bg-white/[0.03]">
                <TableCell className="px-3 text-[#CFCFCF]">
                  <p>{formatDateTime(row.createdAt)}</p>
                  {row.attemptedAt ? <p className="text-xs text-[#919191]">last {formatDateTime(row.attemptedAt)}</p> : null}
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{attemptingLeaderLabel(row)}</TableCell>
                <TableCell className="px-3">
                  <p>
                    <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                  </p>
                  <p className="text-xs text-[#919191]">{row.outcome ?? row.tokenId}</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                <TableCell className="px-3">
                  <p className="text-[#E7E7E7]">{formatCurrencyDetailed(row.accumulatedDeltaNotionalUsd)}</p>
                  <p className="text-xs text-[#919191]">{formatNumber(row.accumulatedDeltaShares, 6)} shares</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">
                  {attemptingPricePerShareUsd(row) === null ? 'n/a' : formatCurrencyDetailed(attemptingPricePerShareUsd(row) ?? 0, 6)}
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">
                  <p>{attemptingSpreadLabel(row)}</p>
                  {attemptingSpreadDetail(row) ? <p className="text-xs text-[#919191]">{attemptingSpreadDetail(row)}</p> : null}
                </TableCell>
                <TableCell className="px-3">
                  <StatusPill label={row.status} tone={attemptingStatusTone(row.status)} />
                  <p className="mt-1 text-xs text-[#919191]">
                    retries {row.retries}/{row.maxRetries}
                  </p>
                  {row.lastOrderStatus ? <p className="text-xs text-[#919191]">last order {row.lastOrderStatus}</p> : null}
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">
                  <p>{attemptingReason(row)}</p>
                  {row.pendingBlockReason ? (
                    <p className="text-xs text-[#919191]">pending block {humanizeReasonText(row.pendingBlockReason)}</p>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <details key={row.id} className={mobileCardClass}>
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-[#E7E7E7]">
                  {row.side} · {formatCurrencyDetailed(row.accumulatedDeltaNotionalUsd)}
                </p>
                <StatusPill label={row.status} tone={attemptingStatusTone(row.status)} />
              </div>
              <p className="text-xs text-[#919191]">{formatDateTime(row.createdAt)}</p>
            </summary>
            <div className="mt-2 space-y-1 text-sm text-[#E7E7E7]">
              <p>Leader: {attemptingLeaderLabel(row)}</p>
              <p>Token: {row.tokenId}</p>
              <p>
                Market:{' '}
                <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
              </p>
              <p>Outcome: {row.outcome ?? 'Unknown outcome'}</p>
              <p>Retries: {row.retries}/{row.maxRetries}</p>
              {row.attemptedAt ? <p>Last attempt: {formatDateTime(row.attemptedAt)}</p> : null}
              {row.lastOrderStatus ? <p>Last order status: {row.lastOrderStatus}</p> : null}
              <p>Reason: {attemptingReason(row)}</p>
              {row.pendingBlockReason ? <p>Pending block: {humanizeReasonText(row.pendingBlockReason)}</p> : null}
              <p>Attempt notional: {formatCurrencyDetailed(row.accumulatedDeltaNotionalUsd)}</p>
              <p>Attempt shares: {formatNumber(row.accumulatedDeltaShares, 6)}</p>
              <p>
                Price/share:{' '}
                {attemptingPricePerShareUsd(row) === null ? 'n/a' : formatCurrencyDetailed(attemptingPricePerShareUsd(row) ?? 0, 6)}
              </p>
              <p>Current spread: {attemptingSpreadLabel(row)}</p>
              {attemptingSpreadDetail(row) ? <p>Spread age: {attemptingSpreadDetail(row)}</p> : null}
            </div>
          </details>
        ))}
      </div>
    </>
  )
}

function ExecutionsSection({ data }: { data: CopiesData }) {
  const rows = data.executions?.items ?? []

  if (rows.length === 0) {
    return <EmptyState title="No execution attempts" description="Order attempts will appear after pending deltas become executable." />
  }

  return (
    <>
      <div className={tableWrapClass}>
        <Table>
          <TableHeader className="[&_tr]:border-white/10">
            <TableRow className="hover:bg-transparent">
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Attempted at</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Notional / shares</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Price cap</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Order id</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Fee</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Status</TableHead>
              <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Reason/error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-white/5">
            {rows.map((row) => (
              <TableRow key={row.id} className="hover:bg-white/[0.03]">
                <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(row.attemptedAt)}</TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{row.leaderName ?? 'n/a'}</TableCell>
                <TableCell className="px-3">
                  <p>
                    <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                  </p>
                  <p className="text-xs text-[#919191]">{row.outcome ?? row.tokenId}</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                <TableCell className="px-3">
                  <p className="text-[#E7E7E7]">{formatCurrency(row.intendedNotionalUsd)}</p>
                  <p className="text-xs text-[#919191]">{formatNumber(row.intendedShares)} shares</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{formatNumber(row.priceLimit, 4)}</TableCell>
                <TableCell className="px-3">
                  <p className="font-mono text-xs text-[#E7E7E7]">{row.externalOrderId ?? 'n/a'}</p>
                  <p className="text-xs text-[#919191]">internal {row.id}</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(row.feePaidUsd)}</TableCell>
                <TableCell className="px-3">
                  <StatusPill label={row.status} tone={row.status === 'PLACED' ? 'positive' : statusTone(row.status)} />
                  {row.retryCount > 0 ? <p className="mt-1 text-xs text-[#919191]">Retries: {row.retryCount}</p> : null}
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{row.errorMessage ?? row.reason ?? 'n/a'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <details key={row.id} className={mobileCardClass}>
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-[#E7E7E7]">{row.side} · {formatCurrency(row.intendedNotionalUsd)}</p>
                <StatusPill label={row.status} tone={row.status === 'PLACED' ? 'positive' : statusTone(row.status)} />
              </div>
              <p className="text-xs text-[#919191]">{formatDateTime(row.attemptedAt)}</p>
            </summary>
            <div className="mt-2 space-y-1 text-sm text-[#E7E7E7]">
              <p>Leader: {row.leaderName ?? 'n/a'}</p>
              <p>Token: {row.tokenId}</p>
              <p>
                Market:{' '}
                <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
              </p>
              <p>Outcome: {row.outcome ?? 'Unknown outcome'}</p>
              <p>Price cap: {formatNumber(row.priceLimit, 4)}</p>
              <p>Order id: {row.externalOrderId ?? 'n/a'}</p>
              <p>Internal id: {row.id}</p>
              <p>Fee: {formatCurrency(row.feePaidUsd)}</p>
              <p>Retries: {row.retryCount}</p>
              <p>Reason: {row.errorMessage ?? row.reason ?? 'n/a'}</p>
            </div>
          </details>
        ))}
      </div>
    </>
  )
}

function SkippedSection({
  data,
  selectedTokenId,
  onSelectToken,
  onBackToGroups
}: {
  data: CopiesData
  selectedTokenId: string | null
  onSelectToken: (tokenId: string) => void
  onBackToGroups: () => void
}) {
  const groups = data.skipped?.groups ?? []
  const details = data.skipped?.details ?? []

  if (!selectedTokenId) {
    if (groups.length === 0) {
      return <EmptyState title="No skipped groups" description="No expired or permanently skipped attempts found." />
    }

    return (
      <>
        <div className={tableWrapClass}>
          <Table>
            <TableHeader className="[&_tr]:border-white/10">
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Market</TableHead>
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Token id</TableHead>
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Outcome</TableHead>
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Skip count</TableHead>
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Top reason</TableHead>
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Last skipped at</TableHead>
                <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]" />
              </TableRow>
            </TableHeader>
            <TableBody className="[&_tr]:border-white/5">
              {groups.map((group) => (
                <TableRow key={group.tokenId} className="hover:bg-white/[0.03]">
                  <TableCell className="px-3">
                    <MarketLink marketSlug={group.marketSlug} marketLabel={group.marketLabel} fallback={group.marketId ?? group.tokenId} />
                  </TableCell>
                  <TableCell className="px-3 font-mono text-xs text-[#CFCFCF]">{group.tokenId}</TableCell>
                  <TableCell className="px-3 text-[#E7E7E7]">{group.outcome ?? 'Unknown outcome'}</TableCell>
                  <TableCell className="px-3 text-[#E7E7E7]">{formatNumber(group.skipCount, 0)}</TableCell>
                  <TableCell className="px-3 text-[#E7E7E7]">{group.topReason ?? 'n/a'}</TableCell>
                  <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(group.lastSkippedAt)}</TableCell>
                  <TableCell className="px-3">
                    <Button size="sm" variant="outline" className={outlineButtonClass} onClick={() => onSelectToken(group.tokenId)}>
                      View details
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-2 md:hidden">
          {groups.map((group) => (
            <div key={group.tokenId} className={mobileCardClass}>
              <p className="text-sm font-medium">
                <MarketLink marketSlug={group.marketSlug} marketLabel={group.marketLabel} fallback={group.marketId ?? group.tokenId} />
              </p>
              <p className="text-xs text-[#919191]">Token {group.tokenId}</p>
              <p className="text-xs text-[#919191]">Outcome {group.outcome ?? 'Unknown outcome'}</p>
              <p className="text-sm text-[#E7E7E7]">Skips {formatNumber(group.skipCount, 0)}</p>
              <p className="text-xs text-[#919191]">Top reason: {group.topReason ?? 'n/a'}</p>
              <Button size="sm" variant="outline" className={`mt-2 ${outlineButtonClass}`} onClick={() => onSelectToken(group.tokenId)}>
                View details
              </Button>
            </div>
          ))}
        </div>
      </>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
        <p className="text-sm font-medium text-[#E7E7E7]">Skipped details for token {selectedTokenId}</p>
        <Button size="sm" variant="outline" className={outlineButtonClass} onClick={onBackToGroups}>
          Back to groups
        </Button>
      </div>

      {details.length === 0 ? (
        <EmptyState title="No skipped details" description="No skipped rows found for this token on the selected page." />
      ) : (
        <>
          <div className={tableWrapClass}>
            <Table>
              <TableHeader className="[&_tr]:border-white/10">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Date & time</TableHead>
                  <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Side</TableHead>
                  <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
                  <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Outcome</TableHead>
                  <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Reason</TableHead>
                  <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Accumulated delta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr]:border-white/5">
                {details.map((row) => (
                  <TableRow key={row.id} className="hover:bg-white/[0.03]">
                    <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(row.createdAt)}</TableCell>
                    <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                    <TableCell className="px-3 text-[#E7E7E7]">{row.leaderName ?? 'n/a'}</TableCell>
                    <TableCell className="px-3 text-[#E7E7E7]">
                      <p>{row.outcome ?? 'Unknown outcome'}</p>
                      <p className="text-xs text-[#919191]">
                        <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                      </p>
                    </TableCell>
                    <TableCell className="px-3 text-[#E7E7E7]">{row.reason ?? 'n/a'}</TableCell>
                    <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(row.accumulatedDeltaNotionalUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="space-y-2 md:hidden">
            {details.map((row) => (
              <div key={row.id} className={mobileCardClass}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-[#E7E7E7]">{row.side}</p>
                  <p className="text-xs text-[#919191]">{formatDateTime(row.createdAt)}</p>
                </div>
                <p className="text-xs text-[#919191]">Leader: {row.leaderName ?? 'n/a'}</p>
                <p className="text-xs text-[#919191]">Outcome: {row.outcome ?? 'Unknown outcome'}</p>
                <p className="text-xs text-[#919191]">
                  Market:{' '}
                  <MarketLink marketSlug={row.marketSlug} marketLabel={row.marketLabel} fallback={row.marketId ?? row.tokenId} />
                </p>
                <p className="text-sm text-[#E7E7E7]">{row.reason ?? 'n/a'}</p>
                <p className="text-xs text-[#919191]">Accumulated delta {formatCurrency(row.accumulatedDeltaNotionalUsd)}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
