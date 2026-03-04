import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readGlobalRuntimeConfigOverrides,
  resolveEffectiveChainTriggerEnabled,
  resolveEffectiveGlobalRuntimeConfig
} from '../src/config/global-runtime-config.js'

test('global runtime config parser accepts valid fields', () => {
  const parsed = readGlobalRuntimeConfigOverrides({
    masterSwitches: {
      tradeDetectionEnabled: false,
      userChannelWsEnabled: true
    },
    reconcile: {
      intervalSeconds: 45
    },
    ops: {
      chainTriggerWsEnabled: false,
      fillReconcileEnabled: true,
      fillReconcileIntervalSeconds: 60,
      fillParseStarvationWindowSeconds: 120,
      fillParseStarvationMinMessages: 8,
      targetNettingEnabled: true,
      targetNettingIntervalMs: 5000,
      targetNettingTrackingErrorBps: 0,
      reconcileEngineEnabled: true,
      reconcileStaleLeaderSyncSeconds: 200,
      reconcileStaleFollowerSyncSeconds: 220,
      reconcileGuardrailFailureCycleThreshold: 3,
      leaderTradesPollIntervalSeconds: 20,
      leaderTradesTakerOnly: false,
      executionEngineEnabled: true,
      panicMode: false
    }
  })

  assert.deepEqual(parsed, {
    tradeDetectionEnabled: false,
    userChannelWsEnabled: true,
    reconcileIntervalSeconds: 45,
    runtimeOps: {
      chainTriggerWsEnabled: false,
      fillReconcileEnabled: true,
      fillReconcileIntervalSeconds: 60,
      fillParseStarvationWindowSeconds: 120,
      fillParseStarvationMinMessages: 8,
      targetNettingEnabled: true,
      targetNettingIntervalMs: 5000,
      targetNettingTrackingErrorBps: 0,
      reconcileEngineEnabled: true,
      reconcileStaleLeaderSyncSeconds: 200,
      reconcileStaleFollowerSyncSeconds: 220,
      reconcileGuardrailFailureCycleThreshold: 3,
      leaderTradesPollIntervalSeconds: 20,
      leaderTradesTakerOnly: false,
      executionEngineEnabled: true,
      panicMode: false
    }
  })
})

test('global runtime config parser ignores invalid fields', () => {
  const parsed = readGlobalRuntimeConfigOverrides({
    masterSwitches: {
      tradeDetectionEnabled: 'false',
      userChannelWsEnabled: 1
    },
    reconcile: {
      intervalSeconds: 0
    },
    ops: {
      chainTriggerWsEnabled: 'yes',
      fillReconcileEnabled: 'true',
      fillReconcileIntervalSeconds: -1,
      fillParseStarvationWindowSeconds: 0,
      fillParseStarvationMinMessages: 'a',
      targetNettingEnabled: 123,
      targetNettingIntervalMs: 0,
      targetNettingTrackingErrorBps: -2,
      reconcileEngineEnabled: null,
      reconcileStaleLeaderSyncSeconds: -1,
      reconcileStaleFollowerSyncSeconds: -1,
      reconcileGuardrailFailureCycleThreshold: 0,
      leaderTradesPollIntervalSeconds: 0,
      leaderTradesTakerOnly: 'false',
      executionEngineEnabled: 'false',
      panicMode: 'false'
    }
  })

  assert.deepEqual(parsed, {
    tradeDetectionEnabled: undefined,
    userChannelWsEnabled: undefined,
    reconcileIntervalSeconds: undefined,
    runtimeOps: {
      chainTriggerWsEnabled: undefined,
      fillReconcileEnabled: undefined,
      fillReconcileIntervalSeconds: undefined,
      fillParseStarvationWindowSeconds: undefined,
      fillParseStarvationMinMessages: undefined,
      targetNettingEnabled: undefined,
      targetNettingIntervalMs: undefined,
      targetNettingTrackingErrorBps: undefined,
      reconcileEngineEnabled: undefined,
      reconcileStaleLeaderSyncSeconds: undefined,
      reconcileStaleFollowerSyncSeconds: undefined,
      reconcileGuardrailFailureCycleThreshold: undefined,
      leaderTradesPollIntervalSeconds: undefined,
      leaderTradesTakerOnly: undefined,
      executionEngineEnabled: undefined,
      panicMode: undefined
    }
  })
})

