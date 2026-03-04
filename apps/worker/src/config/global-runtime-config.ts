export interface GlobalRuntimeOpsOverrides {
  chainTriggerWsEnabled?: boolean
  fillReconcileEnabled?: boolean
  fillReconcileIntervalSeconds?: number
  fillParseStarvationWindowSeconds?: number
  fillParseStarvationMinMessages?: number
  targetNettingEnabled?: boolean
  targetNettingIntervalMs?: number
  targetNettingTrackingErrorBps?: number
  reconcileEngineEnabled?: boolean
  reconcileStaleLeaderSyncSeconds?: number
  reconcileStaleFollowerSyncSeconds?: number
  reconcileGuardrailFailureCycleThreshold?: number
  leaderTradesPollIntervalSeconds?: number
  leaderTradesTakerOnly?: boolean
  executionEngineEnabled?: boolean
  panicMode?: boolean
}

export interface GlobalRuntimeConfigOverrides {
  tradeDetectionEnabled?: boolean
  userChannelWsEnabled?: boolean
  reconcileIntervalSeconds?: number
  runtimeOps?: GlobalRuntimeOpsOverrides
}

export interface EffectiveGlobalRuntimeOpsConfig {
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

export interface EffectiveGlobalRuntimeConfig {
  tradeDetectionEnabled: boolean
  userChannelWsEnabled: boolean
  reconcileIntervalSeconds: number
  runtimeOps: EffectiveGlobalRuntimeOpsConfig
}

export function readGlobalRuntimeConfigOverrides(value: unknown): GlobalRuntimeConfigOverrides {
  const raw = asObject(value)
  const masterSwitches = asObject(raw.masterSwitches)
  const reconcile = asObject(raw.reconcile)
  const ops = asObject(raw.ops)

  return {
    tradeDetectionEnabled:
      typeof masterSwitches.tradeDetectionEnabled === 'boolean' ? masterSwitches.tradeDetectionEnabled : undefined,
    userChannelWsEnabled:
      typeof masterSwitches.userChannelWsEnabled === 'boolean' ? masterSwitches.userChannelWsEnabled : undefined,
    reconcileIntervalSeconds: readPositiveInteger(reconcile.intervalSeconds),
    runtimeOps: {
      chainTriggerWsEnabled: readBoolean(ops.chainTriggerWsEnabled),
      fillReconcileEnabled: readBoolean(ops.fillReconcileEnabled),
      fillReconcileIntervalSeconds: readPositiveInteger(ops.fillReconcileIntervalSeconds),
      fillParseStarvationWindowSeconds: readPositiveInteger(ops.fillParseStarvationWindowSeconds),
      fillParseStarvationMinMessages: readPositiveInteger(ops.fillParseStarvationMinMessages),
      targetNettingEnabled: readBoolean(ops.targetNettingEnabled),
      targetNettingIntervalMs: readPositiveInteger(ops.targetNettingIntervalMs),
      targetNettingTrackingErrorBps: readNonNegativeInteger(ops.targetNettingTrackingErrorBps),
      reconcileEngineEnabled: readBoolean(ops.reconcileEngineEnabled),
      reconcileStaleLeaderSyncSeconds: readPositiveInteger(ops.reconcileStaleLeaderSyncSeconds),
      reconcileStaleFollowerSyncSeconds: readPositiveInteger(ops.reconcileStaleFollowerSyncSeconds),
      reconcileGuardrailFailureCycleThreshold: readPositiveInteger(ops.reconcileGuardrailFailureCycleThreshold),
      leaderTradesPollIntervalSeconds: readPositiveInteger(ops.leaderTradesPollIntervalSeconds),
      leaderTradesTakerOnly: readBoolean(ops.leaderTradesTakerOnly),
      executionEngineEnabled: readBoolean(ops.executionEngineEnabled),
      panicMode: readBoolean(ops.panicMode)
    }
  }
}

export function resolveEffectiveGlobalRuntimeConfig(
  baseline: EffectiveGlobalRuntimeConfig,
  overrides: GlobalRuntimeConfigOverrides
): EffectiveGlobalRuntimeConfig {
  const ops = overrides.runtimeOps ?? {}
  return {
    tradeDetectionEnabled: overrides.tradeDetectionEnabled ?? baseline.tradeDetectionEnabled,
    userChannelWsEnabled: overrides.userChannelWsEnabled ?? baseline.userChannelWsEnabled,
    reconcileIntervalSeconds: overrides.reconcileIntervalSeconds ?? baseline.reconcileIntervalSeconds,
    runtimeOps: {
      chainTriggerWsEnabled: ops.chainTriggerWsEnabled ?? baseline.runtimeOps.chainTriggerWsEnabled,
      fillReconcileEnabled: ops.fillReconcileEnabled ?? baseline.runtimeOps.fillReconcileEnabled,
      fillReconcileIntervalSeconds: ops.fillReconcileIntervalSeconds ?? baseline.runtimeOps.fillReconcileIntervalSeconds,
      fillParseStarvationWindowSeconds:
        ops.fillParseStarvationWindowSeconds ?? baseline.runtimeOps.fillParseStarvationWindowSeconds,
      fillParseStarvationMinMessages:
        ops.fillParseStarvationMinMessages ?? baseline.runtimeOps.fillParseStarvationMinMessages,
      targetNettingEnabled: ops.targetNettingEnabled ?? baseline.runtimeOps.targetNettingEnabled,
      targetNettingIntervalMs: ops.targetNettingIntervalMs ?? baseline.runtimeOps.targetNettingIntervalMs,
      targetNettingTrackingErrorBps:
        ops.targetNettingTrackingErrorBps ?? baseline.runtimeOps.targetNettingTrackingErrorBps,
      reconcileEngineEnabled: ops.reconcileEngineEnabled ?? baseline.runtimeOps.reconcileEngineEnabled,
      reconcileStaleLeaderSyncSeconds:
        ops.reconcileStaleLeaderSyncSeconds ?? baseline.runtimeOps.reconcileStaleLeaderSyncSeconds,
      reconcileStaleFollowerSyncSeconds:
        ops.reconcileStaleFollowerSyncSeconds ?? baseline.runtimeOps.reconcileStaleFollowerSyncSeconds,
      reconcileGuardrailFailureCycleThreshold:
        ops.reconcileGuardrailFailureCycleThreshold ?? baseline.runtimeOps.reconcileGuardrailFailureCycleThreshold,
      leaderTradesPollIntervalSeconds:
        ops.leaderTradesPollIntervalSeconds ?? baseline.runtimeOps.leaderTradesPollIntervalSeconds,
      leaderTradesTakerOnly: ops.leaderTradesTakerOnly ?? baseline.runtimeOps.leaderTradesTakerOnly,
      executionEngineEnabled: ops.executionEngineEnabled ?? baseline.runtimeOps.executionEngineEnabled,
      panicMode: ops.panicMode ?? baseline.runtimeOps.panicMode
    }
  }
}

export function resolveEffectiveChainTriggerEnabled(config: EffectiveGlobalRuntimeConfig): boolean {
  return config.tradeDetectionEnabled && config.runtimeOps.chainTriggerWsEnabled
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

function readNonNegativeInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(parsed) || parsed < 0) {
    return undefined
  }

  return parsed
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
