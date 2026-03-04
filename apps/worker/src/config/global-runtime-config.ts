export interface GlobalRuntimeConfigOverrides {
  tradeDetectionEnabled?: boolean
  userChannelWsEnabled?: boolean
  reconcileIntervalSeconds?: number
}

export interface EffectiveGlobalRuntimeConfig {
  tradeDetectionEnabled: boolean
  userChannelWsEnabled: boolean
  reconcileIntervalSeconds: number
}

export function readGlobalRuntimeConfigOverrides(value: unknown): GlobalRuntimeConfigOverrides {
  const raw = asObject(value)
  const masterSwitches = asObject(raw.masterSwitches)
  const reconcile = asObject(raw.reconcile)

  return {
    tradeDetectionEnabled:
      typeof masterSwitches.tradeDetectionEnabled === 'boolean' ? masterSwitches.tradeDetectionEnabled : undefined,
    userChannelWsEnabled:
      typeof masterSwitches.userChannelWsEnabled === 'boolean' ? masterSwitches.userChannelWsEnabled : undefined,
    reconcileIntervalSeconds: readPositiveInteger(reconcile.intervalSeconds)
  }
}

export function resolveEffectiveGlobalRuntimeConfig(
  baseline: EffectiveGlobalRuntimeConfig,
  overrides: GlobalRuntimeConfigOverrides
): EffectiveGlobalRuntimeConfig {
  return {
    tradeDetectionEnabled: overrides.tradeDetectionEnabled ?? baseline.tradeDetectionEnabled,
    userChannelWsEnabled: overrides.userChannelWsEnabled ?? baseline.userChannelWsEnabled,
    reconcileIntervalSeconds: overrides.reconcileIntervalSeconds ?? baseline.reconcileIntervalSeconds
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined
  }

  return parsed
}
