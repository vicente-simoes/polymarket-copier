import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readGlobalRuntimeConfigOverrides,
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
    }
  })

  assert.deepEqual(parsed, {
    tradeDetectionEnabled: false,
    userChannelWsEnabled: true,
    reconcileIntervalSeconds: 45
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
    }
  })

  assert.deepEqual(parsed, {
    tradeDetectionEnabled: undefined,
    userChannelWsEnabled: undefined,
    reconcileIntervalSeconds: undefined
  })
})

test('global runtime config resolver falls back to baseline for missing overrides', () => {
  const resolved = resolveEffectiveGlobalRuntimeConfig(
    {
      tradeDetectionEnabled: true,
      userChannelWsEnabled: false,
      reconcileIntervalSeconds: 60
    },
    {
      userChannelWsEnabled: true
    }
  )

  assert.deepEqual(resolved, {
    tradeDetectionEnabled: true,
    userChannelWsEnabled: true,
    reconcileIntervalSeconds: 60
  })
})
