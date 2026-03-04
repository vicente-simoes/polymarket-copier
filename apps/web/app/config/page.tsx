'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Shield, SlidersHorizontal, ToggleLeft, History, Save, Settings2 } from 'lucide-react'
import { useApiQuery } from '@/components/dashboard/use-api-query'
import { LoadingState, ErrorState, EmptyState } from '@/components/dashboard/states'
import { PaginationControls } from '@/components/dashboard/pagination-controls'
import { StatusPill } from '@/components/dashboard/status-pill'
import { TimestampBadge } from '@/components/dashboard/timestamp-badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fetchApi } from '@/lib/api-client'
import { formatDateTime, formatNumber } from '@/lib/format'

interface SystemConfig {
  masterSwitches: {
    copySystemEnabled: boolean
    tradeDetectionEnabled: boolean
    userChannelWsEnabled: boolean
  }
  reconcile: {
    intervalSeconds: number
  }
  guardrails: {
    attemptExpirationSeconds: number
    maxWorseningBuyUsd: number
    maxWorseningSellUsd: number
    maxSlippageBps: number
    maxSpreadUsd: number
    maxPricePerShareUsd: number | null
    minNotionalPerOrderUsd: number
    minBookDepthForSizeEnabled: boolean
    cooldownPerMarketSeconds: number
    maxRetriesPerAttempt: number
    maxOpenOrders: number | null
  }
  sizing: {
    copyRatio: number
    maxExposurePerLeaderUsd: number
    maxExposurePerMarketOutcomeUsd: number
    maxHourlyNotionalTurnoverUsd: number
    maxDailyNotionalTurnoverUsd: number
  }
}

interface RuntimeOpsConfig {
  chainTriggerWsEnabled: boolean
  fillReconcileEnabled: boolean
  fillReconcileIntervalSeconds: number
  fillParseStarvationWindowSeconds: number
  fillParseStarvationMinMessages: number
  targetNettingEnabled: boolean
  targetNettingIntervalMs: number
  targetNettingTrackingErrorBps: number
  reconcileEngineEnabled: boolean
  reconcileStaleLeaderSyncSeconds: number
  reconcileStaleFollowerSyncSeconds: number
  reconcileGuardrailFailureCycleThreshold: number
  leaderTradesPollIntervalSeconds: number
  leaderTradesTakerOnly: boolean
  executionEngineEnabled: boolean
  panicMode: boolean
}

interface ConfigData {
  copyProfileId: string | null
  updatedAt: string | null
  config: SystemConfig
  defaults: SystemConfig
  runtimeOps: RuntimeOpsConfig
  runtimeOpsDefaults: RuntimeOpsConfig
}

interface ConfigAuditData {
  items: Array<{
    id: string
    scope: 'GLOBAL' | 'LEADER' | 'COPY_PROFILE' | 'SYSTEM'
    scopeRefId: string | null
    copyProfileId: string | null
    changedBy: string | null
    changeType: 'CREATED' | 'UPDATED' | 'DELETED'
    previousValue: Record<string, unknown> | null
    nextValue: Record<string, unknown> | null
    reason: string | null
    createdAt: string
  }>
  pagination: {
    page: number
    pageSize: number
    total: number
    totalPages: number
  }
}

interface LeaderListData {
  items: Array<{
    id: string
    name: string
    status: 'ACTIVE' | 'PAUSED' | 'DISABLED'
  }>
}

