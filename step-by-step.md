# PolymarketSpy Build Plan (Step by Step)

This file is the execution plan for building the system described in `spec.md` into a production-ready, self-hosted copy-portfolio bot with dashboard.

It is ordered so each stage unlocks the next stage and avoids rework.

## Ground Rules

- Build for `v0.1` first: one follower account, 1-3 leaders, single droplet deployment.
- Prefer simple, auditable paths over clever paths.
- Every stage ends with explicit acceptance checks before moving forward.
- Keep all risky defaults conservative; require explicit opt-in for live execution.
- Keep an append-only audit trail for trade decisions, attempts, fills, skips, and errors.

## Stage 0 - Confirm Scope and Defaults

Goal: freeze all defaults that impact behavior, schema, and UI.

Tasks:
- Confirm/default values from spec:
  - `reconcile_interval_seconds = 60`
  - `min_notional_per_order = 1.00`
  - `max_worsening_buy = $0.03`
  - `max_worsening_sell = $0.06`
  - `max_slippage_bps = 200`
  - `max_spread = $0.03`
  - `attempt_expiration = 2h`
  - `cooldown_per_market_seconds = 5`
  - retry policy: exponential backoff until expiration
  - `max_exposure_per_leader_usd = 100`
  - `max_exposure_per_market_outcome_usd = 50`
  - `max_daily_notional_turnover_usd = 100`
  - `max_retries_per_attempt = 20`
- Define startup mode defaults:
  - copy execution `OFF` by default
  - detection pipeline `ON`
  - user-channel WS `ON`
- Define naming and package boundaries for `web`, `worker`, and shared libs.

Acceptance:
- A committed `config/defaults` source exists and all defaults are referenced from code, not hardcoded inline.

## Stage 1 - Repository and Runtime Bootstrap

Goal: stand up a clean monorepo foundation for web + worker + shared packages.

Tasks:
- Create repository layout:
  - `apps/web` (Next.js dashboard)
  - `apps/worker` (copy engine)
  - `packages/shared` (types, math, validation, constants)
  - `packages/db` (Prisma schema/client + migrations)
  - `docker` (all Docker-related files: Compose, Dockerfiles, nginx proxy config)
- Integrate `template/finbro-dashboard` into `apps/web` as the base UI shell.
- Configure workspace tooling:
  - `pnpm` workspaces
  - shared TypeScript configs
  - lint + format + test commands
- Add `.env.example` with all required variables:
  - Polymarket auth/API values
  - Alchemy WS URL
  - Postgres/Redis URLs
  - geoblock settings
  - kill switch and boot modes

Acceptance:
- `pnpm install` and workspace `typecheck` succeed.
- Web app boots locally.
- Worker process can start with config validation (even if it does nothing yet).

## Stage 2 - Local Infra via Docker Compose

Goal: one command to run the full stack in dev/prod-like mode.

Tasks:
- Create `docker/docker-compose.yml` services:
  - `nginx`, `web`, `worker`, `postgres`, `redis`
- Add health checks and restart policies for all long-running services.
- Configure named volumes for Postgres (and optional Redis persistence).
- Add one-shot migration service/container.
- Add internal service network and env wiring.
- Add `docker/nginx` config for:
  - `/` -> web
  - `/api/*` -> web/api routes (or dedicated api service if split later)

Acceptance:
- `docker compose -f docker/docker-compose.yml up` starts all services healthy.
- Health endpoints report `OK`.
- Migrations run automatically before worker loops.

## Stage 3 - Data Model and Migrations

Goal: implement the durable data model required by the spec.

Tasks:
- Create tables/models for:
  - `leader`
  - `leader_wallet`
  - `copy_profile`
  - `copy_profile_leader`
  - `leader_trade_event` (raw detected trades with source + timing)
  - `leader_position_snapshot`
  - `follower_position_snapshot`
  - `pending_delta` (accumulator state)
  - `copy_attempt` (lifecycle of intended copy action)
  - `copy_order` (order attempt + weights/idempotency)
  - `copy_fill`
  - `copy_fill_allocation`
  - `leader_token_ledger`
  - `leader_pnl_summary`
  - `portfolio_snapshot` + rollups
  - `system_status` / `heartbeat` / `error_event`
  - `config_audit_log`
