## Dynamic DB-Driven Runtime Controls (Global, No Restart)

### Summary
Implement true runtime DB-driven behavior for:
1. `masterSwitches.tradeDetectionEnabled`
2. `masterSwitches.userChannelWsEnabled`
3. `reconcile.intervalSeconds` (applies to both reconcile loop and leader positions poll loop)

These become globally authoritative from DB at runtime, with env values used only as fallback baselines.

### Scope
1. In scope: worker runtime application of the 3 fields above without worker restart.
2. In scope: global semantics across all profiles (not profile-dependent at runtime).
3. In scope: config API read/write alignment so Config page remains source of truth.
4. Out of scope: changing existing profile-scoped guardrail/sizing behavior already implemented.
5. Out of scope: introducing dynamic runtime behavior for unrelated worker toggles (e.g., fill reconcile, target netting, execution enable).

### Locked Decisions
1. Global source of truth uses a new DB singleton table (`GlobalRuntimeConfig`).
2. `reconcile.intervalSeconds` dynamically controls both:
   1. reconcile engine cycle interval
   2. leader positions polling interval
3. `tradeDetectionEnabled` gates chain trigger ingestion together with env `CHAIN_TRIGGER_WS_ENABLED`:
   1. effective chain trigger enabled = `CHAIN_TRIGGER_WS_ENABLED && db.tradeDetectionEnabled`
4. `userChannelWsEnabled` directly controls user-channel WS runtime enable/disable.
5. On DB read failure, worker keeps last applied runtime config and does not flap to env.

### Data Model Changes
1. Add Prisma model in [schema.prisma](/home/vicente/code/polymarket-copier/packages/db/prisma/schema.prisma):
   1. `GlobalRuntimeConfig`
   2. fields: `id` (singleton key, e.g. `"global"`), `config` (JSON), `createdAt`, `updatedAt`
2. Add migration under `/packages/db/prisma/migrations/...`.
3. Backfill behavior:
   1. if row missing, seed from current effective Config-page values (resolved from existing config route logic)
   2. one-time seed script, idempotent

### Web/API Changes
1. Keep existing Config page contract unchanged (`/api/v1/config` still returns full system config).
2. Update [config route](/home/vicente/code/polymarket-copier/apps/web/app/api/v1/config/route.ts):
   1. `GET`: overlay global runtime fields from `GlobalRuntimeConfig` onto returned `config`
   2. `PATCH`: continue writing `copyProfile.config` and `defaultRatio` as today, plus upsert `GlobalRuntimeConfig` with the 3 runtime fields
3. Audit logging:
   1. keep existing `COPY_PROFILE` audit log
   2. add additional `GLOBAL` audit entry when global runtime fields change
4. Add small server helper in [config.ts](/home/vicente/code/polymarket-copier/apps/web/lib/server/config.ts) for parsing/merging `GlobalRuntimeConfig` JSON safely.

### Worker Runtime Architecture
1. Add worker-side parser/store for global runtime config:
   1. new module: `/apps/worker/src/config/global-runtime-config.ts`
   2. parse fields with strict validation and `undefined` fallback semantics
2. Add worker DB store read method (Prisma-backed) for singleton global runtime row.
3. Add runtime refresh loop in [index.ts](/home/vicente/code/polymarket-copier/apps/worker/src/index.ts):
   1. poll DB every `WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS` (new env, default `5000`)
   2. compute effective runtime values (DB override > env baseline)
   3. apply only on change (diff-based apply)
4. Runtime apply actions:
   1. chain trigger pipeline enable/disable based on effective trade detection
   2. fill attribution service enable/disable based on effective user-channel switch
   3. leader poller positions interval update
   4. reconcile engine interval update
5. Add idempotent dynamic reconfiguration methods:
   1. [leader/poller.ts](/home/vicente/code/polymarket-copier/apps/worker/src/leader/poller.ts): `setPositionsIntervalMs(ms)`
   2. [reconcile/engine.ts](/home/vicente/code/polymarket-copier/apps/worker/src/reconcile/engine.ts): `setIntervalMs(ms)`
   3. [chain/service.ts](/home/vicente/code/polymarket-copier/apps/worker/src/chain/service.ts): `setEnabled(enabled)`
   4. [fills/service.ts](/home/vicente/code/polymarket-copier/apps/worker/src/fills/service.ts): `setEnabled(enabled)`
6. Update service `status.enabled` to reflect current runtime enabled state, not only constructor state.
7. Keep existing startup env parsing as baseline fallback only.

### Env/Config Surface Changes
1. Add worker env key in [env.ts](/home/vicente/code/polymarket-copier/packages/shared/src/env.ts):
   1. `WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS` (positive int, default `5000`)
2. No frontend API shape changes required.

### Important Interface/Type Additions
1. New DB model `GlobalRuntimeConfig`.
2. Worker parser output type:
   1. `tradeDetectionEnabled?: boolean`
   2. `userChannelWsEnabled?: boolean`
   3. `reconcileIntervalSeconds?: number`
3. New runtime methods on service classes:
   1. `setEnabled(enabled: boolean): Promise<void> | void`
   2. `setPositionsIntervalMs(ms: number): void`
   3. `setIntervalMs(ms: number): void`

### Test Plan
1. Worker parser tests:
   1. valid values accepted
   2. invalid values ignored (`undefined` fallback)
2. Worker runtime controller tests:
   1. DB toggle `tradeDetectionEnabled` false stops chain ingestion runtime
   2. DB toggle true restarts chain ingestion runtime (if `CHAIN_TRIGGER_WS_ENABLED=true`)
   3. DB toggle `userChannelWsEnabled` false stops user channel WS
   4. DB toggle true restarts user channel WS
   5. DB change `reconcile.intervalSeconds` updates both leader positions and reconcile cadence
   6. DB fetch failure keeps last applied config and does not reset
3. Service-level tests:
   1. `setEnabled` idempotency for chain/fill services (no duplicate timers/sockets)
   2. interval reconfiguration for leader/reconcile does not create duplicate intervals
4. Web/API tests:
   1. `/api/v1/config` GET returns global runtime overlay values
   2. PATCH writes global runtime row and emits `GLOBAL` audit log entry
   3. backward compatibility: when global row missing, response still resolves from fallback and remains contract-valid

### Acceptance Criteria
1. Changing Config-page values for the 3 fields changes worker behavior within refresh cadence, without restart.
2. Runtime values are global and independent of copy-profile selection.
3. Env values are fallback only when DB value is absent/invalid.
4. Health/status reflects current applied runtime values accurately.
5. No regressions to existing profile-scoped execution/target guardrail behavior.

### Rollout and Safety
1. Deploy migration first.
2. Run one-time seed for `GlobalRuntimeConfig`.
3. Deploy web + worker code.
4. Verify via canary:
   1. flip `tradeDetectionEnabled` and confirm chain trigger status toggles live
   2. flip `userChannelWsEnabled` and confirm user-channel connection toggles live
   3. change `reconcile.intervalSeconds` and confirm both loop cadences update
5. Keep temporary info logs for runtime config diffs during first production rollout.

### Assumptions and Defaults
1. Singleton global row key is `"global"`.
2. Refresh cadence default is 5 seconds.
3. `reconcile.intervalSeconds` remains a positive integer.
4. Existing `copySystemEnabled` behavior remains as currently implemented (profile-aware execution gate), unchanged by this plan.
