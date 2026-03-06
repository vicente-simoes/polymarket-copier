import { z } from 'zod'

const PositiveNumberSchema = z.number().positive()
const NonNegativeNumberSchema = z.number().nonnegative()

export const SystemConfigSchema = z.object({
  masterSwitches: z.object({
    copySystemEnabled: z.boolean(),
    tradeDetectionEnabled: z.boolean(),
    userChannelWsEnabled: z.boolean()
  }),
  reconcile: z.object({
    intervalSeconds: z.number().int().positive()
  }),
  guardrails: z.object({
    attemptExpirationSeconds: z.number().int().positive(),
    maxWorseningBuyUsd: NonNegativeNumberSchema,
    maxWorseningSellUsd: NonNegativeNumberSchema,
    buyImprovementGuardEnabled: z.boolean(),
    maxBuyImprovementBps: z.number().int().positive().nullable(),
    maxSlippageBps: z.number().int().nonnegative(),
    maxSpreadUsd: NonNegativeNumberSchema,
    maxPricePerShareUsd: PositiveNumberSchema.nullable(),
    minNotionalPerOrderUsd: PositiveNumberSchema,
    minBookDepthForSizeEnabled: z.boolean(),
    cooldownPerMarketSeconds: z.number().int().nonnegative(),
    maxRetriesPerAttempt: z.number().int().nonnegative(),
    maxOpenOrders: z.number().int().positive().nullable()
  }),
  sizing: z.object({
    copyRatio: z.number().min(0).max(1),
    maxExposurePerLeaderUsd: PositiveNumberSchema,
    maxExposurePerMarketOutcomeUsd: PositiveNumberSchema,
    maxHourlyNotionalTurnoverUsd: PositiveNumberSchema,
    maxDailyNotionalTurnoverUsd: PositiveNumberSchema
  })
})

export type SystemConfig = z.infer<typeof SystemConfigSchema>

export const RuntimeOpsConfigSchema = z.object({
  chainTriggerWsEnabled: z.boolean(),
  fillReconcileEnabled: z.boolean(),
  fillReconcileIntervalSeconds: z.number().int().positive(),
  fillParseStarvationWindowSeconds: z.number().int().positive(),
  fillParseStarvationMinMessages: z.number().int().positive(),
  targetNettingEnabled: z.boolean(),
  targetNettingIntervalMs: z.number().int().positive(),
  targetNettingTrackingErrorBps: z.number().int().nonnegative(),
  reconcileEngineEnabled: z.boolean(),
  reconcileStaleLeaderSyncSeconds: z.number().int().positive(),
  reconcileStaleFollowerSyncSeconds: z.number().int().positive(),
  reconcileGuardrailFailureCycleThreshold: z.number().int().positive(),
  leaderTradesPollIntervalSeconds: z.number().int().positive(),
  leaderTradesTakerOnly: z.boolean(),
  executionEngineEnabled: z.boolean(),
  panicMode: z.boolean()
})

export type RuntimeOpsConfig = z.infer<typeof RuntimeOpsConfigSchema>

export const RuntimeOpsConfigPatchSchema = RuntimeOpsConfigSchema.partial()
export type RuntimeOpsConfigPatch = z.infer<typeof RuntimeOpsConfigPatchSchema>

export interface GlobalRuntimeConfigOverrides {
  tradeDetectionEnabled?: boolean
  userChannelWsEnabled?: boolean
  reconcileIntervalSeconds?: number
  runtimeOps?: Partial<RuntimeOpsConfig>
}

