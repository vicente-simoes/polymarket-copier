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

export interface GlobalRuntimeConfigOverrides {
  tradeDetectionEnabled?: boolean
  userChannelWsEnabled?: boolean
  reconcileIntervalSeconds?: number
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

  const tradeDetectionEnabled =
    typeof masterSwitches.tradeDetectionEnabled === 'boolean' ? masterSwitches.tradeDetectionEnabled : undefined
  const userChannelWsEnabled =
    typeof masterSwitches.userChannelWsEnabled === 'boolean' ? masterSwitches.userChannelWsEnabled : undefined
  const interval = asPositiveInteger(reconcile.intervalSeconds)

  return {
    tradeDetectionEnabled,
    userChannelWsEnabled,
    reconcileIntervalSeconds: interval
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

export function toGlobalRuntimeConfigValue(config: SystemConfig): Record<string, unknown> {
  return {
    masterSwitches: {
      tradeDetectionEnabled: config.masterSwitches.tradeDetectionEnabled,
      userChannelWsEnabled: config.masterSwitches.userChannelWsEnabled
    },
    reconcile: {
      intervalSeconds: config.reconcile.intervalSeconds
    }
  }
}

export function equalGlobalRuntimeConfig(
  left: GlobalRuntimeConfigOverrides,
  right: GlobalRuntimeConfigOverrides
): boolean {
  return (
    left.tradeDetectionEnabled === right.tradeDetectionEnabled &&
    left.userChannelWsEnabled === right.userChannelWsEnabled &&
    left.reconcileIntervalSeconds === right.reconcileIntervalSeconds
  )
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