- Add indexes for hot query paths:
  - by `leader_id + timestamp`
  - by `token_id + timestamp`
  - by `status + created_at`
  - by `trade_id`/`order_id` unique constraints
- Store JSON fields where justified:
  - `leader_weights` on `copy_order`
  - structured error payloads
- Add migration and seed scripts.

Acceptance:
- Prisma client generates successfully.
- Migrations apply cleanly on empty DB.
- Core read/write paths are covered by basic integration tests.

## Stage 4 - Shared Domain Layer

Goal: centralize business rules and deterministic math.

Tasks:
- Build shared modules for:
  - money + decimal math (no float drift)
  - tick rounding helpers:
    - BUY caps rounded down
    - SELL floors rounded up
  - notional/share conversion
  - guardrail evaluation
  - attribution weight calculation
  - average-cost PnL updates
- Add zod schema validation for all external payloads and env.
- Add deterministic idempotency key builder:
  - for triggers (`txHash:logIndex`)
  - for copy decisions
  - for order retries

Acceptance:
- Unit tests cover all math and rounding rules from section `4.5` of `spec.md`.

## Stage 5 - Market Metadata and Price Cache

Goal: fast, bounded access to tick size, min order size, and best prices.

Tasks:
- Implement market cache service in worker:
  - REST `/book` + `/books` fetchers
  - in-memory + Redis caching of `tick_size`, `min_order_size`, `neg_risk`
  - stale markers with TTL
- Implement market WS client:
  - subscribe/unsubscribe by watched token set
  - maintain best bid/ask
  - process `tick_size_change`
  - record connectivity + message timestamps
- Implement fallback rules:
  - prefer WS best bid/ask
  - fallback to REST top-of-book
  - block execution if data is stale

Acceptance:
- Worker can query fresh book state for watched tokens with one call.
- Status metrics show WS health + freshness.

## Stage 6 - Leader Ingestion (Authoritative Polling)

Goal: authoritative ground truth via Data API for positions/trades.

Tasks:
- Implement leader polling jobs:
  - positions poll (reconcile cadence)
  - trades poll (backfill cadence)
- Resolve and refresh leader trade wallets (`proxyWallet` etc.).
- Persist snapshots and trade events with source `DATA_API`.
- Implement pagination/cursoring and rate-limit aware batching.
- Track poll lags, last success timestamps, and failures.

Acceptance:
- For each leader, positions and recent trades are persisted repeatedly without gaps.
- Worker recovers from API throttling using backoff.

## Stage 7 - On-Chain Trigger Pipeline (Alchemy WS)

Goal: low-latency "something changed" signals with decode + dedupe + reorg handling.

Tasks:
- Implement Alchemy WS subscriptions for exchange contracts + topics:
  - `OrderFilled`
  - `OrdersMatched`
- Filter by leader trade wallet topics.
- Decode logs via ABI and map to internal trigger object.
- Derive side semantics:
  - `makerAssetId == 0` => BUY
  - `takerAssetId == 0` => SELL
- Deduplicate with Redis `SETNX` on `txHash:logIndex`.
- Handle `removed: true` reorg signals:
  - mark rollback
  - enqueue immediate reconcile for affected leader/token
- Persist trigger events with source `CHAIN` and timing:
  - `leader_fill_at_ms`
  - `ws_received_at_ms`
  - `detected_at_ms`

Acceptance:
- Duplicate logs do not create duplicate downstream actions.
- Reorg rollback creates reconcile tasks.
- Trigger lag metrics render correctly.

## Stage 8 - Target Portfolio + Netting Engine

Goal: convert leader state into follower target deltas and accumulate executable intent.

Tasks:
- Compute per-leader target notional:
  - `leader current value * ratio`
- Convert to target shares via price snapshot preference:
  - `curPrice` from positions
  - else cached mid
  - else REST top-of-book