export const SystemConfigPatchSchema = z.object({
  masterSwitches: z
    .object({
      copySystemEnabled: z.boolean().optional(),
      tradeDetectionEnabled: z.boolean().optional(),
      userChannelWsEnabled: z.boolean().optional()
    })
    .optional(),
  reconcile: z
    .object({
      intervalSeconds: z.number().int().positive().optional()
    })
    .optional(),
  guardrails: z
    .object({
      attemptExpirationSeconds: z.number().int().positive().optional(),
      maxWorseningBuyUsd: NonNegativeNumberSchema.optional(),
      maxWorseningSellUsd: NonNegativeNumberSchema.optional(),
      buyImprovementGuardEnabled: z.boolean().optional(),
      maxBuyImprovementBps: z.number().int().positive().nullable().optional(),
      maxSlippageBps: z.number().int().nonnegative().optional(),
      maxSpreadUsd: NonNegativeNumberSchema.optional(),
      maxPricePerShareUsd: PositiveNumberSchema.nullable().optional(),
      minNotionalPerOrderUsd: PositiveNumberSchema.optional(),
      minBookDepthForSizeEnabled: z.boolean().optional(),
      cooldownPerMarketSeconds: z.number().int().nonnegative().optional(),
      maxRetriesPerAttempt: z.number().int().nonnegative().optional(),
      maxOpenOrders: z.number().int().positive().nullable().optional()
    })
    .optional(),
  sizing: z
    .object({
      copyRatio: z.number().min(0).max(1).optional(),
      maxExposurePerLeaderUsd: PositiveNumberSchema.optional(),
      maxExposurePerMarketOutcomeUsd: PositiveNumberSchema.optional(),
      maxHourlyNotionalTurnoverUsd: PositiveNumberSchema.optional(),
      maxDailyNotionalTurnoverUsd: PositiveNumberSchema.optional()
    })
    .optional(),
  runtimeOps: RuntimeOpsConfigPatchSchema.optional(),
  applyRatioToExistingLeaders: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
  changedBy: z.string().trim().max(120).optional()
})

export type SystemConfigPatch = z.infer<typeof SystemConfigPatchSchema>

export const DEFAULT_SYSTEM_CONFIG: SystemConfig = SystemConfigSchema.parse({
  masterSwitches: {
    copySystemEnabled: fromEnvBoolean(process.env.COPY_SYSTEM_ENABLED, false),
    tradeDetectionEnabled: fromEnvBoolean(process.env.TRADE_DETECTION_ENABLED, true),
    userChannelWsEnabled: fromEnvBoolean(process.env.USER_CHANNEL_WS_ENABLED, true)
  },
  reconcile: {
    intervalSeconds: fromEnvNumber(process.env.RECONCILE_INTERVAL_SECONDS, 60)
  },
  guardrails: {
    attemptExpirationSeconds: fromEnvNumber(process.env.ATTEMPT_EXPIRATION_SECONDS, 7_200),
    maxWorseningBuyUsd: fromEnvNumber(process.env.MAX_WORSENING_BUY_USD, 0.03),
    maxWorseningSellUsd: fromEnvNumber(process.env.MAX_WORSENING_SELL_USD, 0.06),
    buyImprovementGuardEnabled: fromEnvBoolean(process.env.BUY_IMPROVEMENT_GUARD_ENABLED, false),
    maxBuyImprovementBps: fromEnvOptionalNumber(process.env.MAX_BUY_IMPROVEMENT_BPS),
    maxSlippageBps: fromEnvNumber(process.env.MAX_SLIPPAGE_BPS, 200),
    maxSpreadUsd: fromEnvNumber(process.env.MAX_SPREAD_USD, 0.03),
    maxPricePerShareUsd: fromEnvOptionalNumber(process.env.MAX_PRICE_PER_SHARE_USD),
    minNotionalPerOrderUsd: fromEnvNumber(process.env.MIN_NOTIONAL_PER_ORDER_USD, 1),
    minBookDepthForSizeEnabled: fromEnvBoolean(process.env.MIN_BOOK_DEPTH_FOR_SIZE_ENABLED, true),
    cooldownPerMarketSeconds: fromEnvNumber(process.env.COOLDOWN_PER_MARKET_SECONDS, 5),
    maxRetriesPerAttempt: fromEnvNumber(process.env.MAX_RETRIES_PER_ATTEMPT, 20),
    maxOpenOrders: fromEnvNumber(process.env.MAX_OPEN_ORDERS, 20)
  },
  sizing: {
    copyRatio: 0.01,
    maxExposurePerLeaderUsd: fromEnvNumber(process.env.MAX_EXPOSURE_PER_LEADER_USD, 100),
    maxExposurePerMarketOutcomeUsd: fromEnvNumber(process.env.MAX_EXPOSURE_PER_MARKET_OUTCOME_USD, 50),
    maxHourlyNotionalTurnoverUsd: fromEnvNumber(process.env.MAX_HOURLY_NOTIONAL_TURNOVER_USD, 25),
    maxDailyNotionalTurnoverUsd: fromEnvNumber(process.env.MAX_DAILY_NOTIONAL_TURNOVER_USD, 100)
  }
})