test('global runtime config resolver falls back to baseline for missing overrides', () => {
  const resolved = resolveEffectiveGlobalRuntimeConfig(
    {
      tradeDetectionEnabled: true,
      userChannelWsEnabled: false,
      reconcileIntervalSeconds: 60,
      runtimeOps: {
        chainTriggerWsEnabled: true,
        fillReconcileEnabled: true,
        fillReconcileIntervalSeconds: 30,
        fillParseStarvationWindowSeconds: 300,
        fillParseStarvationMinMessages: 20,
        targetNettingEnabled: true,
        targetNettingIntervalMs: 5000,
        targetNettingTrackingErrorBps: 0,
        reconcileEngineEnabled: true,
        reconcileStaleLeaderSyncSeconds: 180,
        reconcileStaleFollowerSyncSeconds: 180,
        reconcileGuardrailFailureCycleThreshold: 5,
        leaderTradesPollIntervalSeconds: 30,
        leaderTradesTakerOnly: false,
        executionEngineEnabled: true,
        panicMode: false
      }
    },
    {
      userChannelWsEnabled: true,
      runtimeOps: {
        panicMode: true,
        targetNettingIntervalMs: 7000
      }
    }
  )

  assert.deepEqual(resolved, {
    tradeDetectionEnabled: true,
    userChannelWsEnabled: true,
    reconcileIntervalSeconds: 60,
    runtimeOps: {
      chainTriggerWsEnabled: true,
      fillReconcileEnabled: true,
      fillReconcileIntervalSeconds: 30,
      fillParseStarvationWindowSeconds: 300,
      fillParseStarvationMinMessages: 20,
      targetNettingEnabled: true,
      targetNettingIntervalMs: 7000,
      targetNettingTrackingErrorBps: 0,
      reconcileEngineEnabled: true,
      reconcileStaleLeaderSyncSeconds: 180,
      reconcileStaleFollowerSyncSeconds: 180,
      reconcileGuardrailFailureCycleThreshold: 5,
      leaderTradesPollIntervalSeconds: 30,
      leaderTradesTakerOnly: false,
      executionEngineEnabled: true,
      panicMode: true
    }
  })
})

test('chain trigger effective enable requires both trade detection and chain trigger ws', () => {
  assert.equal(
    resolveEffectiveChainTriggerEnabled({
      tradeDetectionEnabled: true,
      userChannelWsEnabled: true,
      reconcileIntervalSeconds: 60,
      runtimeOps: {
        chainTriggerWsEnabled: true,
        fillReconcileEnabled: true,
        fillReconcileIntervalSeconds: 30,
        fillParseStarvationWindowSeconds: 300,
        fillParseStarvationMinMessages: 20,
        targetNettingEnabled: true,
        targetNettingIntervalMs: 5000,
        targetNettingTrackingErrorBps: 0,
        reconcileEngineEnabled: true,
        reconcileStaleLeaderSyncSeconds: 180,
        reconcileStaleFollowerSyncSeconds: 180,
        reconcileGuardrailFailureCycleThreshold: 5,
        leaderTradesPollIntervalSeconds: 30,
        leaderTradesTakerOnly: false,
        executionEngineEnabled: true,
        panicMode: false
      }
    }),
    true
  )

  assert.equal(
    resolveEffectiveChainTriggerEnabled({
      tradeDetectionEnabled: false,
      userChannelWsEnabled: true,
      reconcileIntervalSeconds: 60,
      runtimeOps: {
        chainTriggerWsEnabled: true,
        fillReconcileEnabled: true,
        fillReconcileIntervalSeconds: 30,
        fillParseStarvationWindowSeconds: 300,
        fillParseStarvationMinMessages: 20,
        targetNettingEnabled: true,
        targetNettingIntervalMs: 5000,
        targetNettingTrackingErrorBps: 0,
        reconcileEngineEnabled: true,
        reconcileStaleLeaderSyncSeconds: 180,
        reconcileStaleFollowerSyncSeconds: 180,
        reconcileGuardrailFailureCycleThreshold: 5,
        leaderTradesPollIntervalSeconds: 30,
        leaderTradesTakerOnly: false,
        executionEngineEnabled: true,
        panicMode: false
      }
    }),
    false
  )

  assert.equal(
    resolveEffectiveChainTriggerEnabled({
      tradeDetectionEnabled: true,
      userChannelWsEnabled: true,
      reconcileIntervalSeconds: 60,
      runtimeOps: {
        chainTriggerWsEnabled: false,
        fillReconcileEnabled: true,
        fillReconcileIntervalSeconds: 30,
        fillParseStarvationWindowSeconds: 300,
        fillParseStarvationMinMessages: 20,
        targetNettingEnabled: true,
        targetNettingIntervalMs: 5000,
        targetNettingTrackingErrorBps: 0,
        reconcileEngineEnabled: true,
        reconcileStaleLeaderSyncSeconds: 180,
        reconcileStaleFollowerSyncSeconds: 180,
        reconcileGuardrailFailureCycleThreshold: 5,
        leaderTradesPollIntervalSeconds: 30,
        leaderTradesTakerOnly: false,
        executionEngineEnabled: true,
        panicMode: false
      }
    }),
    false
  )
})