- Combine leaders into net target per token.
- Compare with follower current shares to get `delta_shares`.
- Maintain per-token accumulator:
  - `pending_delta_shares`
  - `pending_delta_notional_est`
- Apply execution thresholds:
  - min notional
  - min order size
  - tracking-error thresholds
- Create/update `copy_attempt` lifecycle entries.

Acceptance:
- Small deltas accumulate and eventually trigger eligible attempts once thresholds are crossed.

## Stage 9 - Execution Engine and Risk Guards

Goal: place correct orders with strong safety checks and retry behavior.

Tasks:
- Build order planner for `FAK` default behavior:
  - BUY uses dollar spend amount
  - SELL uses shares amount
- Compute caps/floors and slippage checks per spec.
- Perform thin-book VWAP depth check before placing.
- Respect `tick_size`, `min_order_size`, and `neg_risk`.
- Integrate CLOB create/sign/submit flow.
- Implement idempotent order placement and retry states:
  - `PLACED`, `PARTIALLY_FILLED`, `FILLED`, `FAILED`, `RETRYING`, `CANCELLED`
- Enforce global controls:
  - copy enabled switch
  - leader pause
  - spend caps (hour/day)
  - cooldown per market

Acceptance:
- Engine places valid orders for both BUY and SELL paths.
- Failed attempts retry with backoff until expiration.
- Guardrail failures stay pending instead of silently dropping.

## Stage 10 - Follower Fill Confirmation and Attribution

Goal: tie actual fills to leaders and compute exact leader-level PnL.

Tasks:
- Subscribe to authenticated user-channel WS.
- Ingest order/trade fill updates and reconcile with placed orders.
- Persist `copy_fill` and `copy_fill_allocation` records.
- At order creation, compute and store `leader_weights` for the token.
- Allocate fill amounts by stored weights.
- Update `leader_token_ledger` and `leader_pnl_summary`:
  - average-cost accounting for sells
  - fee-aware realized PnL
- Route residuals/rounding to `UNATTRIBUTED`.

Acceptance:
- Sum of leader allocations equals actual fill totals (minus explicit unattributed residual).
- "PnL by leader" is reproducible from stored allocations.

## Stage 11 - Reconcile Loop and State Integrity

Goal: deterministic convergence to target and bounded drift.

Tasks:
- Implement authoritative reconcile scheduler (default 60s).
- Per cycle:
  - fetch leader positions
  - recompute targets
  - fetch follower positions
  - compute deltas
  - enqueue/update attempts
- Implement stuck-state detectors:
  - stale prices
  - stale leader sync
  - stale follower sync
  - repeated guard failures
- Add integrity checks:
  - no double execution for same decision key
  - snapshot reconciliation audit records

Acceptance:
- Tracking error trends down after reconcile cycles in non-pathological markets.

## Stage 12 - API Layer (Backend for Dashboard)

Goal: stable, bounded endpoints for all dashboard pages.

Tasks:
- Keep API in Next.js route handlers within `apps/web` for v0.1 (no separate API service).
- Create API modules/endpoints:
  - Overview aggregates
  - Leaders list/detail + CRUD
  - Portfolio summary/time-series/exposure
  - Trades log with filters + pagination
  - Copies views (pending/executions/skipped grouped)
  - Config read/update + audit log (including exposure caps, turnover cap, and max retries)
  - Status/health diagnostics
- Ensure each page uses a single endpoint or small fixed endpoint set.
- Build pagination defaults (`50/page`) and filter semantics from spec.
- Add caching for heavy aggregate endpoints.
- Add response schemas and versioned contracts.

Acceptance:
- All page data can be fetched without N x M query explosions.
- API contracts match UI requirements exactly.

## Stage 13 - Dashboard Implementation

Goal: complete control + observability UI using the provided template base.

Tasks:
- Implement layout/navigation + shared widgets:
  - timestamp badges
  - status pills
  - empty/error/loading states
  - mobile-safe table/card switchers
- Build pages:
  - Overview
  - Leaders
  - Leader detail
  - Portfolio + position detail
  - Trades
  - Copies
  - Config
  - Status