export const DEFAULT_RUNTIME_OPS_CONFIG: RuntimeOpsConfig = RuntimeOpsConfigSchema.parse({
  chainTriggerWsEnabled: fromEnvBoolean(process.env.CHAIN_TRIGGER_WS_ENABLED, true),
  fillReconcileEnabled: fromEnvBoolean(process.env.FILL_RECONCILE_ENABLED, true),
  fillReconcileIntervalSeconds: fromEnvNumber(process.env.FILL_RECONCILE_INTERVAL_SECONDS, 30),
  fillParseStarvationWindowSeconds: fromEnvNumber(process.env.FILL_PARSE_STARVATION_WINDOW_SECONDS, 300),
  fillParseStarvationMinMessages: fromEnvNumber(process.env.FILL_PARSE_STARVATION_MIN_MESSAGES, 20),
  targetNettingEnabled: fromEnvBoolean(process.env.TARGET_NETTING_ENABLED, true),
  targetNettingIntervalMs: fromEnvNumber(process.env.TARGET_NETTING_INTERVAL_MS, 5_000),
  targetNettingTrackingErrorBps: fromEnvNumber(process.env.TARGET_NETTING_TRACKING_ERROR_BPS, 0),
  reconcileEngineEnabled: fromEnvBoolean(process.env.RECONCILE_ENGINE_ENABLED, true),
  reconcileStaleLeaderSyncSeconds: fromEnvNumber(process.env.RECONCILE_STALE_LEADER_SYNC_SECONDS, 180),
  reconcileStaleFollowerSyncSeconds: fromEnvNumber(process.env.RECONCILE_STALE_FOLLOWER_SYNC_SECONDS, 180),
  reconcileGuardrailFailureCycleThreshold: fromEnvNumber(process.env.RECONCILE_GUARDRAIL_FAILURE_CYCLE_THRESHOLD, 5),
  leaderTradesPollIntervalSeconds: fromEnvNumber(process.env.LEADER_TRADES_POLL_INTERVAL_SECONDS, 30),
  leaderTradesTakerOnly: fromEnvBoolean(process.env.LEADER_TRADES_TAKER_ONLY, false),
  executionEngineEnabled: fromEnvBoolean(process.env.EXECUTION_ENGINE_ENABLED, true),
  panicMode: fromEnvBoolean(process.env.PANIC_MODE, false)
})

export function resolveSystemConfig(rawConfig: unknown, fallbackRatio: number): SystemConfig {
  const base = asObject(rawConfig)
  const merged = {
    ...DEFAULT_SYSTEM_CONFIG,
    ...base,
    masterSwitches: {
      ...DEFAULT_SYSTEM_CONFIG.masterSwitches,
      ...asObject(base.masterSwitches)
    },
    reconcile: {
      ...DEFAULT_SYSTEM_CONFIG.reconcile,
      ...asObject(base.reconcile)
    },
    guardrails: {
      ...DEFAULT_SYSTEM_CONFIG.guardrails,
      ...asObject(base.guardrails)
    },
    sizing: {
      ...DEFAULT_SYSTEM_CONFIG.sizing,
      ...asObject(base.sizing),
      copyRatio: fallbackRatio
    }
  }

  return SystemConfigSchema.parse(merged)
}

export function applySystemConfigPatch(base: SystemConfig, patch: SystemConfigPatch): SystemConfig {
  const merged = {
    ...base,
    masterSwitches: {
      ...base.masterSwitches,
      ...(patch.masterSwitches ?? {})
    },
    reconcile: {
      ...base.reconcile,
      ...(patch.reconcile ?? {})
    },
    guardrails: {
      ...base.guardrails,
      ...(patch.guardrails ?? {})
    },
    sizing: {
      ...base.sizing,
      ...(patch.sizing ?? {})
    }
  }

  return SystemConfigSchema.parse(merged)
}