interface ConfigFormState {
  copySystemEnabled: boolean
  tradeDetectionEnabled: boolean
  userChannelWsEnabled: boolean
  intervalSeconds: string
  attemptExpirationSeconds: string
  maxWorseningBuyUsd: string
  maxWorseningSellUsd: string
  maxSlippageBps: string
  maxSpreadUsd: string
  maxPricePerShareUsd: string
  minNotionalPerOrderUsd: string
  minBookDepthForSizeEnabled: boolean
  cooldownPerMarketSeconds: string
  maxRetriesPerAttempt: string
  maxOpenOrders: string
  copyRatio: string
  maxExposurePerLeaderUsd: string
  maxExposurePerMarketOutcomeUsd: string
  maxHourlyNotionalTurnoverUsd: string
  maxDailyNotionalTurnoverUsd: string
  chainTriggerWsEnabled: boolean
  fillReconcileEnabled: boolean
  fillReconcileIntervalSeconds: string
  fillParseStarvationWindowSeconds: string
  fillParseStarvationMinMessages: string
  targetNettingEnabled: boolean
  targetNettingIntervalMs: string
  targetNettingTrackingErrorBps: string
  reconcileEngineEnabled: boolean
  reconcileStaleLeaderSyncSeconds: string
  reconcileStaleFollowerSyncSeconds: string
  reconcileGuardrailFailureCycleThreshold: string
  leaderTradesPollIntervalSeconds: string
  leaderTradesTakerOnly: boolean
  executionEngineEnabled: boolean
  panicMode: boolean
  applyRatioToExistingLeaders: boolean
  reason: string
  changedBy: string
}

function toStringValue(value: number | null): string {
  if (value === null) {
    return ''
  }
  return String(value)
}