- Implement chart ranges and bounded point counts:
  - `1h`, `24h`, `1w`, `1m`
- Ensure mobile portrait UX:
  - stacked cards
  - collapsible details
  - sticky key columns where tables remain

Acceptance:
- Every page in section 8 of `spec.md` is implemented with required fields and interactions.
- Mobile view is readable and actionable for all pages.

## Stage 14 - Observability, Ops, and Safety

Goal: make runtime behavior explainable and recoverable.

Tasks:
- Structured logs across worker + web.
- Metrics and counters:
  - trigger lag, detect lag (WS receive timestamps may be retained for diagnostics/audit but are not required as a primary UI metric)
  - order attempt outcomes
  - skip reasons
  - reconciliation duration/errors
  - fallback usage
- Health endpoints for all services.
- Kill switch paths:
  - dashboard toggle
  - env panic mode
- Error triage UX on Status page:
  - last error
  - error counts by window
  - retry/backoff state

Acceptance:
- Operators can answer "what happened and why?" for any trade/copy attempt quickly.

## Stage 15 - Testing Strategy and Gates

Goal: prevent behavioral regressions in core trading logic.

Tasks:
- Unit tests:
  - rounding, sizing, slippage/guardrails
  - attribution and PnL accounting
- Integration tests:
  - Data API ingestion
  - Alchemy trigger decode/dedupe/reorg paths
  - order lifecycle transitions
  - reconcile loop end-to-end on mocked services
- UI tests:
  - API contract rendering
  - pagination/filter behaviors
  - mobile layout checks
- Dry-run mode:
  - execution disabled but full decision pipeline active
  - audit outputs still persisted

Acceptance:
- Green CI for lint, typecheck, tests.
- Dry-run replay of historical scenarios shows deterministic outcomes.

## Stage 16 - Production Deployment and Rollout

Goal: deploy safely on a single droplet and go live gradually.

Tasks:
- Provision droplet and domain.
- Configure TLS + Nginx routing.
- Deploy compose stack with secrets.
- Run migrations and first-time bootstrap checks:
  - geoblock eligibility
  - API auth validity
  - WS connectivity
- Rollout plan:
  - Phase A: observe-only (copy OFF)
  - Phase B: tiny ratio live (e.g., 0.01)
  - Phase C: normal configured ratio
- Add backup strategy:
  - Postgres periodic backups
  - restore procedure validation

Acceptance:
- System runs continuously with healthy status signals.
- First live copies execute and settle without manual intervention.

## Stage 17 - Post-Launch Hardening

Goal: stabilize operations and prepare for v0.2 improvements.

Tasks:
- Review top failure modes from first live week.
- Tune defaults using real latency/liquidity data.
- Add per-leader override UX refinements.
- Improve long-range snapshot rollups for faster portfolio charts.
- Extend runbooks for incident classes:
  - API throttling spikes
  - WS disconnect storms
  - stale book data
  - reconcile drift anomalies

Acceptance:
- Error rates and skipped-attempt rates trend down while tracking quality remains stable.

## Cross-Cutting Build Order Constraints

- Do not start dashboard feature pages before Stage 12 contracts exist.
- Do not enable live execution before:
  - Stage 9 guardrails
  - Stage 10 fill attribution
  - Stage 14 kill switch + status diagnostics
- Keep schema migrations ahead of worker feature merges.
- Ship each stage behind feature flags where risk is high.

## Definition of "Fully Working System" for This Project

The system is considered fully working when all statements are true:

- It continuously ingests leader activity (on-chain WS + REST fallback).
- It reconciles against authoritative leader positions on cadence.
- It computes net token deltas and executes eligible follower orders with guards.
- It records complete audit history for triggers, attempts, orders, fills, skips, and errors.
- It provides exact fill-based leader attribution and PnL-by-leader.
- Dashboard pages are complete per `spec.md` and mobile-usable.
- Operator controls (kill switch, pause/resume, guardrails, ratios) work in real time.
- Compose deployment is reproducible and health-checked.

## Open Items to Confirm Before Live Trading

- None currently.
