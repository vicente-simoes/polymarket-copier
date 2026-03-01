'use client'

import { FormEvent, useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, PauseCircle, PlayCircle, PlusCircle, Trash2, Users, UserPlus, SlidersHorizontal } from 'lucide-react'
import { fetchApi } from '@/lib/api-client'
import { buildLeadersQuery } from '@/lib/dashboard/query-builders'
import { shortAddress, formatCurrency, formatDateTime, formatNumber } from '@/lib/format'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { StatusPill } from '@/components/dashboard/status-pill'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface LeaderListData {
  items: Array<{
    id: string
    name: string
    profileAddress: string
    status: 'ACTIVE' | 'PAUSED' | 'DISABLED'
    createdAt: string
    tradeWallets: string[]
    primaryTradeWallet: string | null
    lastSyncAt: string | null
    copyConfig: {
      copyProfileId: string | null
      ratio: number | null
      allowDenyConfigured: boolean
      capsConfigured: boolean
    }
    metrics: {
      exposureUsd: number
      trackingErrorUsd: number
      pnlContributionUsd: number
      executedCount: number
      skippedCount: number
    }
  }>
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

interface CreateLeaderData {
  id: string
  name: string
  profileAddress: string
  status: 'ACTIVE' | 'PAUSED' | 'DISABLED'
  copyProfileLink: {
    copyProfileId: string
    ratio: number
  } | null
}

interface LeaderCreationSummary {
  id: string
  name: string
  profileAddress: string
  tradeWallets: string[]
  lastSyncAt: string | null
}

interface LeaderDetailForCreate {
  wallets: Array<{ walletAddress: string }>
  diagnostics: {
    lastAuthoritativePositionsSnapshotAt: string | null
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

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const inputClass =
  'h-10 rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] placeholder:text-[#6f6f6f] focus-visible:border-white/20 focus-visible:ring-white/10'

const outlineButtonClass =
  'border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'

export default function LeadersPage() {
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [searchFilter, setSearchFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'PAUSED' | 'DISABLED'>('ALL')
  const [addName, setAddName] = useState('')
  const [addProfileAddress, setAddProfileAddress] = useState('')
  const [addRatio, setAddRatio] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [creationSummary, setCreationSummary] = useState<LeaderCreationSummary | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [mutatingLeaderId, setMutatingLeaderId] = useState<string | null>(null)

  const query = useMemo(() => {
    return buildLeadersQuery({
      page,
      pageSize: 50,
      search: searchFilter,
      status: statusFilter
    })
  }, [page, searchFilter, statusFilter])

  const { data, generatedAt, isLoading, error, refresh } = useApiQuery<LeaderListData>(query, {
    refreshIntervalMs: 20_000
  })

  const pageStats = useMemo(() => {
    if (!data) {
      return { active: 0, paused: 0, disabled: 0, exposureUsd: 0 }
    }

    return data.items.reduce(
      (acc, leader) => {
        if (leader.status === 'ACTIVE') acc.active += 1
        if (leader.status === 'PAUSED') acc.paused += 1
        if (leader.status === 'DISABLED') acc.disabled += 1
        acc.exposureUsd += leader.metrics.exposureUsd
        return acc
      },
      { active: 0, paused: 0, disabled: 0, exposureUsd: 0 }
    )
  }, [data])

  async function handleCreateLeader(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreateError(null)
    setCreationSummary(null)

    if (addName.trim().length === 0 || addProfileAddress.trim().length === 0) {
      setCreateError('Name and profile address are required.')
      return
    }

    setIsCreating(true)

    try {
      const ratio = addRatio.trim().length > 0 ? Number(addRatio) : undefined
      const payload = await fetchApi<CreateLeaderData>('/api/v1/leaders', {
        method: 'POST',
        body: JSON.stringify({
          name: addName.trim(),
          profileAddress: addProfileAddress.trim(),
          ...(ratio !== undefined && Number.isFinite(ratio) ? { ratio } : {})
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      })

      const detail = await fetchApi<LeaderDetailForCreate>(`/api/v1/leaders/${payload.data.id}`)

      setCreationSummary({
        id: payload.data.id,
        name: payload.data.name,
        profileAddress: payload.data.profileAddress,
        tradeWallets: detail.data.wallets.map((wallet) => wallet.walletAddress),
        lastSyncAt: detail.data.diagnostics.lastAuthoritativePositionsSnapshotAt
      })

      setAddName('')
      setAddProfileAddress('')
      setAddRatio('')
      setPage(1)
      await refresh()
    } catch (createLeaderError) {
      setCreateError(createLeaderError instanceof Error ? createLeaderError.message : String(createLeaderError))
    } finally {
      setIsCreating(false)
    }
  }

  async function updateLeaderStatus(leaderId: string, status: 'ACTIVE' | 'PAUSED') {
    setMutatingLeaderId(leaderId)
    try {
      await fetchApi(`/api/v1/leaders/${leaderId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status })
      })
      await refresh()
    } catch {
      // Refresh to keep UI in sync even on error.
      await refresh()
    } finally {
      setMutatingLeaderId(null)
    }
  }

  async function removeLeader(leaderId: string) {
    if (!window.confirm('Remove this leader from active copying?')) {
      return
    }

    setMutatingLeaderId(leaderId)
    try {
      await fetchApi(`/api/v1/leaders/${leaderId}`, {
        method: 'DELETE'
      })
      await refresh()
    } catch {
      await refresh()
    } finally {
      setMutatingLeaderId(null)
    }
  }

  if (isLoading && !data) {
    return <LoadingState title="Loading leaders" description="Fetching leader roster and metrics." />
  }

  if (error && !data) {
    return <ErrorState title="Leaders unavailable" description={error} actionLabel="Retry" onAction={() => void refresh()} />
  }

  if (!data) {
    return <EmptyState title="No leaders data" description="Create a leader to start tracking copy performance." />
  }

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-14 top-0 h-44 w-44 rounded-full bg-[#86efac]/10 blur-3xl" />
          <div className="absolute left-1/4 bottom-0 h-24 w-24 rounded-full bg-cyan-400/5 blur-2xl" />
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Roster</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Leaders</h2>
            <p className="max-w-2xl text-sm text-[#919191]">Manage tracked leaders, copy ratios, and operational status.</p>
          </div>
          <TimestampBadge value={generatedAt} />
        </div>
        <div className="relative mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Total Leaders</p>
              <Users className="size-4 text-[#86efac]" />
            </div>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatNumber(data.pagination.total, 0)}</p>
            <p className="text-xs text-[#919191]">Across all pages</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Page Status Mix</p>
            <p className="mt-2 text-sm text-[#E7E7E7]">
              Active {pageStats.active} · Paused {pageStats.paused} · Disabled {pageStats.disabled}
            </p>
            <p className="mt-1 text-xs text-[#919191]">Current page view</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Page Exposure</p>
            <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{formatCurrency(pageStats.exposureUsd)}</p>
            <p className="text-xs text-[#919191]">Summed from visible leaders</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Pagination</p>
            <p className="mt-2 text-sm text-[#E7E7E7]">
              Page {data.pagination.page} / {Math.max(data.pagination.totalPages, 1)}
            </p>
            <p className="mt-1 text-xs text-[#919191]">{data.items.length} rows loaded</p>
          </div>
        </div>
      </section>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Create</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <UserPlus className="size-4 text-[#86efac]" />
            Add leader
          </CardTitle>
          <CardDescription className="text-[#919191]">Add by Polymarket profile URL or raw profile address.</CardDescription>
        </CardHeader>
        <CardContent className="px-5 md:px-6">
          <form className="grid gap-3 md:grid-cols-5" onSubmit={handleCreateLeader}>
            <Input
              value={addName}
              onChange={(event) => setAddName(event.target.value)}
              placeholder="Display name"
              className={`md:col-span-1 ${inputClass}`}
            />
            <Input
              value={addProfileAddress}
              onChange={(event) => setAddProfileAddress(event.target.value)}
              placeholder="https://polymarket.com/0x..."
              className={`md:col-span-3 ${inputClass}`}
            />
            <Input
              value={addRatio}
              onChange={(event) => setAddRatio(event.target.value)}
              placeholder="Ratio (optional)"
              className={`md:col-span-1 ${inputClass}`}
            />
            <div className="md:col-span-5">
              <Button
                type="submit"
                disabled={isCreating}
                className="h-10 w-full rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1] sm:w-auto"
              >
                <PlusCircle className="size-4" />
                {isCreating ? 'Adding leader...' : 'Add leader'}
              </Button>
            </div>
          </form>

          {createError ? <p className="mt-3 text-sm text-rose-300">{createError}</p> : null}

          {creationSummary ? (
            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 text-sm">
              <p className="font-medium text-[#E7E7E7]">Leader created: {creationSummary.name}</p>
              <p className="text-[#919191]">Stored profile: {creationSummary.profileAddress}</p>
              <p className="text-[#919191]">
                Resolved trade wallets:{' '}
                {creationSummary.tradeWallets.length > 0 ? creationSummary.tradeWallets.map(shortAddress).join(', ') : 'Pending first sync'}
              </p>
              <p className="text-[#919191]">First sync: {formatDateTime(creationSummary.lastSyncAt)}</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Directory</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <SlidersHorizontal className="size-4 text-cyan-300" />
            Leader table
          </CardTitle>
          <CardDescription className="text-[#919191]">Active, paused, and disabled leaders with copy metrics.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          <form
            className="grid gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 md:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault()
              setPage(1)
              setSearchFilter(searchInput)
            }}
          >
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search name, address, wallet"
              className={`md:col-span-2 ${inputClass}`}
            />
            <Select
              value={statusFilter}
              onValueChange={(value: 'ALL' | 'ACTIVE' | 'PAUSED' | 'DISABLED') => {
                setStatusFilter(value)
                setPage(1)
              }}
            >
              <SelectTrigger className={`h-10 w-full rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] ${inputClass}`}>
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent className="border-white/10 bg-[#0D0D0D] text-[#E7E7E7]">
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="ALL">
                  All statuses
                </SelectItem>
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="ACTIVE">
                  Active
                </SelectItem>
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="PAUSED">
                  Paused
                </SelectItem>
                <SelectItem className="focus:bg-white/[0.06] focus:text-white" value="DISABLED">
                  Disabled
                </SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline" className={`h-10 rounded-xl ${outlineButtonClass}`}>
              Apply filters
            </Button>
          </form>

          {data.items.length === 0 ? (
            <EmptyState title="No leaders found" description="Adjust filters or add a new leader." />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block">
                <Table>
                  <TableHeader className="[&_tr]:border-white/10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Leader</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Status</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Copy config</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Metrics</TableHead>
                      <TableHead className="px-3 text-right text-xs uppercase tracking-[0.16em] text-[#919191]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-white/5">
                    {data.items.map((leader) => (
                      <TableRow key={leader.id} className="hover:bg-white/[0.03]">
                        <TableCell className="px-3">
                          <div className="space-y-0.5">
                            <Link href={`/leaders/${leader.id}`} className="font-medium text-[#E7E7E7] hover:text-white hover:underline">
                              {leader.name}
                            </Link>
                            <p className="text-xs text-[#919191]">Profile: {shortAddress(leader.profileAddress)}</p>
                            <p className="text-xs text-[#919191]">
                              Trade wallet: {leader.primaryTradeWallet ? shortAddress(leader.primaryTradeWallet) : 'n/a'}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="px-3">
                          <div className="space-y-1">
                            <StatusPill label={leader.status} tone={statusTone(leader.status)} />
                            <p className="text-xs text-[#919191]">Last sync {formatDateTime(leader.lastSyncAt)}</p>
                          </div>
                        </TableCell>
                        <TableCell className="px-3">
                          <div className="space-y-1 text-sm text-[#E7E7E7]">
                            <p>Ratio: {leader.copyConfig.ratio ?? 'n/a'}</p>
                            <p className="text-xs text-[#919191]">
                              Rules: {leader.copyConfig.allowDenyConfigured ? 'Allow/deny set' : 'Default'} ·{' '}
                              {leader.copyConfig.capsConfigured ? 'Caps set' : 'Default caps'}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="px-3">
                          <div className="space-y-1 text-sm text-[#E7E7E7]">
                            <p>Exposure {formatCurrency(leader.metrics.exposureUsd)}</p>
                            <p>Tracking {formatCurrency(leader.metrics.trackingErrorUsd)}</p>
                            <p className="text-xs text-[#919191]">
                              Exec {formatNumber(leader.metrics.executedCount, 0)} · Skip {formatNumber(leader.metrics.skippedCount, 0)}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell className="px-3">
                          <div className="flex items-center justify-end gap-2">
                            <Button asChild size="sm" variant="outline" className={outlineButtonClass}>
                              <Link href={`/leaders/${leader.id}`}>Edit</Link>
                            </Button>
                            {leader.status === 'ACTIVE' ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className={outlineButtonClass}
                                disabled={mutatingLeaderId === leader.id}
                                onClick={() => void updateLeaderStatus(leader.id, 'PAUSED')}
                              >
                                <PauseCircle className="size-4" />
                                Pause
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className={outlineButtonClass}
                                disabled={mutatingLeaderId === leader.id || leader.status === 'DISABLED'}
                                onClick={() => void updateLeaderStatus(leader.id, 'ACTIVE')}
                              >
                                <PlayCircle className="size-4" />
                                Resume
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              className={outlineButtonClass}
                              disabled={mutatingLeaderId === leader.id}
                              onClick={() => void removeLeader(leader.id)}
                            >
                              <Trash2 className="size-4" />
                              Remove
                            </Button>
                            <Button asChild size="sm" variant="outline" className={outlineButtonClass}>
                              <Link href={`https://polymarket.com/${leader.profileAddress}`} target="_blank" rel="noreferrer">
                                <ExternalLink className="size-4" />
                                View
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 md:hidden">
                {data.items.map((leader) => (
                  <div key={leader.id} className="space-y-2 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <Link href={`/leaders/${leader.id}`} className="font-medium text-[#E7E7E7] hover:text-white hover:underline">
                          {leader.name}
                        </Link>
                        <p className="text-xs text-[#919191]">{shortAddress(leader.profileAddress)}</p>
                      </div>
                      <StatusPill label={leader.status} tone={statusTone(leader.status)} />
                    </div>
                    <p className="text-xs text-[#919191]">Wallet: {leader.primaryTradeWallet ? shortAddress(leader.primaryTradeWallet) : 'n/a'}</p>
                    <div className="grid grid-cols-2 gap-2 text-sm text-[#E7E7E7]">
                      <p>Exposure {formatCurrency(leader.metrics.exposureUsd)}</p>
                      <p>Tracking {formatCurrency(leader.metrics.trackingErrorUsd)}</p>
                      <p>Executed {formatNumber(leader.metrics.executedCount, 0)}</p>
                      <p>Skipped {formatNumber(leader.metrics.skippedCount, 0)}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button asChild size="sm" variant="outline" className={outlineButtonClass}>
                        <Link href={`/leaders/${leader.id}`}>Edit</Link>
                      </Button>
                      {leader.status === 'ACTIVE' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className={outlineButtonClass}
                          disabled={mutatingLeaderId === leader.id}
                          onClick={() => void updateLeaderStatus(leader.id, 'PAUSED')}
                        >
                          Pause
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className={outlineButtonClass}
                          disabled={mutatingLeaderId === leader.id || leader.status === 'DISABLED'}
                          onClick={() => void updateLeaderStatus(leader.id, 'ACTIVE')}
                        >
                          Resume
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className={outlineButtonClass}
                        disabled={mutatingLeaderId === leader.id}
                        onClick={() => void removeLeader(leader.id)}
                      >
                        Remove
                      </Button>
                      <Button asChild size="sm" variant="outline" className={outlineButtonClass}>
                        <Link href={`https://polymarket.com/${leader.profileAddress}`} target="_blank" rel="noreferrer">
                          <ExternalLink className="size-4" />
                          View
                        </Link>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-xs text-[#919191]">
              Showing <span className="text-[#E7E7E7]">{data.items.length}</span> of{' '}
              <span className="text-[#E7E7E7]">{data.pagination.total}</span> leaders
            </p>
            <PaginationControls
              page={data.pagination.page}
              totalPages={data.pagination.totalPages}
              onPageChange={(nextPage) => setPage(nextPage)}
              className="flex items-center gap-3 [&_button]:rounded-xl [&_button]:border-white/10 [&_button]:bg-white/[0.02] [&_button]:text-[#E7E7E7] [&_button:hover]:bg-white/[0.06] [&_p]:text-[#919191]"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
