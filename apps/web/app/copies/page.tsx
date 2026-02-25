'use client'

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

type Section = 'open' | 'executions' | 'skipped'

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
      tokenId: string
      marketId: string | null
      outcome: string | null
      side: 'BUY' | 'SELL'
      pendingNotionalUsd: number
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
  executions: {
    items: Array<{
      id: string
      copyAttemptId: string | null
      attemptedAt: string
      leaderId: string | null
      leaderName: string | null
      tokenId: string
      marketId: string | null
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

  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<CopiesData>(query)

  if (isLoading && !data) {
    return <LoadingState title="Loading copy pipeline" description="Fetching pending copies, executions, and skipped attempts." />
  }

  if (error && !data) {
    return <ErrorState title="Copies unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="No copies data" description="Copy pipeline entries will appear after trade detection and reconcile cycles." />
  }

  const pagination = data.open?.pagination ?? data.executions?.pagination ?? data.skipped?.pagination
  const visibleRows =
    section === 'open'
      ? (data.open?.items.length ?? 0)
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
            <p className="max-w-2xl text-sm text-[#919191]">Open potential copies, execution attempts, and skipped outcomes.</p>
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
              <StatusPill label={data.summary.clobAuthentication.status} tone={statusTone(data.summary.clobAuthentication.status)} />
            </div>
            <p className="mt-2 text-xs text-[#919191]">{formatDateTime(data.summary.clobAuthentication.lastCheckedAt)}</p>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">User Channel WS</p>
              <Workflow className="size-4 text-cyan-300" />
            </div>
            <div className="mt-2">
              <StatusPill label={data.summary.userChannel.status} tone={statusTone(data.summary.userChannel.status)} />
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
    return <EmptyState title="No open potential copies" description="No pending copy attempts are currently blocked or accumulating." />
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
                <TableCell className="px-3 text-[#E7E7E7]">{row.leaderName ?? 'n/a'}</TableCell>
                <TableCell className="px-3">
                  <p className="text-[#E7E7E7]">{row.marketId ?? row.tokenId}</p>
                  <p className="text-xs text-[#919191]">{row.outcome ?? row.tokenId}</p>
                </TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{row.side}</TableCell>
                <TableCell className="px-3 text-[#E7E7E7]">{formatCurrency(row.pendingNotionalUsd)}</TableCell>
                <TableCell className="px-3">
                  <StatusPill label={row.status} tone={statusTone(row.status)} />
                  <p className="mt-1 text-xs text-[#919191]">{row.blockReason ?? 'n/a'}</p>
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
                <p className="text-sm font-medium text-[#E7E7E7]">{row.side} · {formatCurrency(row.pendingNotionalUsd)}</p>
                <StatusPill label={row.status} tone={statusTone(row.status)} />
              </div>
              <p className="text-xs text-[#919191]">{formatDateTime(row.createdAt)}</p>
            </summary>
            <div className="mt-2 space-y-1 text-sm text-[#E7E7E7]">
              <p>Leader: {row.leaderName ?? 'n/a'}</p>
              <p>Token: {row.tokenId}</p>
              <p>Outcome: {row.outcome ?? 'Unknown outcome'}</p>
              <p>Reason: {row.blockReason ?? 'n/a'}</p>
              <p>Pending shares: {formatNumber(row.pendingShares)}</p>
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
                  <p className="text-[#E7E7E7]">{row.marketId ?? row.tokenId}</p>
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
                  <StatusPill label={row.status} tone={statusTone(row.status)} />
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
                <StatusPill label={row.status} tone={statusTone(row.status)} />
              </div>
              <p className="text-xs text-[#919191]">{formatDateTime(row.attemptedAt)}</p>
            </summary>
            <div className="mt-2 space-y-1 text-sm text-[#E7E7E7]">
              <p>Leader: {row.leaderName ?? 'n/a'}</p>
              <p>Token: {row.tokenId}</p>
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
                  <TableCell className="px-3 text-[#E7E7E7]">{group.marketId ?? group.tokenId}</TableCell>
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
              <p className="text-sm font-medium text-[#E7E7E7]">{group.marketId ?? group.tokenId}</p>
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
                    <TableCell className="px-3 text-[#E7E7E7]">{row.outcome ?? 'Unknown outcome'}</TableCell>
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