export function resolveGlobalRuntimeConfig(rawConfig: unknown): GlobalRuntimeConfigOverrides {
  const config = asObject(rawConfig)
  const masterSwitches = asObject(config.masterSwitches)
  const reconcile = asObject(config.reconcile)
  const ops = asObject(config.ops)

  const tradeDetectionEnabled =
    typeof masterSwitches.tradeDetectionEnabled === 'boolean' ? masterSwitches.tradeDetectionEnabled : undefined
  const userChannelWsEnabled =
    typeof masterSwitches.userChannelWsEnabled === 'boolean' ? masterSwitches.userChannelWsEnabled : undefined
  const interval = asPositiveInteger(reconcile.intervalSeconds)

  return {
    tradeDetectionEnabled,
    userChannelWsEnabled,
    reconcileIntervalSeconds: interval,
    runtimeOps: {
      chainTriggerWsEnabled: asBoolean(ops.chainTriggerWsEnabled),
      fillReconcileEnabled: asBoolean(ops.fillReconcileEnabled),
      fillReconcileIntervalSeconds: asPositiveInteger(ops.fillReconcileIntervalSeconds),
      fillParseStarvationWindowSeconds: asPositiveInteger(ops.fillParseStarvationWindowSeconds),
      fillParseStarvationMinMessages: asPositiveInteger(ops.fillParseStarvationMinMessages),
      targetNettingEnabled: asBoolean(ops.targetNettingEnabled),
      targetNettingIntervalMs: asPositiveInteger(ops.targetNettingIntervalMs),
      targetNettingTrackingErrorBps: asNonNegativeInteger(ops.targetNettingTrackingErrorBps),
      reconcileEngineEnabled: asBoolean(ops.reconcileEngineEnabled),
      reconcileStaleLeaderSyncSeconds: asPositiveInteger(ops.reconcileStaleLeaderSyncSeconds),
      reconcileStaleFollowerSyncSeconds: asPositiveInteger(ops.reconcileStaleFollowerSyncSeconds),
      reconcileGuardrailFailureCycleThreshold: asPositiveInteger(ops.reconcileGuardrailFailureCycleThreshold),
      leaderTradesPollIntervalSeconds: asPositiveInteger(ops.leaderTradesPollIntervalSeconds),
      leaderTradesTakerOnly: asBoolean(ops.leaderTradesTakerOnly),
      executionEngineEnabled: asBoolean(ops.executionEngineEnabled),
      panicMode: asBoolean(ops.panicMode)
    }
  }
}

export function applyGlobalRuntimeOverrides(base: SystemConfig, overrides: GlobalRuntimeConfigOverrides): SystemConfig {
  const merged = {
    ...base,
    masterSwitches: {
      ...base.masterSwitches,
      tradeDetectionEnabled: overrides.tradeDetectionEnabled ?? base.masterSwitches.tradeDetectionEnabled,
      userChannelWsEnabled: overrides.userChannelWsEnabled ?? base.masterSwitches.userChannelWsEnabled
    },
    reconcile: {
      ...base.reconcile,
      intervalSeconds: overrides.reconcileIntervalSeconds ?? base.reconcile.intervalSeconds
    }
  }

  return SystemConfigSchema.parse(merged)
}

export function resolveEffectiveRuntimeOpsConfig(overrides?: Partial<RuntimeOpsConfig>): RuntimeOpsConfig {
  return RuntimeOpsConfigSchema.parse({
    ...DEFAULT_RUNTIME_OPS_CONFIG,
    ...(overrides ?? {})
  })
}

export function applyRuntimeOpsPatch(base: RuntimeOpsConfig, patch: RuntimeOpsConfigPatch): RuntimeOpsConfig {
  return RuntimeOpsConfigSchema.parse({
    ...base,
    ...patch
  })
}

export function toGlobalRuntimeConfigValue(config: SystemConfig): Record<string, unknown> {
  return toGlobalRuntimeConfigValueWithOps(config, DEFAULT_RUNTIME_OPS_CONFIG)
}

export function toGlobalRuntimeConfigValueWithOps(
  config: SystemConfig,
  runtimeOps: RuntimeOpsConfig
): Record<string, unknown> {
  return {
    masterSwitches: {
      tradeDetectionEnabled: config.masterSwitches.tradeDetectionEnabled,
      userChannelWsEnabled: config.masterSwitches.userChannelWsEnabled
    },
    reconcile: {
      intervalSeconds: config.reconcile.intervalSeconds
    },
    ops: runtimeOps
  }
}