function numberValue(raw: string): number | null {
  if (raw.trim().length === 0) {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

const panelClass =
  'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'

const inputClass =
  'h-10 rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] placeholder:text-[#6f6f6f] focus-visible:border-white/20 focus-visible:ring-white/10'

const outlineButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'
const activeButtonClass = 'rounded-xl bg-[#86efac] text-black hover:bg-[#9af5b1]'

export default function ConfigPage() {
  const [auditPage, setAuditPage] = useState(1)
  const [isSaving, setIsSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [guardrailsMode, setGuardrailsMode] = useState<'global' | 'leader'>('global')
  const [sizingMode, setSizingMode] = useState<'global' | 'leader'>('global')

  const configState = useApiQuery<ConfigData>('/api/v1/config')
  const auditState = useApiQuery<ConfigAuditData>(`/api/v1/config/audit?page=${auditPage}&pageSize=50`)
  const leadersState = useApiQuery<LeaderListData>('/api/v1/leaders?page=1&pageSize=200')

  const [form, setForm] = useState<ConfigFormState | null>(null)

  useEffect(() => {
    if (!configState.data) {
      return
    }

    const config = configState.data.config
    const runtimeOps = configState.data.runtimeOps

    setForm({
      copySystemEnabled: config.masterSwitches.copySystemEnabled,
      tradeDetectionEnabled: config.masterSwitches.tradeDetectionEnabled,
      userChannelWsEnabled: config.masterSwitches.userChannelWsEnabled,
      intervalSeconds: toStringValue(config.reconcile.intervalSeconds),
      attemptExpirationSeconds: toStringValue(config.guardrails.attemptExpirationSeconds),
      maxWorseningBuyUsd: toStringValue(config.guardrails.maxWorseningBuyUsd),
      maxWorseningSellUsd: toStringValue(config.guardrails.maxWorseningSellUsd),
      maxSlippageBps: toStringValue(config.guardrails.maxSlippageBps),
      maxSpreadUsd: toStringValue(config.guardrails.maxSpreadUsd),
      maxPricePerShareUsd: toStringValue(config.guardrails.maxPricePerShareUsd),
      minNotionalPerOrderUsd: toStringValue(config.guardrails.minNotionalPerOrderUsd),
      minBookDepthForSizeEnabled: config.guardrails.minBookDepthForSizeEnabled,
      cooldownPerMarketSeconds: toStringValue(config.guardrails.cooldownPerMarketSeconds),
      maxRetriesPerAttempt: toStringValue(config.guardrails.maxRetriesPerAttempt),
      maxOpenOrders: toStringValue(config.guardrails.maxOpenOrders),
      copyRatio: toStringValue(config.sizing.copyRatio),
      maxExposurePerLeaderUsd: toStringValue(config.sizing.maxExposurePerLeaderUsd),
      maxExposurePerMarketOutcomeUsd: toStringValue(config.sizing.maxExposurePerMarketOutcomeUsd),
      maxHourlyNotionalTurnoverUsd: toStringValue(config.sizing.maxHourlyNotionalTurnoverUsd),
      maxDailyNotionalTurnoverUsd: toStringValue(config.sizing.maxDailyNotionalTurnoverUsd),
      chainTriggerWsEnabled: runtimeOps.chainTriggerWsEnabled,
      fillReconcileEnabled: runtimeOps.fillReconcileEnabled,
      fillReconcileIntervalSeconds: toStringValue(runtimeOps.fillReconcileIntervalSeconds),
      fillParseStarvationWindowSeconds: toStringValue(runtimeOps.fillParseStarvationWindowSeconds),
      fillParseStarvationMinMessages: toStringValue(runtimeOps.fillParseStarvationMinMessages),
      targetNettingEnabled: runtimeOps.targetNettingEnabled,
      targetNettingIntervalMs: toStringValue(runtimeOps.targetNettingIntervalMs),
      targetNettingTrackingErrorBps: toStringValue(runtimeOps.targetNettingTrackingErrorBps),
      reconcileEngineEnabled: runtimeOps.reconcileEngineEnabled,
      reconcileStaleLeaderSyncSeconds: toStringValue(runtimeOps.reconcileStaleLeaderSyncSeconds),
      reconcileStaleFollowerSyncSeconds: toStringValue(runtimeOps.reconcileStaleFollowerSyncSeconds),
      reconcileGuardrailFailureCycleThreshold: toStringValue(runtimeOps.reconcileGuardrailFailureCycleThreshold),
      leaderTradesPollIntervalSeconds: toStringValue(runtimeOps.leaderTradesPollIntervalSeconds),
      leaderTradesTakerOnly: runtimeOps.leaderTradesTakerOnly,
      executionEngineEnabled: runtimeOps.executionEngineEnabled,
      panicMode: runtimeOps.panicMode,
      applyRatioToExistingLeaders: false,
      reason: '',
      changedBy: ''
    })
  }, [configState.data])

  const statusPill = useMemo(() => {
    if (!form) {
      return null
    }

    return (
      <StatusPill
        label={form.copySystemEnabled ? 'Copy enabled' : 'Copy disabled'}
        tone={form.copySystemEnabled ? 'positive' : 'warning'}
      />
    )
  }, [form])

  async function saveConfig() {
    if (!form) {
      return
    }

    setIsSaving(true)
    setSaveMessage(null)

    try {
      const payload = {
        masterSwitches: {
          copySystemEnabled: form.copySystemEnabled,
          tradeDetectionEnabled: form.tradeDetectionEnabled,
          userChannelWsEnabled: form.userChannelWsEnabled
        },
        reconcile: {
          intervalSeconds: Number(form.intervalSeconds)
        },
        guardrails: {
          attemptExpirationSeconds: Number(form.attemptExpirationSeconds),
          maxWorseningBuyUsd: Number(form.maxWorseningBuyUsd),
          maxWorseningSellUsd: Number(form.maxWorseningSellUsd),
          maxSlippageBps: Number(form.maxSlippageBps),
          maxSpreadUsd: Number(form.maxSpreadUsd),
          maxPricePerShareUsd: numberValue(form.maxPricePerShareUsd),
          minNotionalPerOrderUsd: Number(form.minNotionalPerOrderUsd),
          minBookDepthForSizeEnabled: form.minBookDepthForSizeEnabled,
          cooldownPerMarketSeconds: Number(form.cooldownPerMarketSeconds),
          maxRetriesPerAttempt: Number(form.maxRetriesPerAttempt),
          maxOpenOrders: numberValue(form.maxOpenOrders)
        },
        sizing: {
          copyRatio: Number(form.copyRatio),
          maxExposurePerLeaderUsd: Number(form.maxExposurePerLeaderUsd),
          maxExposurePerMarketOutcomeUsd: Number(form.maxExposurePerMarketOutcomeUsd),
          maxHourlyNotionalTurnoverUsd: Number(form.maxHourlyNotionalTurnoverUsd),
          maxDailyNotionalTurnoverUsd: Number(form.maxDailyNotionalTurnoverUsd)
        },
        runtimeOps: {
          chainTriggerWsEnabled: form.chainTriggerWsEnabled,
          fillReconcileEnabled: form.fillReconcileEnabled,
          fillReconcileIntervalSeconds: Number(form.fillReconcileIntervalSeconds),
          fillParseStarvationWindowSeconds: Number(form.fillParseStarvationWindowSeconds),
          fillParseStarvationMinMessages: Number(form.fillParseStarvationMinMessages),
          targetNettingEnabled: form.targetNettingEnabled,
          targetNettingIntervalMs: Number(form.targetNettingIntervalMs),
          targetNettingTrackingErrorBps: Number(form.targetNettingTrackingErrorBps),
          reconcileEngineEnabled: form.reconcileEngineEnabled,
          reconcileStaleLeaderSyncSeconds: Number(form.reconcileStaleLeaderSyncSeconds),
          reconcileStaleFollowerSyncSeconds: Number(form.reconcileStaleFollowerSyncSeconds),
          reconcileGuardrailFailureCycleThreshold: Number(form.reconcileGuardrailFailureCycleThreshold),
          leaderTradesPollIntervalSeconds: Number(form.leaderTradesPollIntervalSeconds),
          leaderTradesTakerOnly: form.leaderTradesTakerOnly,
          executionEngineEnabled: form.executionEngineEnabled,
          panicMode: form.panicMode
        },
        applyRatioToExistingLeaders: form.applyRatioToExistingLeaders,
        reason: form.reason.trim().length > 0 ? form.reason.trim() : undefined,
        changedBy: form.changedBy.trim().length > 0 ? form.changedBy.trim() : undefined
      }

      await fetchApi('/api/v1/config', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      })

      setSaveMessage('Config saved.')
      await configState.refresh()
      await auditState.refresh()
    } catch (saveError) {
      setSaveMessage(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setIsSaving(false)
    }
  }

  if ((configState.isLoading && !configState.data) || !form) {
    return <LoadingState title="Loading config" description="Fetching current runtime settings and defaults." />
  }

  if (configState.error && !configState.data) {
    return <ErrorState title="Config unavailable" description={configState.error} actionLabel="Retry" onAction={() => void configState.refresh()} />
  }

  if (!configState.data) {
    return <EmptyState title="No config" description="No copy profile found. Create one before editing runtime settings." />
  }

  return (
    <div className="space-y-6">
      <section className={`${panelClass} relative overflow-hidden p-5 md:p-6`}>
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -right-10 top-2 h-44 w-44 rounded-full bg-[#86efac]/8 blur-3xl" />
          <div className="absolute left-1/4 bottom-0 h-24 w-24 rounded-full bg-cyan-400/6 blur-2xl" />
        </div>

        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Runtime Control</p>
            <h2 className="text-2xl font-semibold text-[#E7E7E7] md:text-3xl">Config</h2>
            <p className="max-w-2xl text-sm text-[#919191]">Master switches, runtime operations, guardrails, sizing, and audit log.</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <div className="rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 text-xs text-[#919191]">
                Copy profile {configState.data.copyProfileId ?? 'n/a'}
              </div>
              {statusPill}
            </div>
          </div>
          <TimestampBadge value={configState.generatedAt} />
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Copy System</p>
            <Shield className="size-4 text-[#86efac]" />
          </div>
          <div className="mt-2">{statusPill}</div>
          <p className="mt-2 text-xs text-[#919191]">Master execution switch</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Trade Detection</p>
            <ToggleLeft className="size-4 text-cyan-300" />
          </div>
          <p className="mt-2 text-sm font-medium text-[#E7E7E7]">{form.tradeDetectionEnabled ? 'Enabled' : 'Disabled'}</p>
          <p className="text-xs text-[#919191]">Ingestion + telemetry path</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">User Channel WS</p>
            <Settings2 className="size-4 text-cyan-300" />
          </div>
          <p className="mt-2 text-sm font-medium text-[#E7E7E7]">{form.userChannelWsEnabled ? 'Enabled' : 'Disabled'}</p>
          <p className="text-xs text-[#919191]">Follower websocket stream</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Reconcile Interval</p>
            <SlidersHorizontal className="size-4 text-amber-300" />
          </div>
          <p className="mt-2 text-xl font-semibold text-[#E7E7E7]">{form.intervalSeconds || 'n/a'}s</p>
          <p className="text-xs text-[#919191]">Configured cadence</p>
        </div>
        <div className={`${panelClass} p-4`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.16em] text-[#919191]">Last Config Save</p>
            <Save className="size-4 text-emerald-300" />
          </div>
          <p className="mt-2 text-sm font-medium text-[#E7E7E7]">{formatDateTime(configState.data.updatedAt)}</p>
          <p className="text-xs text-[#919191]">Persisted config timestamp</p>
        </div>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Switches</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Master switches</CardTitle>
          <CardDescription className="text-[#919191]">Execution kill switch plus observe-only toggles.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 px-5 md:px-6">
          <ToggleRow
            label="Copy system enabled"
            description="When off, no order placement or modifications are allowed."
            checked={form.copySystemEnabled}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, copySystemEnabled: checked } : previous)}
          />
          {!form.copySystemEnabled ? (
            <>
              <ToggleRow
                label="Trade detection enabled"
                description="Keep ingestion and telemetry active while execution is disabled."
                checked={form.tradeDetectionEnabled}
                onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, tradeDetectionEnabled: checked } : previous)}
              />
              <ToggleRow
                label="User Channel WS enabled"
                description="Maintain follower websocket stream in observe mode."
                checked={form.userChannelWsEnabled}
                onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, userChannelWsEnabled: checked } : previous)}
              />
            </>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Guardrails</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Reconciliation + guardrails</CardTitle>
            <CardDescription className="text-[#919191]">Cadence, expiry, slippage, spread, retries, and minimums.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-5 md:px-6">
            <ModeToggle
              label="Guardrails mode"
              leftLabel="Global guardrails"
              rightLabel="Per-leader overrides"
              value={guardrailsMode}
              onChange={setGuardrailsMode}
            />
            {guardrailsMode === 'leader' ? (
              <LeaderModeHint leaders={leadersState.data?.items ?? []} />
            ) : null}
            <InputField label="Reconcile interval (seconds)" value={form.intervalSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, intervalSeconds: value } : prev)} />
            <InputField label="Attempt expiration (seconds)" value={form.attemptExpirationSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, attemptExpirationSeconds: value } : prev)} />
            <InputField label="Max worsening buy (USD)" value={form.maxWorseningBuyUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxWorseningBuyUsd: value } : prev)} />
            <InputField label="Max worsening sell (USD)" value={form.maxWorseningSellUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxWorseningSellUsd: value } : prev)} />
            <InputField label="Max slippage (bps)" value={form.maxSlippageBps} onChange={(value) => setForm((prev) => prev ? { ...prev, maxSlippageBps: value } : prev)} />
            <InputField label="Max spread (USD)" value={form.maxSpreadUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxSpreadUsd: value } : prev)} />
            <InputField label="Max price per share (USD, blank=off)" value={form.maxPricePerShareUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxPricePerShareUsd: value } : prev)} />
            <InputField label="Min notional per order (USD)" value={form.minNotionalPerOrderUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, minNotionalPerOrderUsd: value } : prev)} />
            <ToggleRow
              label="Min book depth for size"
              description="Require enough visible depth to fill intended size within cap."
              checked={form.minBookDepthForSizeEnabled}
              onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, minBookDepthForSizeEnabled: checked } : previous)}
            />
            <InputField label="Cooldown per market (seconds)" value={form.cooldownPerMarketSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, cooldownPerMarketSeconds: value } : prev)} />
            <InputField label="Max retries per attempt" value={form.maxRetriesPerAttempt} onChange={(value) => setForm((prev) => prev ? { ...prev, maxRetriesPerAttempt: value } : prev)} />
            <InputField label="Max open orders (blank = null)" value={form.maxOpenOrders} onChange={(value) => setForm((prev) => prev ? { ...prev, maxOpenOrders: value } : prev)} />
          </CardContent>
        </Card>

        <Card className={`${panelClass} gap-4 py-5`}>
          <CardHeader className="px-5 pb-0 md:px-6">
            <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Sizing</CardDescription>
            <CardTitle className="text-[#E7E7E7]">Sizing</CardTitle>
            <CardDescription className="text-[#919191]">Copy ratio and exposure/turnover caps.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 px-5 md:px-6">
            <ModeToggle
              label="Sizing mode"
              leftLabel="Global sizing"
              rightLabel="Per-leader sizing"
              value={sizingMode}
              onChange={setSizingMode}
            />
            {sizingMode === 'leader' ? (
              <LeaderModeHint leaders={leadersState.data?.items ?? []} />
            ) : null}
            <InputField label="Copy ratio" value={form.copyRatio} onChange={(value) => setForm((prev) => prev ? { ...prev, copyRatio: value } : prev)} />
            <InputField label="Max exposure per leader (USD)" value={form.maxExposurePerLeaderUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxExposurePerLeaderUsd: value } : prev)} />
            <InputField label="Max exposure per market/outcome (USD)" value={form.maxExposurePerMarketOutcomeUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxExposurePerMarketOutcomeUsd: value } : prev)} />
            <InputField label="Max hourly notional turnover (USD)" value={form.maxHourlyNotionalTurnoverUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxHourlyNotionalTurnoverUsd: value } : prev)} />
            <InputField label="Max daily notional turnover (USD)" value={form.maxDailyNotionalTurnoverUsd} onChange={(value) => setForm((prev) => prev ? { ...prev, maxDailyNotionalTurnoverUsd: value } : prev)} />

            <ToggleRow
              label="Apply ratio to existing leaders"
              description="Update linked leader ratios when saving this config."
              checked={form.applyRatioToExistingLeaders}
              onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, applyRatioToExistingLeaders: checked } : previous)}
            />
          </CardContent>
        </Card>
      </div>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Operations</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Operations runtime (global)</CardTitle>
          <CardDescription className="text-[#919191]">Live service toggles and cadence controls applied without restart.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 md:px-6">
          <ToggleRow
            label="Chain trigger WS enabled"
            description="Global gate for chain trigger ingestion. Effective chain trigger still requires trade detection enabled."
            checked={form.chainTriggerWsEnabled}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, chainTriggerWsEnabled: checked } : previous)}
          />
          <ToggleRow
            label="Fill reconcile enabled"
            description="Enable periodic REST trade-history reconcile for follower fills."
            checked={form.fillReconcileEnabled}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, fillReconcileEnabled: checked } : previous)}
          />
          <InputField label="Fill reconcile interval (seconds)" value={form.fillReconcileIntervalSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, fillReconcileIntervalSeconds: value } : prev)} />
          <InputField label="Fill parse starvation window (seconds)" value={form.fillParseStarvationWindowSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, fillParseStarvationWindowSeconds: value } : prev)} />
          <InputField label="Fill parse starvation min messages" value={form.fillParseStarvationMinMessages} onChange={(value) => setForm((prev) => prev ? { ...prev, fillParseStarvationMinMessages: value } : prev)} />
          <ToggleRow
            label="Target netting enabled"
            description="Enable pending-delta target netting loop."
            checked={form.targetNettingEnabled}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, targetNettingEnabled: checked } : previous)}
          />
          <InputField label="Target netting interval (ms)" value={form.targetNettingIntervalMs} onChange={(value) => setForm((prev) => prev ? { ...prev, targetNettingIntervalMs: value } : prev)} />
          <InputField label="Target netting tracking error (bps)" value={form.targetNettingTrackingErrorBps} onChange={(value) => setForm((prev) => prev ? { ...prev, targetNettingTrackingErrorBps: value } : prev)} />
          <ToggleRow
            label="Reconcile engine enabled"
            description="Enable reconcile/audit loop for profile snapshots and integrity checks."
            checked={form.reconcileEngineEnabled}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, reconcileEngineEnabled: checked } : previous)}
          />
          <InputField label="Reconcile stale leader sync (seconds)" value={form.reconcileStaleLeaderSyncSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, reconcileStaleLeaderSyncSeconds: value } : prev)} />
          <InputField label="Reconcile stale follower sync (seconds)" value={form.reconcileStaleFollowerSyncSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, reconcileStaleFollowerSyncSeconds: value } : prev)} />
          <InputField label="Reconcile guardrail failure threshold" value={form.reconcileGuardrailFailureCycleThreshold} onChange={(value) => setForm((prev) => prev ? { ...prev, reconcileGuardrailFailureCycleThreshold: value } : prev)} />
          <InputField label="Leader trades poll interval (seconds)" value={form.leaderTradesPollIntervalSeconds} onChange={(value) => setForm((prev) => prev ? { ...prev, leaderTradesPollIntervalSeconds: value } : prev)} />
          <ToggleRow
            label="Leader trades taker-only"
            description="When enabled, leader trades poll includes only taker-side trades."
            checked={form.leaderTradesTakerOnly}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, leaderTradesTakerOnly: checked } : previous)}
          />
          <ToggleRow
            label="Execution engine enabled"
            description="Enable execution loop that processes pending copy attempts."
            checked={form.executionEngineEnabled}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, executionEngineEnabled: checked } : previous)}
          />
          <ToggleRow
            label="Panic mode"
            description="Emergency execution stop while keeping system services running."
            checked={form.panicMode}
            onCheckedChange={(checked) => setForm((previous) => previous ? { ...previous, panicMode: checked } : previous)}
          />
        </CardContent>
      </Card>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Persist</CardDescription>
          <CardTitle className="text-[#E7E7E7]">Save changes</CardTitle>
          <CardDescription className="text-[#919191]">Optional audit metadata for this config update.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-5 md:grid-cols-2 md:px-6">
          <InputField label="Changed by" value={form.changedBy} onChange={(value) => setForm((prev) => prev ? { ...prev, changedBy: value } : prev)} />
          <InputField label="Reason" value={form.reason} onChange={(value) => setForm((prev) => prev ? { ...prev, reason: value } : prev)} />
          <div className="md:col-span-2 flex flex-wrap items-center gap-2">
            <Button className={`${activeButtonClass} w-full sm:w-auto`} disabled={isSaving} onClick={() => void saveConfig()}>
              {isSaving ? 'Saving...' : 'Save config'}
            </Button>
            <p className="w-full text-sm text-[#919191] sm:w-auto">Updated at: {formatDateTime(configState.data.updatedAt)}</p>
          </div>
          {saveMessage ? <p className="md:col-span-2 text-sm text-[#CFCFCF]">{saveMessage}</p> : null}
        </CardContent>
      </Card>

      <Card className={`${panelClass} gap-4 py-5`}>
        <CardHeader className="px-5 pb-0 md:px-6">
          <CardDescription className="uppercase tracking-[0.18em] text-[#919191]">Audit</CardDescription>
          <CardTitle className="flex items-center gap-2 text-[#E7E7E7]">
            <History className="size-4 text-cyan-300" />
            Config audit log
          </CardTitle>
          <CardDescription className="text-[#919191]">Latest config changes (50 rows per page).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-5 md:px-6">
          {auditState.isLoading && !auditState.data ? (
            <LoadingState title="Loading audit" description="Fetching config audit entries." />
          ) : auditState.error && !auditState.data ? (
            <ErrorState title="Audit unavailable" description={auditState.error} actionLabel="Retry" onAction={() => void auditState.refresh()} />
          ) : !auditState.data || auditState.data.items.length === 0 ? (
            <EmptyState title="No audit entries" description="Config updates will appear here once changes are saved." />
          ) : (
            <>
              <div className="hidden overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] md:block">
                <Table>
                  <TableHeader className="[&_tr]:border-white/10">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Created at</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Scope</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Change type</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Changed by</TableHead>
                      <TableHead className="px-3 text-xs uppercase tracking-[0.16em] text-[#919191]">Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_tr]:border-white/5">
                    {auditState.data.items.map((row) => (
                      <TableRow key={row.id} className="hover:bg-white/[0.03]">
                        <TableCell className="px-3 text-[#CFCFCF]">{formatDateTime(row.createdAt)}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{row.scope}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{row.changeType}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{row.changedBy ?? 'n/a'}</TableCell>
                        <TableCell className="px-3 text-[#E7E7E7]">{row.reason ?? 'n/a'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-2 md:hidden">
                {auditState.data.items.map((row) => (
                  <div key={row.id} className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
                    <p className="text-xs text-[#919191]">{formatDateTime(row.createdAt)}</p>
                    <p className="text-sm font-medium text-[#E7E7E7]">{row.scope} · {row.changeType}</p>
                    <p className="text-xs text-[#919191]">By {row.changedBy ?? 'n/a'}</p>
                    <p className="text-sm text-[#E7E7E7]">{row.reason ?? 'No reason provided'}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
                <p className="text-xs text-[#919191]">
                  Total entries: <span className="text-[#E7E7E7]">{formatNumber(auditState.data.pagination.total, 0)}</span>
                </p>
                <PaginationControls
                  page={auditState.data.pagination.page}
                  totalPages={auditState.data.pagination.totalPages}
                  onPageChange={(nextPage) => setAuditPage(nextPage)}
                  className="flex items-center gap-3 [&_button]:rounded-xl [&_button]:border-white/10 [&_button]:bg-white/[0.02] [&_button]:text-[#E7E7E7] [&_button:hover]:bg-white/[0.06] [&_p]:text-[#919191]"
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange
}: {
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[#E7E7E7]">{label}</p>
        <p className="text-xs text-[#919191]">{description}</p>
      </div>
      <Switch
        className="self-start data-[state=checked]:bg-[#86efac] data-[state=unchecked]:bg-white/10 sm:self-auto"
        checked={checked}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

function InputField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="min-w-0 space-y-1 text-sm">
      <span className="text-xs uppercase tracking-[0.14em] text-[#919191]">{label}</span>
      <Input className={inputClass} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  )
}

function ModeToggle({
  label,
  leftLabel,
  rightLabel,
  value,
  onChange
}: {
  label: string
  leftLabel: string
  rightLabel: string
  value: 'global' | 'leader'
  onChange: (value: 'global' | 'leader') => void
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <p className="mb-2 text-xs uppercase tracking-[0.14em] text-[#919191]">{label}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className={`${value === 'global' ? activeButtonClass : outlineButtonClass} w-full justify-center sm:w-auto`}
          variant={value === 'global' ? 'default' : 'outline'}
          onClick={() => onChange('global')}
        >
          {leftLabel}
        </Button>
        <Button
          size="sm"
          className={`${value === 'leader' ? activeButtonClass : outlineButtonClass} w-full justify-center sm:w-auto`}
          variant={value === 'leader' ? 'default' : 'outline'}
          onClick={() => onChange('leader')}
        >
          {rightLabel}
        </Button>
      </div>
    </div>
  )
}

function LeaderModeHint({ leaders }: { leaders: Array<{ id: string; name: string; status: 'ACTIVE' | 'PAUSED' | 'DISABLED' }> }) {
  return (
    <div className="rounded-xl border border-dashed border-white/20 bg-white/[0.02] p-3 text-sm">
      <p className="font-medium text-[#E7E7E7]">Per-leader overrides are edited on Leader detail pages.</p>
      {leaders.length === 0 ? (
        <p className="mt-1 text-xs text-[#919191]">No leaders found yet.</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {leaders
            .filter((leader) => leader.status !== 'DISABLED')
            .slice(0, 8)
            .map((leader) => (
              <Button key={leader.id} asChild size="sm" variant="outline" className={`w-full justify-center sm:w-auto ${outlineButtonClass}`}>
                <Link href={`/leaders/${leader.id}`}>{leader.name}</Link>
              </Button>
            ))}
        </div>
      )}
    </div>
  )
}