export function equalRuntimeOpsConfig(left: RuntimeOpsConfig, right: RuntimeOpsConfig): boolean {
  return (
    left.chainTriggerWsEnabled === right.chainTriggerWsEnabled &&
    left.fillReconcileEnabled === right.fillReconcileEnabled &&
    left.fillReconcileIntervalSeconds === right.fillReconcileIntervalSeconds &&
    left.fillParseStarvationWindowSeconds === right.fillParseStarvationWindowSeconds &&
    left.fillParseStarvationMinMessages === right.fillParseStarvationMinMessages &&
    left.targetNettingEnabled === right.targetNettingEnabled &&
    left.targetNettingIntervalMs === right.targetNettingIntervalMs &&
    left.targetNettingTrackingErrorBps === right.targetNettingTrackingErrorBps &&
    left.reconcileEngineEnabled === right.reconcileEngineEnabled &&
    left.reconcileStaleLeaderSyncSeconds === right.reconcileStaleLeaderSyncSeconds &&
    left.reconcileStaleFollowerSyncSeconds === right.reconcileStaleFollowerSyncSeconds &&
    left.reconcileGuardrailFailureCycleThreshold === right.reconcileGuardrailFailureCycleThreshold &&
    left.leaderTradesPollIntervalSeconds === right.leaderTradesPollIntervalSeconds &&
    left.leaderTradesTakerOnly === right.leaderTradesTakerOnly &&
    left.executionEngineEnabled === right.executionEngineEnabled &&
    left.panicMode === right.panicMode
  )
}

export function equalGlobalRuntimeConfig(
  left: GlobalRuntimeConfigOverrides,
  right: GlobalRuntimeConfigOverrides
): boolean {
  const leftRuntimeOps = resolveEffectiveRuntimeOpsConfig(left.runtimeOps)
  const rightRuntimeOps = resolveEffectiveRuntimeOpsConfig(right.runtimeOps)

  return (
    left.tradeDetectionEnabled === right.tradeDetectionEnabled &&
    left.userChannelWsEnabled === right.userChannelWsEnabled &&
    left.reconcileIntervalSeconds === right.reconcileIntervalSeconds &&
    equalRuntimeOpsConfig(leftRuntimeOps, rightRuntimeOps)
  )
}

export function toRuntimeOpsConfigRecord(runtimeOps: RuntimeOpsConfig): Record<string, unknown> {
  return {
    ops: {
      chainTriggerWsEnabled: runtimeOps.chainTriggerWsEnabled,
      fillReconcileEnabled: runtimeOps.fillReconcileEnabled,
      fillReconcileIntervalSeconds: runtimeOps.fillReconcileIntervalSeconds,
      fillParseStarvationWindowSeconds: runtimeOps.fillParseStarvationWindowSeconds,
      fillParseStarvationMinMessages: runtimeOps.fillParseStarvationMinMessages,
      targetNettingEnabled: runtimeOps.targetNettingEnabled,
      targetNettingIntervalMs: runtimeOps.targetNettingIntervalMs,
      targetNettingTrackingErrorBps: runtimeOps.targetNettingTrackingErrorBps,
      reconcileEngineEnabled: runtimeOps.reconcileEngineEnabled,
      reconcileStaleLeaderSyncSeconds: runtimeOps.reconcileStaleLeaderSyncSeconds,
      reconcileStaleFollowerSyncSeconds: runtimeOps.reconcileStaleFollowerSyncSeconds,
      reconcileGuardrailFailureCycleThreshold: runtimeOps.reconcileGuardrailFailureCycleThreshold,
      leaderTradesPollIntervalSeconds: runtimeOps.leaderTradesPollIntervalSeconds,
      leaderTradesTakerOnly: runtimeOps.leaderTradesTakerOnly,
      executionEngineEnabled: runtimeOps.executionEngineEnabled,
      panicMode: runtimeOps.panicMode
    }
  }
}

export function fromEnvNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return parsed
}

export function fromEnvBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback
  }

  const normalized = raw.toLowerCase()
  if (normalized === 'true') {
    return true
  }
  if (normalized === 'false') {
    return false
  }
  return fallback
}

function fromEnvOptionalNumber(raw: string | undefined): number | null {
  if (!raw) {
    return null
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }

  return parsed
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function asPositiveInteger(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return undefined
  }
  return numberValue
}

function asNonNegativeInteger(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(numberValue) || numberValue < 0) {
    return undefined
  }
  return numberValue
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
