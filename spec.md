# Polymarket Copy-Portfolio Bot — spec.md (v0.3)
> **Status:** Draft focused on *idea + stack + architecture decisions*.
>
> **Goal of this doc:** Be the single source of truth for what we’re building, why it exists, and how it works end-to-end.
>
> **Next milestones (not fully specified yet):**
> - Detailed repo / project structure (packages, modules, naming, scripts)
> - Detailed data model (tables, indexes, migrations)
> - Detailed execution logic (order building, rounding, slippage, retries, idempotency)
> - Deployment guide (Docker, Nginx, TLS, secrets, monitoring)
> - Test plan and rollout plan

---

## 1) Product idea

Build a self-hosted service that **mirrors** one or more target Polymarket users (“leaders”) into one of my Polymarket accounts (“follower”) at a configurable **ratio** (e.g., 0.05×), so my final holdings approximate the leaders’ portfolios while using a much smaller bankroll.

This is **not** “copy every trade exactly.” It’s **portfolio mirroring**:
- Leader makes trades over time (maybe many small ones).
- The system maintains a running **target portfolio** by scaling the leader’s **current notional exposure** per token by `ratio`, then converting into follower **target shares** using a recent price snapshot.
- The system rebalances my positions toward that target under practical constraints (minimum order size, $1 minimum notional, tick size, available liquidity, rate limits).

### 1.1 Why portfolio mirroring (not trade replay)

Trade replay breaks down at small bankrolls because:
- Many leader actions become < $1 when scaled → cannot execute → portfolio drift.
- Fill mismatch compounds; you won’t get identical prices/partials.
- Some leaders’ behavior is path-dependent (scalps, inventory management).

Portfolio mirroring is robust because it:
- **Nets** many small leader actions into fewer executable follower trades.
- **Reconciles** periodically to converge on target even if you missed events.
- Allows explicit risk controls (caps, thresholds, market allow/deny lists).

---

## 2) Definitions and core concepts

### 2.1 Entities
- **Leader**: a public Polymarket user address whose positions we observe.
- **Follower**: my Polymarket trading account (authenticated), where we place orders.
- **Copy profile**: configuration that links 1 follower to N leaders with a ratio and rules.
- **Ratio**: scalar in (0, 1], e.g. 0.05 means mirror 5% of a leader’s **current notional exposure** (USDC value).
- **Position**: holdings for a market outcome token (YES/NO token).
- **Target notional**: desired follower USDC exposure for a token = `leader_current_value × ratio`.
- **Target shares**: desired follower share count for a token = `target_notional / price_snapshot`, rounded to obey exchange constraints.
- **Tracking error**: difference between follower’s current positions and target positions.

### 2.2 Hard constraints (current assumptions)
- **Bankroll**: ~$50–$100 total.
- **Minimum notional per executed order**: $1 (practical constraint to ensure orders are accepted / meaningful).
- **Exchange rules per token**: `min_order_size` and `tick_size` (market-specific).
- **Network/detection latency**: ~500ms (trade detection) + ~1s (market info lookup) in prior paper-trading prototype.
- **Low-latency mode**: when market data is cached and leader events arrive via Alchemy WS, execution can avoid repeated REST lookups.

### 2.3 What “good” looks like
- Over time, follower portfolio converges to leader portfolio **notional exposure** × ratio,
  with bounded tracking error due to min sizes, liquidity, and slippage caps.
- Follower does not spam the API, does not double-submit orders, and fails safely.

---

## 3) Data sources and APIs (high-level)

### 3.1 Public data for leaders
We cannot rely on the authenticated CLOB *user* websocket to track other people; it only streams the authenticated user’s activity.

Leader observation therefore uses **public sources**, with a clear separation between **fast signals** and **authoritative state**:

1) **Fast leader trade signals (preferred): Alchemy-backed on-chain WebSocket**
- Use Alchemy WebSocket subscriptions to detect relevant on-chain events involving leader addresses (e.g., fills/settlements/transfers related to Polymarket activity).
- These events act as low-latency “something changed” triggers.
- After receiving a trigger, we **enrich** it using the Data API and/or CLOB endpoints to resolve:
  - market / token IDs,
  - side (buy/sell),
  - size and price,
  - and to update the internal target portfolio state.

2) **Authoritative leader state: Data API polling**
- We **always** fetch leader **positions** on a fixed cadence as ground truth for reconciliation and drift control (even if WS is healthy).
- We also poll leader **trades** (or “activity”) at a lower cadence to:
  - backfill anything the WS trigger missed,
  - maintain a “last leader trade price” baseline for guardrails,
  - and provide an additional fallback if WS is down.

Primary leader inputs:
- **Leader current positions**: `GET https://data-api.polymarket.com/positions`
- **Leader trades** (polling + fallback): `GET https://data-api.polymarket.com/trades` (filtered by user)

#### 3.1.1 On-chain trigger decoder (Alchemy / Polygon)

**Goal:** use an on-chain event feed as an ultra-low-latency “something changed” trigger *and* (when possible) decode enough to know exactly what to copy **without** any network fetch on the hot path.

**Canonical trigger events (Polygon PoS):**
- **OrderFilled** (single fill) — emitted by Polymarket exchange contracts.
- **OrdersMatched** (taker order matched with a maker order) — also emitted by the exchange.

**Exchange contracts to watch (Polygon):**
- `CTFExchange`: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- `NegRiskCtfExchange`: `0xC5d563A36AE78145C45a50134d48A1215220f80a`

> These addresses should be treated as configuration (env vars) and verified periodically (docs / explorer), but they are stable in practice.

**Event signatures / topic0 (keccak256 of the event signature string):**
- `OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)`  
  `topic0 = 0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6`
- `OrdersMatched(bytes32,address,uint256,uint256,uint256,uint256)`  
  `topic0 = 0x63bf4d16b764241a0e07a43d477a39e134f0c093e0ab12f30a66bc2633c1a9e0`

**Indexed topic positions (important for server-side filtering):**
- `OrderFilled`:  
  `topics[0]=topic0`, `topics[1]=orderHash`, `topics[2]=maker`, `topics[3]=taker`
- `OrdersMatched`:  
  `topics[0]=topic0`, `topics[1]=takerOrderHash`, `topics[2]=takerOrderMaker`

**Leader-side filtering (how we identify leaders on-chain):**
We want Alchemy to only send us logs that *could* be fills for our leaders.
- Each leader is created with:
  - a **display name** (user-provided)
  - a **profile address** (the address in their Polymarket profile URL, e.g. `https://polymarket.com/<address>`)
- We also maintain a derived set of **leader trade addresses** (typically the `proxyWallet` seen in Data API responses, plus any other observed trading wallets).
- The **Leader Address Set** used for on-chain log filtering is the union of these **trade addresses** (not usernames). We populate/refresh it by:
  - fetching recent leader trades/positions via the Data API,
  - storing the observed `proxyWallet` (and any other observed wallets),
  - periodically re-validating and updating the mapping if it changes.

Create log subscriptions that filter on:
- `address`: exchange contract address
- `topics[0]`: one of the fill/match event signatures above
- **and** the correct indexed address topic position containing a leader trade address.

Because `topics` filtering is positional, you generally need separate subscriptions for:
- **Leader-as-maker** fills (recommended default; maker is always a user in Polymarket’s definition).
- **Leader-as-taker** fills (optional; taker can be a user *or* the exchange contract for multi-match situations).

**Topic encoding rule (addresses):**
When filtering by an indexed address topic, the topic value is the 20-byte address left-padded to 32 bytes:
`0x000000000000000000000000<40-hex-address-without-0x>`

**Example subscriptions (JSON-RPC over WebSocket):**

1) Leader-as-maker on `OrderFilled`:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_subscribe",
  "params": [
    "logs",
    {
      "address": "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
      "topics": [
        "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6",
        null,
        [
          "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ],
        null
      ]
    }
  ]
}
```

2) Leader-as-maker on `OrdersMatched`:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "eth_subscribe",
  "params": [
    "logs",
    {
      "address": "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
      "topics": [
        "0x63bf4d16b764241a0e07a43d477a39e134f0c093e0ab12f30a66bc2633c1a9e0",
        null,
        [
          "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ]
      ]
    }
  ]
}
```

**Decoder (turn a log into a “copyable trade delta”):**
- Use `ethers` or `viem` ABI decoding locally:
  - Match `topics[0]` to pick the event
  - Decode `data` into the non-indexed params
- Minimal ABI strings you need:
```ts
[
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
  "event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled)"
]
```

**Trade direction (Polymarket semantics):**
- If `makerAssetId == 0` → **BUY** (maker gives USDC, receives outcome tokens).
- If `takerAssetId == 0` → **SELL** (maker gives outcome tokens, receives USDC).

**Internal hot-path output object (what the copy engine consumes immediately):**
```json
{
  "triggerId": "<txHash>:<logIndex>",
  "chain": "polygon",
  "event": "OrderFilled|OrdersMatched",
  "exchangeContract": "0x…",
  "leader": {
    "proxyWallet": "0x…",
    "role": "maker|taker"
  },
  "asset": {
    "tokenId": "<nonZeroAssetId>",
    "usdcSide": "maker|taker"
  },
  "fill": {
    "side": "BUY|SELL",
    "tokenAmountBaseUnits": "<string-int>",
    "usdcAmountBaseUnits": "<string-int>",
    "feeBaseUnits": "<string-int or 0>",
    "price": "<derived float string>"
  },
  "block": {
    "number": "<hex-or-int>",
    "hash": "0x…"
  },
  "tx": {
    "hash": "0x…"
  }
}
```

**Idempotency + reorg handling:**
- Deduplicate triggers by `txHash + logIndex` in Redis (SETNX + TTL).
- Persist **one canonical trade row** per leader trade across all ingestion sources.
  - Canonical identity is a normalized fingerprint key (wallet + token + side + size + price + fill-second), not source-specific IDs.
  - If both WS and REST observe the same trade, **the first source to arrive creates the row**.
  - Later observations from the other source must enrich metadata on that same row (audit fields), never create a second row.
- Handle chain reorgs: logs may be re-emitted with `removed: true` (treat as rollback signal).
  - If a trigger is rolled back, locate the existing trade row by `triggerId`, then `(txHash, logIndex)`, then canonical key if needed; enqueue an **immediate reconcile** for that leader & tokenId.

**Why this matters for speed:**
This keeps the hot path to: WS receive → local decode → enqueue copy decision → (optional) order placement, without waiting on any market-data fetch. Market/portfolio enrichment happens after.

### 3.2 Market metadata and pricing
We need market parameters and current pricing to:
- translate “target position deltas” into an executable order,
- enforce tick size and minimum order size,
- estimate notional and slippage.

Sources:
- **Order book summary** (REST): includes `min_order_size` and `tick_size`
  - `GET https://clob.polymarket.com/book?token_id=...`
  - Batch: `POST https://clob.polymarket.com/books`
- **Market WebSocket channel**: subscribe to market updates for tokens we care about
  - Keep best bid/ask in memory
  - Track `tick_size_change` events so rounding doesn’t cause rejects

### 3.3 Trading (follower execution)
Follower order placement uses the **CLOB API** with an explicit **L1 + L2** auth split:
- **L1 (wallet private key)** signs orders (EIP-712 signed order payloads)
- **L2 (API key / secret / passphrase)** authenticates CLOB requests and the user-channel websocket

For proxy/safe account setups, order creation must also use the correct SDK signing mode (`signatureType`) and, when required, the corresponding `funderAddress`.

Supported order types (per docs):
- **FAK** (Fill-And-Kill) — market-style execution; fills available liquidity immediately, cancels remainder (partial fill OK).
- **FOK** (Fill-Or-Kill) — market-style execution; must fill immediately and fully, otherwise cancels.
- **GTC** (Good-Til-Cancelled) — limit order resting on the book until filled or cancelled.
- **GTD** (Good-Til-Date) — limit order resting on the book until an expiration time.

Execution mode for v0.1:
- Primary: **FAK** for rebalancing (partial fills are acceptable).
- Optional (future): marketable limit orders and/or FOK when we need “all-or-nothing” rebalances.

Important behavioral details (must reflect in implementation):
- For **FAK/FOK**:
  - **BUY**: specify the **dollar amount** to spend.
  - **SELL**: specify the **number of shares** to sell.
- Negative risk markets: when `neg_risk=true` (from book summary / market metadata), order creation must set the SDK option `negRisk: true`.
- Current execution policy nuance:
  - For **FAK** in v0.1, we enforce **minimum notional** (`$1`) but do **not** hard-block on `min_order_size` during planning.
  - `min_order_size` remains useful metadata for diagnostics and for non-FAK policies.

### 3.4 Rate limits / throttling
All endpoints are rate-limited and throttled (not always hard rejected), so we need:
- batching,
- caching,
- and concurrency limits.

---

## 4) Copy engine strategy (idea-level)

### 4.1 High-level loop: “fast target update” + “slow reconcile”
We combine two mechanisms:

1) **Fast target updates** (event-ish)
- Primary: consume on-chain WS triggers (OrderFilled/OrdersMatched) and immediately update the leader’s “recent activity” and per-token baseline prices.
- Always-on backfill: poll leader trades/activity at a modest cadence to catch anything WS missed and to keep baseline prices fresh.
- Do NOT attempt to execute every leader trade; fast updates mainly update the internal state and pending deltas.
- If on-chain WS is down, the trade polling path becomes the primary fast signal source.

2) **Periodic reconciliation** (authoritative)
- Every N seconds (default 60; configurable), fetch leader positions (authoritative truth).
- Recompute target positions.
- Fetch follower positions.
- Compute follower deltas and rebalance if above thresholds.

### 4.2 Netting/accumulation layer (to overcome $1 minimum)
Maintain per token:
- `pending_delta_shares` (signed)
- `pending_delta_notional_est` (signed, using cached best price)

Rule:
- If delta < $1 notional, accumulate it.
- When accumulated delta crosses execution threshold, place one order for the net delta.
- `pending_delta_*` is the authoritative source of executable size. Active attempts must re-read linked pending-delta size on every retry rather than relying on stale attempt snapshots.
- If a linked pending delta becomes `CONVERTED`, `EXPIRED`, missing, or net-zero, the attempt must transition to terminal expired/closed (no further submission retries).
- Reconcile/netting must include currently-open pending tokens in its token universe so orphan pending deltas are cleared even when a token temporarily disappears from both leader and follower latest snapshots.

This prevents “skip everything” behavior when the leader makes lots of small edits.

### 4.3 Rebalancing thresholds (to reduce churn)
With a small bankroll, we need to avoid death-by-a-thousand-cuts:
- Only trade if absolute notional delta >= $1–$3 (configurable)
- And/or relative tracking error >= 5–10% (configurable)
- Hard cap number of active markets mirrored (configurable)

### 4.4 Integrity & safety rules (idea-level)
- **Spend cap** per day and per hour
- **Max exposure** per market
- **Max number of open positions**
- **Allow/deny lists** by market category/event/slug (future)
- **Kill switch** from dashboard + env var “panic mode”
- **Idempotency**: never execute the same rebalance decision twice
- **Staleness guards**: don’t trade if price data is stale or book unavailable

### 4.5 Order building and rounding rules (v0.1, normative)

This section turns the docs-driven order-type behavior into concrete rules so the implementation is predictable.

**Step 1 — Compute deltas in shares**
- For each token, compute: `delta_shares = target_shares - follower_shares`.
- Convert to an estimated notional using current price context and enforce `min_notional_per_order` (default `$1`).
- If estimated notional is below threshold, keep accumulating via `pending_delta_shares` / `pending_delta_notional`.
- For **FAK** path in v0.1, do not block solely on `min_order_size`.
- On retries, execution must consume the latest linked `pending_delta_shares` / `pending_delta_notional` so updated leader/follower state (e.g., a leader reducing/selling) is reflected immediately in planned size.

**Step 1.5 — Compute leader attribution weights (for PnL-by-leader)**
- For the token we are about to trade, compute an attribution weight vector `w[leader]` using the same rule as in the Portfolio section (“Leader attribution + PnL by leader”).
- Persist a `copy_order` record **before posting** the order that includes:
  - the intended `delta_shares`,
  - the computed `w[leader]` map (and any `UNATTRIBUTED` remainder),
  - and a stable internal idempotency key for retries.
- When fills arrive (trade IDs from the user WS or REST), attribute each fill using the stored weights and write `copy_fill_allocation` rows; update the per-leader `leader_token_ledger`.

**Step 2 — Decide side and order type**
- Default execution order type: **FAK**.
- `delta_shares > 0` → BUY. `delta_shares < 0` → SELL.

**Step 3 — Compute baseline price for “max worsening”**
- Prefer the most recent leader fill price for this token and side (from WS trigger enrichment or trades polling).
- If we do not have a leader fill price yet, fallback to the leader snapshot `curPrice` from the positions poll.

**Step 4 — Compute price cap/floor (tick-rounded)**
- Let `mid = (best_bid + best_ask)/2` from the cached market channel (fallback to REST top-of-book).
- BUY price cap candidates:
  - `cap_worsening = leader_price + max_worsening_buy`
  - `cap_slippage = mid × (1 + max_slippage_bps/10000)`
  - `cap_user = max_price_per_share` (if set)
  - `price_cap = min(all candidates that are set)`
  - Round **down** to the nearest `tick_size`.
- SELL price floor candidates:
  - `floor_worsening = leader_price - max_worsening_sell` (optionally relaxed over time if “exit priority” is enabled)
  - `floor_slippage = mid × (1 - max_slippage_bps/10000)`
  - `price_floor = max(all candidates)`
  - Round **up** to the nearest `tick_size`.

**Step 5 — Convert shares deltas into the correct order sizing primitive**
- For **FAK/FOK**, Polymarket expects:
  - BUY: `amount` is **dollars to spend**.
  - SELL: `amount` is **shares to sell**.
- BUY sizing:
  - `ideal_spend = delta_shares × mid` (or a VWAP estimate if available)
  - `spend = max(ideal_spend, min_notional_per_order)`
  - Block/retry if `spend` exceeds available USDC after reserves/caps.
- SELL sizing:
  - `shares_to_sell = abs(delta_shares)`

**Step 6 — Depth/thin-book check (not heavy)**
- Use a small-depth book fetch (or cached depth if fresh) to estimate the VWAP for the intended spend/shares.
- Ensure the estimated VWAP is within the computed cap/floor; otherwise keep the attempt pending and retry with backoff.

**Step 7 — Place the order using the SDK create order flow**
- Prefer the SDK’s “create + sign + submit” helpers (e.g. `createAndPostMarketOrder` / `createAndPostOrder`) with the correct `tickSize` and `negRisk` flags.
- Initialize the SDK with both:
  - the follower **private key signer** (L1 order signing / EIP-712), and
  - the follower **CLOB API credentials** (L2 authenticated requests)
- Always pass the resolved `tickSize` and `negRisk` options from market metadata.

---

## 5) System architecture (idea-level)

### 5.1 Components (services)

1) **Web dashboard**
- Next.js app
- GitHub-authenticated admin UI (OAuth login + username allowlist) for configuring copy profiles and monitoring status
- The dashboard is the base of operations: configure leaders/ratios/guardrails, monitor health, and control kill switches.

2) **API layer**
Options:
- A minimal API inside Next.js (route handlers) for CRUD on configs and status
- Or a separate lightweight Node/TS API service (future if the UI grows)

3) **Copy worker**
- Long-running TypeScript service (Node)
- Responsible for:
  - polling Data API for leader positions/trades,
  - maintaining cached market metadata/prices,
  - computing target portfolios,
  - placing follower orders,
  - writing state to Postgres and Redis.

4) **PostgreSQL**
- Durable store for configuration, audit logs, historical snapshots, and reconciliation results.

5) **Redis**
- Fast ephemeral state + coordination:
  - in-memory price cache snapshots (optional)
  - distributed locks (avoid double-running the worker)
  - rate-limit counters
  - job queue for “rebalance tasks” (optional for v1)

6) **Nginx reverse proxy**
- Terminates TLS
- Routes:
  - `https://<domain>/` → Next.js
  - `/api/*` → API routes
  - Optional: restrict admin endpoints by IP/basic auth

7) **DigitalOcean droplet**
- Single-machine deployment for v1
- Docker Compose orchestration

8) **Alchemy (external infrastructure dependency)**
- Provides a reliable **WebSocket endpoint** for low-latency on-chain event streaming.
- Used to detect leader activity quickly (trade/position-changing events), triggering enrichment and rebalance logic.
- Must be treated as a signal source: duplicates and chain reorgs are possible → dedupe + confirmation rules required.

### 5.2 Data flow (conceptual)

Leaders (public) → Data API polling → worker updates target → netting layer → pricing cache + order constraints → execute orders → record audit state → dashboard shows status.

Pricing path:
- Market WS (best bid/ask) and/or REST `/book(s)` (tick/min size) → in-memory cache → used by rebalance decisions.

### 5.3 Key design decisions (v1)
- **Position mirroring** as the primary goal (not perfect trade replay).
- **Batch** wherever possible:
  - order book summaries via POST `/books`
  - leader positions in bulk queries when following multiple leaders
- **Cache** market metadata and keep pricing in memory using WebSocket.
- **Reconcile** on a fixed cadence to control drift.

---

## 6) Tech stack (v1)

### 6.1 Frontend
- **Next.js** (TypeScript)
- UI library: TBD (keep it simple initially)
- Auth: **GitHub OAuth (Auth.js / NextAuth) + username allowlist** for admin access to the dashboard (v1)

### 6.2 Backend / Worker
- **Node.js + TypeScript**
- HTTP client: fetch/undici
- WebSocket client for market channel
- Structured logging

### 6.3 Datastores
- **PostgreSQL**
  - configs
  - leader snapshot history
  - follower position history
  - audit events (rebalance decisions, orders placed, rejects)
- **Redis**
  - locks
  - job queue (optional)
  - high-churn caches (prices, pending deltas)

### 6.4 Infra
- **Docker Compose** (v1)
- **Nginx** reverse proxy
- **TLS** via Let’s Encrypt (certbot) or Caddy (alternative)
- Process management: Docker restarts + healthchecks
- All Docker-related assets live under the repo `docker/` directory.
- Web auth deployment requirement: configure GitHub OAuth env vars (`AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `AUTH_GITHUB_ALLOWED_USERS`) and a matching callback URL for the deployed dashboard origin.

#### 6.4.1 Docker Compose expectations
Docker Compose supports **two modes**:
- **Full stack mode**: run all services in Docker (local parity + production baseline).
- **Dev infra mode**: run only Postgres + Redis in Docker, while `web` and `worker` run from host via `pnpm dev`.

Repository layout requirement for Docker assets:
- `docker/docker-compose.yml` (primary compose file)
- `docker/docker-compose.dev-infra.yml` (dev infra compose file: postgres + redis only)
- `docker/Dockerfile` (shared app image build)
- `docker/nginx/default.conf` (reverse-proxy config)
- `docker/*.dockerignore` files for Docker build context filtering

Primary command form:
- `docker compose -f docker/docker-compose.yml up --build`
- `docker compose -f docker/docker-compose.dev-infra.yml up -d`

Full stack Compose defines at least these services:
- `nginx` (reverse proxy)
- `web` (Next.js dashboard)
- `worker` (copy engine)
- `postgres`
- `redis`

Dev infra Compose defines:
- `postgres` (host-accessible for local app processes)
- `redis` (host-accessible for local app processes)

Core Compose requirements:
- Explicit healthchecks and restart policies for all long-running services
- Named volumes for Postgres (and optional Redis persistence)
- A single internal Docker network (service-to-service by name)
- Environment via `.env` + per-service env blocks (no secrets committed)
- One-shot migration job/container (or worker boot step) before starting normal loops

Local host-run workflow requirement:
- Start infra containers only (`postgres` + `redis`) via `docker/docker-compose.dev-infra.yml`.
- Run migrations from host before starting apps.
- Run Next.js and worker from host (`pnpm dev:web`, `pnpm dev:worker`) against local `DATABASE_URL` / `REDIS_URL`.

### 6.5 Deployment / region constraints
Polymarket enforces geographic eligibility. Production deployment must:
- verify eligibility at startup (call geoblock endpoint),
- fail closed if not eligible,
- choose a droplet region that is not restricted.

---

## 7) What’s in-scope now vs later

### 7.1 In-scope for v0.1–v0.2
- Single droplet deployment
- Single follower account
- 1–3 leader accounts
- Ratio-based portfolio mirroring
- Netting + reconcile loop
- GitHub-authenticated dashboard access (single admin / small-team username allowlist)
- Basic dashboard:
  - configure leaders + ratio
  - show current tracking error
  - show last reconcile time and last order status
  - kill switch

### 7.2 Out-of-scope (explicit)
- Anything intended to bypass geographic restrictions or platform controls
- High-frequency market-making
- Multi-datacenter low-latency infrastructure
- Multi-tenant auth, RBAC, or enterprise identity integrations beyond the GitHub username allowlist
- “Guaranteed profit” claims/logic

---

## 8) Web dashboard pages (initial spec)

The web dashboard is the **control + observability** UI for the bot. It should answer three questions fast:
- **Am I exposed?** (current risk / notional / tracking error)
- **Am I making or losing money?** (total PnL + breakdowns)
- **Is the system healthy?** (data freshness, loops running, errors)

Access to dashboard pages and dashboard data APIs is restricted behind GitHub login (OAuth) with a server-side username allowlist. The web health endpoint may remain public for infra healthchecks.

**Design notes**
- Keep the UI “boring and obvious”. Every page should show **last-updated timestamps** and expose the **why** behind any automated action (especially skips).
- The layout must be **mobile-first friendly**, especially on **portrait** phones:
  - Prefer **cards** or **collapsible rows** over ultra-wide tables.
  - Allow **horizontal scroll** for tables when needed, with **sticky** key columns (e.g., timestamp + market).
  - Hide secondary columns behind a “details” expand to avoid unreadable micro-text.

### 8.1 Overview (root page)

**Goal:** a single-screen snapshot of current exposure, PnL, and health.

**What to show**
- **Exposure snapshot**
  - Total notional exposure (and optionally top markets by exposure)
  - Exposure by leader (top N)
  - Current tracking error summary (e.g., absolute $ error and % vs target)
- **PnL snapshot**
  - Total PnL (realized + unrealized, if both are available)
  - PnL by market (top N)
  - **PnL by leader (top N)** — computed from our follower fills using the attribution ledger (see Portfolio section)
- **Recent activity**
  - Last N executed trades (market, side, size, price, timestamp, status)
  - Last N skips (market, intended action, skip reason, timestamp)
- **General health**
  - Worker status (running/paused) + global kill switch state
  - Data freshness: last leader sync, last follower sync, last reconcile, last on-chain trigger received
  - Connectivity: Polymarket API reachable, WS connected, Alchemy stream connected (if enabled)
  - Errors: last error message, error count in last 1h, retry/backoff status

### 8.2 Leaders page

**Goal:** manage leaders and understand, at a glance, how each one is tracking.

**Main table (one row per leader)**
- Identity: display name + leader **profile address** (user-provided) + resolved **proxy/trade wallet** (used for detection)
- Copy config summary: ratio, allow/deny list indicator, caps indicator
- Status: active/paused + “last sync” timestamp
- Metrics: exposure, tracking error, PnL contribution (optional), executed/skip counts (optional)
- Actions:
  - **Edit** (ratio + per-leader rules)
  - **Pause/Resume**
  - **Remove**
  - **View on Polymarket** (opens the leader’s Polymarket profile in a new tab)

**Navigation**
- Clicking the leader row (or name) opens the **Leader detail** page.

**Add leader flow**
- Add by **Polymarket profile URL** (preferred) or the raw **profile address** (`0x…`).
- Optionally support add-by-username as a convenience if we can resolve it reliably.
- After adding: show a confirmation state with:
  - the stored profile address,
  - the resolved proxy/trade wallet(s),
  - and first sync status (success/error + last sync time).

### 8.3 Leader detail page

**Goal:** deep visibility + controls for one leader.

**Header**
- Leader identity (name/handle if known + address)
- Status pill (active/paused) + last sync timestamp
- **View on Polymarket** button (opens that leader’s Polymarket profile)

**Controls**
- Activate / Pause copying for this leader
- Edit ratio + per-leader rules (allow/deny markets, max exposure, min delta thresholds, slippage caps)

**Leader stats**
- Current target exposure vs current follower exposure attributable to this leader (and tracking error)
- Trades pipeline counters:
  - triggers received
  - trades executed
  - skips + breakdown by reason (min notional, min size, slippage guard, illiquid book, rate limit, kill switch, etc.)
- Recent activity lists:
  - recent triggers (what changed)
  - recent executions (what we did)
  - recent skips (what we didn’t do + why)

**Diagnostics (collapsible)**
- Last authoritative positions snapshot time
- Last reconcile outcome summary (deltas considered, deltas executed, deltas skipped)
- Recent errors related to this leader

### 8.4 Portfolio page

**Goal:** understand current portfolio performance and where risk (exposure) is concentrated, then drill into a single position to see every copy decision made for it.

**Top summary (cards)**
- **Exposure** (current total notional exposure)
- **Total PnL**
- **1h PnL**
- **24h PnL**
- **1w PnL**
- **1m PnL**
- Each card should show:
  - value in $ (and optionally %)
  - **last updated** timestamp
  - tooltip explaining whether it’s realized/unrealized or combined (depending on what we can compute reliably)

**PnL graph**
- Line chart of portfolio PnL over time.
- Time-range selector:
  - **1h**, **24h**, **1w**, **1m**
- Granularity rules (so charts are readable and data volume is bounded):
  - 1h → 1–2 minute points
  - 24h → 5–15 minute points
  - 1w → hourly points
  - 1m → 4–12 hour points (or daily if needed)

**Data + performance requirements (important)**
- The dashboard must not trigger “N tokens × M fetches” to render the charts.
- Use a **single backend endpoint** per view (or a small fixed set) that returns:
  - the summary cards,
  - the chart time series for the selected range,
  - and the exposure breakdown datasets.
- Server-side, compute and store **portfolio snapshots** (value, cost basis, PnL) on a cadence (e.g., every 1–5 minutes), and build **rollups** (hourly/daily) for longer ranges.
  - This lets the UI request small, pre-aggregated datasets instead of recomputing from scratch.
  - Maintain accuracy by reconciling snapshots against authoritative follower positions and fresh prices on a slower cadence (e.g., every few minutes), while still serving fast cached results to the UI.
- The REST “hot path” should be:
  - *incremental*: fetch “since last timestamp” for live updates when possible
  - *cached*: reuse market metadata + token mapping aggressively
  - *bounded*: hard cap on points returned per chart range

**Exposure breakdown charts**
- **Exposure by leader (bar chart)**: top **4 leaders** by exposure.
- **Exposure by market/outcome (bar chart)**: top **10 outcome tokens** by exposure, plus a final bar labeled **Other** that aggregates the remainder.
  - Market label shows market name; outcome label (YES/NO or custom) shown smaller.

**Leader attribution + PnL by leader (v0.1, implementable)**

We **do** want “PnL by leader” to be real (not estimated). Since we can’t rely on the exchange to store arbitrary metadata per order, we make this observable by maintaining an **internal attribution ledger** that tags every follower fill with “which leader(s) caused this trade” and then computes PnL from **our actual fills**.

**Core idea**
- We treat each leader as a **sub-portfolio** inside the follower.
- For every outcome token, we keep a per-leader internal position + cost basis.
- When we place a follower order for a token, we compute an **allocation vector** across leaders (who needs how many shares), store it, and then **attribute the resulting fills** to those leaders.

**Attribution algorithm (per token, at order creation)**
- Inputs (for a given tokenID `t`):
  - `target_shares[L,t]` for each leader `L` (from portfolio mirroring, notional→shares conversion)
  - `ledger_shares[L,t]` for each leader `L` (our internal sub-positions)
  - `net_delta_shares[t] = target_total_shares[t] - follower_total_shares[t]` (the trade we are about to do)
- Compute `need[L,t] = target_shares[L,t] - ledger_shares[L,t]`.
- If `net_delta_shares[t] > 0` (BUY):
  - Eligible leaders are those with `need[L,t] > 0`.
  - Weight: `w[L] = need[L,t] / sum_pos_need`.
- If `net_delta_shares[t] < 0` (SELL):
  - Eligible leaders are those with `need[L,t] < 0` (i.e., over target; should sell down).
  - Weight: `w[L] = abs(need[L,t]) / sum_abs_neg_need`.
- Store the weights (or the implied target share allocations) as **order metadata in our DB** on the `copy_order` record.

**Attributing actual fills (per trade fill event)**
- Each fill gives `(filled_shares, filled_usdc, fee_usdc, avg_price)` for that token order (from user WS or REST).
- Allocate to leaders by the stored weights:
  - `alloc_shares[L] = filled_shares × w[L]`
  - `alloc_usdc[L] = (filled_usdc - fee_usdc) × w[L]` (and store `alloc_fee_usdc[L] = fee_usdc × w[L]`)
- Edge cases:
  - If there are no eligible leaders (weights undefined due to rounding/min-size behavior), allocate the entire fill to a special bucket leader `"UNATTRIBUTED"` so totals still reconcile.
  - If rounding causes tiny residuals, assign the remainder to `"UNATTRIBUTED"`.

**PnL accounting (efficient average-cost method)**
For each leader `L` and token `t`, maintain:
- `ledger_shares[L,t]`
- `ledger_cost_usdc[L,t]` (total cost basis of currently held shares)
- `realized_pnl_usdc[L]` (running total)

Update rules per attributed fill:
- BUY allocation:
  - `ledger_shares += alloc_shares`
  - `ledger_cost_usdc += alloc_usdc + alloc_fee_usdc`
- SELL allocation (using weighted-average cost basis):
  - `avg_cost = ledger_cost_usdc / ledger_shares` (before the sell)
  - `cost_removed = avg_cost × alloc_shares`
  - `realized_pnl += (alloc_usdc - alloc_fee_usdc) - cost_removed`
  - `ledger_shares -= alloc_shares`
  - `ledger_cost_usdc -= cost_removed`

Unrealized PnL per leader at time `now`:
- Mark each token using a price snapshot (mid/last; defined elsewhere) and compute
  - `unrealized_pnl[L] = sum_t( mark_price[t] × ledger_shares[L,t] - ledger_cost_usdc[L,t] )`

**What this means in the UI**
- “PnL by leader” becomes a first-class, exact metric **with respect to our follower fills and our attribution policy**.
- If two leaders both push us into the same token, the attribution ledger deterministically splits fills (and thus PnL) based on who was “responsible” for the delta toward target.

**Data we must store (minimal, efficient)**
- `copy_order` (one row per follower order attempt): includes `token_id`, `side`, intended size, `orderType`, timestamps, and `leader_weights` (JSON map `leader_id → weight`) + `unattributed_weight` if needed.
- `copy_fill_allocation` (one row per fill per leader): `copy_order_id`, `trade_id`, `leader_id`, `token_id`, `shares_delta`, `usdc_delta`, `fee_usdc_delta`, `avg_price`, timestamp.
- `leader_token_ledger` (one row per leader×token): `shares`, `cost_usdc`.
- `leader_pnl_summary` (one row per leader): `realized_pnl_usdc` (unrealized computed on demand or cached in snapshots).

**Positions table (current holdings)**

- One row per outcome token position currently held.
- Columns:
  - **Market** (market name; outcome shown smaller below)
  - **Shares** (current size)
  - **Current price / share**
  - **Cost basis** (total $ spent to acquire the position)
  - **Current value** (shares × current price)
- Clicking a row opens the **Position detail** page.

#### Position detail page (from Portfolio)

**Header fields**
- Everything shown in the positions row (market/outcome, shares, price, cost basis, current value)
- Plus identifiers:
  - **asset id**
  - **market id**

**Copy attempts table (for this token)**
Shows every attempt where we tried (or considered) copying a leader execution into this specific outcome token.

Columns:
- **Date & time**
- **Side** (BUY/SELL)
- **Leader**
- **Decision** (EXECUTED or SKIPPED)
- **Accumulated delta notional** at the time (how much we had built up toward executing, at our ratio)
- **Reason** (only populated if SKIPPED), examples:
  - did not cross $1 threshold
  - slippage too high
  - price moved beyond guard
  - min order size / tick rounding resulted in too-small order
  - market illiquid / book too thin
  - rate-limited / global kill switch / leader paused

**Mobile optimization**
- In portrait, stack summary cards and charts vertically.
- The positions table should degrade into **position cards** (market/outcome + the 3–4 most important numbers) with tap-to-expand details, rather than squeezing 6 columns into unreadable text.


### 8.5 Trades page

**Goal:** a complete, filterable log of **all trades done by leaders** (as we detected them), with strong visibility into **latency** and **data source**.

**Layout**
- **Filters row** (above the table)
  - **Leader filter**: show all trades or only trades from a selected leader (should apply immediately)
  - **Search bar**: search by **market name**, **outcome**, or **market/outcome/position IDs** (whatever identifiers we store)
- **Trades table**
  - Shows **50 trades per page**
  - Default sort: most recent first (leader fill timestamp descending)
- **Pagination controls** (bottom)
  - **Next page** (only if possible)
  - **Previous page** (only if possible)
  - **First page** (only if we’re not already on it)

**Table columns (one row per canonical trade event)**
- **Leader fill timestamp** (`leader_fill_at_ms`): the **true on-chain time** of the leader’s transaction (Polygon block timestamp) when we detect via on-chain WS; if we only have REST fallback (Data API), use the Data API trade `timestamp` (seconds) converted to ms.
- **Detect lag (ms)**: `detected_at_ms - leader_fill_at_ms`
- **Leader user** (name/handle)
- **Market**
  - market name
  - outcome shown **smaller** on a second line
- **Side** (“BUY” / “SELL”)
- **Shares**
- **Price / share**
- **Notional** (total spent/received)
- **Source**: **WebSocket** or **REST fallback API** (**first ingestion source** for that trade)

**Timestamp fields we store (for audit + UI):**
- `leader_fill_at_ms` (unix millis) + `leader_fill_source` (`CHAIN` or `DATA_API`)
- `ws_received_at_ms` (unix millis; only for WS triggers; stored for audit/diagnostics, not required as a trades-table column)
- `detected_at_ms` (unix millis; when our system persisted the trade)

**Capture + enrichment rules**
- As soon as we catch a trade through the **WebSocket**, we should store and render **all available fields immediately**.
- Only after that, we may enrich missing display fields (e.g., market/outcome labels) via the API **if necessary**.
- If WS is sufficient to get everything, prefer WS-only and keep REST strictly as a **fallback** if WS temporarily fails.
- Always persist and display the **source** (WS vs REST fallback) for audit/debugging.
- REST fallback must **not** create duplicate rows for trades already captured from WS; it should enrich the existing row only.
- WS must also avoid creating duplicates for trades already stored from REST fallback; it should enrich the existing row only.

**Mobile optimization**
- For portrait mobile, the trade view should not be a tiny unreadable table.
  - Prefer a **card layout** per trade, or a table with **horizontal scrolling** plus **sticky** timestamp/market columns.
  - Hide latency columns behind a tap-to-expand “details” section.

### 8.6 Copies page

**Goal:** understand the copy pipeline end-to-end: what we *want* to copy, what is *currently being attempted*, what we *already sent to venue*, and what got *skipped* (and why).

**Top status (summary cards)**
- **CLOB authentication**: OK / ERROR (and last auth refresh time)
- **User Channel WS**: connected / disconnected (and last message time)
- **Time since last reconciliation**
- **Pending < $1**: number of pending deltas currently below minimum executable notional
- **Open orders**: number of currently open orders

> All summary cards should show a **last updated** timestamp.

**Tables (50 rows per page each)**
All tables:
- show **50 rows per page**
- have pagination controls: **First / Previous / Next** (only enabled when applicable)
- default sort is **most recent first**
- are mobile-friendly (see mobile notes below)

#### A) Open potential copies (pending deltas, not yet in active attempt loop)

These are pending deltas in the accumulator layer that are **not currently in an active attempt**.

Each row:
- **Created at** (date + time)
- **Leader** (single leader or multi-leader contributors for this delta)
- **Market** (market name, with outcome smaller below — same style as other tables)
- **Side** (BUY / SELL)
- **Pending notional** (the net notional we currently want to trade)
- **Status / block reason** (why it remains pending), examples:
  - order too small ($1 minimum not met)
  - price difference too high vs guards
  - slippage too high
  - spread too large / book too thin
  - stale price data / market WS disconnected
  - global copy disabled / leader paused

Lifecycle:
- Leaves this table when:
  - it is picked up into an active attempt (→ appears in **Attempting**), or
  - it is finalized as skipped/expired (→ appears in **Skipped attempts**)

#### B) Attempting (active in-flight attempts)

This table is the live view of active `copy_attempt` rows (`PENDING`, `RETRYING`, `EXECUTING`) that are currently being evaluated/retried by the execution loop.

Each row:
- **Created at** + **Last attempted at**
- **Leader** (single or multiple contributors)
- **Market** + **Outcome**
- **Side**
- **Attempt size** (current linked pending-delta notional + shares; fallback to attempt snapshot only if pending delta is unavailable)
- **Price/share** (derived as `attempt_notional_usd / attempt_shares`; shown as `n/a` when shares are non-positive)
- **Current spread** (best ask - best bid for that token from worker market books)
- **Attempt status**
- **Retries / max retries**
- **Why delayed/blocked** (best available message/reason), plus latest order status/error when available
  - messages should be human-readable (e.g., `not enough balance / allowance`, `Market Ws Disconnected`) rather than raw JSON payload blobs.

Lifecycle:
- Leaves this table when:
  - an order row is created/placed (→ visible in **Executions**), or
  - the linked pending delta is converted/expired/net-zero and the attempt is terminally expired/failed/skipped (→ visible in **Skipped attempts**)

State contract after placement:
- On successful order placement, the attempt must be finalized as `decision=EXECUTED` and `status=EXECUTED` (terminal).
- `EXECUTING` is transient only while placement is in progress and must not persist after placement is acknowledged.

#### C) Executions (orders placed / attempted)

This table is the audit log of **venue-submitted execution attempts** (typically **FAK** orders) that received an exchange order id.
Rows that fail before a real venue order id exists (e.g., submit rejects like `not enough balance / allowance`) should remain visible through **Attempting** state/reason history, not as execution rows.

Each row should include enough data to answer “what happened and why?”:
- **Attempted at** (date + time)
- **Leader**
- **Market** (market name + outcome)
- **Side** (BUY / SELL)
- **Notional** (intended notional) and/or **Shares** (intended size) — whichever is canonical for that side
- **Price cap / limit** used (so we can verify slippage logic)
- **Order id** (internal id and/or Polymarket order id, if available)
- **Fee paid** (USDC) for FILLED/PARTIALLY_FILLED (0 if none / not yet known)
- **Status**
  - `PLACED`, `PARTIALLY_FILLED`, `FILLED`, `FAILED`, `CANCELLED`, `RETRYING`
- **Reason / error** (only when failed/retrying), examples:
  - rejected by exchange (tick/min size)
  - insufficient balance
  - rate limited
  - WS desync / stale book
  - slippage/spread guard triggered at execution time
  - network error / timeout

Retry behavior:
- If an execution fails, mark it **FAILED** with a reason and schedule **automatic reattempts** with backoff (to avoid stuck copies).
- Retries should stop once the attempt expires (configured max expiration time).
- Retry state and reasons are primarily visible in **Attempting**.

#### D) Skipped attempts (final non-executions, grouped)

This table is the log of copy attempts that **will not be executed** (either permanently skipped or expired), grouped by **token id** (outcome token / position).

Grouping behavior:
- One “group row” per token id showing:
  - **Market** (market name + outcome)
  - **Token id** (and optionally market id in details)
  - **Skip count** (number of skipped attempts in the group)
  - **Most common skip reason** (or top 2)
  - **Last skipped at**
- Clicking a group row (or expand) shows the individual skip records with:
  - **Date & time**
  - **Side**
  - **Leader**
  - **Reason** (order too small, slippage/spread, price moved, leader paused, kill switch, expired, etc.)
  - (Optional) the **accumulated delta notional** at the time it was skipped

**Mobile optimization**
- In portrait mobile, tables should degrade into **cards** with the key fields always visible:
  - timestamp, market/outcome, side, notional, status
- Secondary fields (leader, error reason, ids, price cap, fees, etc.) should be in a tap-to-expand “details” drawer.
- Keep pagination controls sticky or easy to reach without excessive scrolling.


### 8.7 Config page

**Goal:** centrally control what the bot is allowed to do (kill switches), and tune risk/quality tradeoffs (guardrails + sizing) with safe defaults.

**Mobile optimization**
- Make the page a **vertical stack of cards** with clear headings and short helper text.
- Any “advanced” settings should be **collapsible**.

#### A) Master switches (top of page)

- **Copy system enabled** (primary switch)
  - When **OFF**, the bot must not place or modify orders (execution loop hard-disabled).
  - When **ON**, execution is allowed subject to guardrails and sizing.

When the **copy system is disabled**, show additional switches directly below:
- **Trade detection system enabled** (on-chain/WS detection pipeline)
- **User Channel WS enabled** (follower account user-channel WebSocket)

> Rationale: allow “observe only” mode (detection + telemetry) without risk of execution.

#### B) Reconciliation cadence

- **Reconcile interval** (authoritative positions sync): default **60 seconds** (1 minute)
  - This controls how often we fetch leader positions (ground truth) and recompute target deltas.
  - Keep this configurable; start at 60s by default.

(Option for later) Adaptive cadence:
- under high volatility or large tracking error, temporarily reduce interval; otherwise keep it at the configured baseline.

#### C) Guardrails

**Goal:** define when a potential copy is allowed to turn into an order, and what conditions can block/retry it.

At the top of this section:
- Mode toggle: **Global guardrails** vs **Per-leader overrides**
  - Global values apply to all leaders by default.
  - Per-leader overrides replace the global values only for that leader.

Guardrails (with defaults):
- **Max time before expiration**: default **2h**
  - After this time, a pending copy attempt is considered stale and should be skipped/expired.
- **Max worsening vs leader fill (BUY)**: default **3¢**
  - When buying, require: `our_expected_buy_price - leader_fill_price <= max_worsening_buy`.
- **Max worsening vs leader fill (SELL)**: default **6¢** (more forgiving by default)
  - When selling, require: `leader_fill_price - our_expected_sell_price <= max_worsening_sell`.
  - Rationale: exiting a position is often higher priority than entering one.
  - Optional “exit priority” mode: once a sell attempt has been pending for longer than `sell_guard_relax_after_minutes` (default OFF), progressively relax `max_worsening_sell` until the position can be exited (still subject to spread/slippage/thin-book guards).
- **Max slippage vs mid**: default **200 bps** (2.0%)
  - Compute `mid = (best_bid + best_ask)/2`.
  - If expected execution price for our size is worse than `mid ± slippage` (directional), block and retry later (until expiration).
- **Max price per share**: default **OFF**
  - Optional cap (e.g., 97¢) to avoid buying very expensive YES/NO shares.
- **Max spread**: default **3¢**
  - If the bid/ask spread exceeds this, block execution and retry later (until expiration).
- **Min notional per order**: default **$1.00** (Polymarket minimum)
- **Min book depth for our size**: default **ON**
  - Require that there is sufficient visible liquidity to fill our intended size within the computed price cap.

Additional guardrails worth supporting (recommended):
- **Max open orders (global)**: default **20**
- **Cooldown per market** (seconds): default **5s** (avoid rapid retries on the same token)
- **Max retries per attempt**: default **TBD** (or unlimited until expiration, with exponential backoff)

**Thin-book computation (how guards are evaluated)**
- Use the current order book (best levels) to estimate the **VWAP** for our intended size.
- Apply slippage/spread/worsening guards against that VWAP estimate (not just top-of-book).
- If the book is too thin (insufficient depth within cap), keep the attempt pending and retry with backoff.

**Retry semantics (important)**
- If an attempt fails a guardrail at execution time (e.g., spread is 4¢), it should **remain pending** and be **re-evaluated later** with backoff **until it expires**.
- The UI should make it clear whether an attempt is:
  - pending (blocked by guardrails),
  - converted into an execution attempt,
  - or expired/skipped permanently.

#### D) Sizing

At the top of this section:
- Mode toggle: **Global sizing** vs **Per-leader sizing**

Sizing fields:
- **Copy ratio (notional multiplier)**: default **0.01**
  - Target follower notional for each token is computed as: `leader_currentValue × ratio`.
  - Target follower shares are computed as: `target_notional / price_snapshot`.
    - Price snapshot preference order:
      1) Data API `curPrice` from the same positions snapshot, else
      2) cached best bid/ask mid from the market channel, else
      3) REST order book top-of-book.
  - Targets are stored internally as **shares**, but ratio is always applied to **notional exposure**.
  - Validate to a safe range (e.g., 0.0–1.0).

Recommended optional sizing controls:
- **Max exposure per leader** ($): default **TBD**
- **Max exposure per market/outcome** ($): default **TBD**
- **Max daily notional turnover** ($): default **TBD**

#### E) Other settings (placeholders; fill in as needed)

Because the rest of the spec includes WS/REST fallbacks, execution policies, and UI requirements, this page should eventually include settings for:
- **Execution policy** (FAK vs marketable limit; limit price logic; retries/backoff parameters)
- **Connectivity / credentials status** (read-only indicators for API keys/auth; not necessarily editable here)
- **Logging / telemetry verbosity** (for debugging production issues)


### 8.8 Status page

**Goal:** quickly answer “is the system healthy?” and provide the details needed to diagnose issues fast.

**Top health cards (one per subsystem)**
Show a card for each subsystem: **Worker**, **Database**, **Redis**, **WebSocket (Alchemy)**.

Each card shows:
- **Status**: `OK` or `DOWN`
- **Last updated** timestamp

Per-card specific fields:
- **Worker**
  - “Last event” (e.g., “last event 23s ago” / “3m ago”)
  - (Optional) current mode: copying enabled/disabled, detection enabled/disabled
- **Database**
  - Database size (and optionally number of rows in key tables)
- **Redis**
  - Number of queues waiting / pending jobs (and oldest job age if available)
- **WebSocket (Alchemy)**
  - Connected/disconnected + connection uptime
  - Last received message timestamp

**Detail cards (below)**
Below the summary row, show an expandable detail card for each subsystem with debugging info.

#### Worker (details)
- Current loops running (trade-detection loop, reconcile loop, execution loop)
- Current reconcile interval (configured) + time until next reconcile
- Last reconcile summary (tokens evaluated, executed, skipped, errors)
- Error rate (last 1h/24h), last error stack trace (truncated) + “copy” button
- Retry/backoff status (global and per token, if tracked)

#### Database (details)
- Connection health + latency (simple ping time)
- Migrations status (latest migration applied? yes/no)
- Key table sizes / row counts (leaders, positions, executions, errors)
- (Optional) slow query log pointers (if enabled)

#### Redis (details)
- Connection health
- Queue breakdown (counts per queue)
- Oldest pending job age + last processed job time
- Memory usage + eviction warnings (if any)

#### WebSocket / Alchemy (details)
- Active subscriptions (which contracts/topics)
- Message rate (msgs/min)
- Reconnect attempts + last disconnect reason
- Fallback usage stats (REST fallback triggers in last 1h/24h)

**Mobile note**
- On portrait mobile: stack the top health cards vertically (2 columns max), and make detail cards **collapsible** with key metrics visible in the collapsed state.


---

## 9) Decisions (resolved)

These items were previously “open questions” and are now decided:

- **Leader identification**
  - Leaders are identified by a **user-provided name** and their **Polymarket profile address** (the `0x…` in the profile URL).
  - We additionally resolve and store the leader’s **proxy/trade wallet(s)** (e.g., `proxyWallet` observed in Data API records) and use those for on-chain filtering and trade detection.
- **Rebalance schedule**
  - Reconciliation is controlled by a config value (`reconcile_interval_seconds`), default **60 seconds**.
- **Slippage policy**
  - Slippage/spread/price movement constraints are implemented as **guardrails in the Config page** (global defaults + per-leader overrides).
  - Default policy is the combination of:
    - max worsening vs leader fill (**3¢**),
    - max spread (**3¢**),
    - max slippage vs mid (**200 bps**),
    - and a thin-book rule that checks VWAP for our intended size before placing the order.
  - If a guardrail fails, we **retry with backoff until expiration** (default 2h).
- **Multiple leaders**
  - Targets are combined by **summing per-leader scaled positions** into one net target portfolio.
  - Execution deltas are **netted per token** (if one leader is long and another is short, the net target reflects both).
- **Fee handling**
  - Fees are captured on our fills and included in:
    - execution audit logs,
    - cost basis / PnL calculations,
    - and the **Copies page** (fee column in Executions).
- **Market selection**
  - No special allowlist/cap is required for v0.1; we mirror whatever markets leaders hold/trade.
  - We still avoid pathological markets via guardrails (spread/depth) and ignore resolved markets for new execution.
- **On-chain trade detection**
  - We implement full ABI decoding for the exchange events and handle duplicates/reorgs correctly.
  - Dedupe is enforced both intra-source (`txHash + logIndex` for chain triggers) and cross-source (canonical trade key across WS + REST fallback).
  - Token/market metadata is resolved via cached market metadata and REST enrichment when needed; REST remains the fallback if WS is degraded.

---



## Appendix A — “Minimum viable algorithm” (pseudocode-ish)

1) **Bootstrap**
- Load copy profiles from DB
- Ensure geoblock eligibility
- Warm caches:
  - market metadata for watched tokens (tick/min size)
  - WS subscriptions for watched tokens
- Start loop(s)

2) **Loop A: trade/activity signals (fast)**
- If Alchemy streaming is enabled:
  - subscribe to relevant on-chain events
  - when an event involving a leader address arrives, treat it as a trigger and enrich via Data API/CLOB
- Otherwise (fallback):
  - poll new trades since last cursor
  - cursor progression is based on the newest successfully **seen** trade timestamp, not only newly inserted rows
- Then (either path):
  - dedupe across WS + REST using canonical trade key and persist at most one row per trade
  - update target state (estimated)
  - for each token with updated target:
    - compute delta vs follower’s last known position
    - add delta to pending accumulator
    - if accumulator >= thresholds and constraints → enqueue execution

3) **Loop B: reconcile (slow, authoritative)**
- Every N seconds (default 60; configurable):
  - fetch leader positions (authoritative)
  - recompute targets
  - fetch follower positions
  - compute deltas and execute subject to caps/thresholds

4) **Execution**
- For each executable delta:
  - check constraints:
    - for **FAK**: $1 min notional, tick_size rounding, spread/slippage/price guards, depth
    - for non-FAK policies (future/optional): include `min_order_size` constraints as required
  - place order (FAK / marketable limit)
  - record audit + outcome
  - update follower state (optimistic, then confirmed via user channel or polling)

---

*End of v0.1.*

## Appendix B — Protocol payloads (request + response shapes)

This appendix exists to make implementation unambiguous. Payloads are shown in a *“shape-first”* way: real fields, with example values where the docs provide them.

### B.1 Alchemy WebSocket (JSON-RPC)

#### B.1.1 `eth_subscribe` for `logs`

**Request (example):** (subscribe to a contract + topic0)
```json
{"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["logs",{"address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","topics":["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]}]}
```

**Notification (example structure):**
```json
{
  "jsonrpc": "2.0",
  "method": "eth_subscription",
  "params": {
    "subscription": "0x4a8a4c0517381924f9838102c5a4dcb7",
    "result": {
      "address": "0x8320fe7702b96808f7bbc0d4a888ed1468216cfd",
      "blockHash": "0x61cdb2a09ab99abf791d474f20c2ea89bf8de2923a2d42bb49944c8c993cbf04",
      "blockNumber": "0x29e87",
      "data": "0x…",
      "logIndex": "0x0",
      "topics": ["0x…"],
      "transactionHash": "0xe044554a0a55067caafd07f8020ab9f2af60bdfe337e395ecd84b4877a3d1ab4",
      "transactionIndex": "0x0",
      "removed": false
    }
  }
}
```

> `removed` may be omitted when `false` depending on the provider; treat missing as `false`.

#### B.1.2 `alchemy_pendingTransactions`

**Request (example):**
```json
{"jsonrpc":"2.0","id":2,"method":"eth_subscribe","params":["alchemy_pendingTransactions",{"toAddress":["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","0xdAC17F958D2ee523a2206206994597C13D831ec7"],"hashesOnly":false}]}
```

**Initial response (subscription id):**
```json
{"id":1,"result":"0xf13f7073ddef66a8c1b0c9c9f0e543c3","jsonrpc":"2.0"}
```

**Notification (full tx object, since `hashesOnly=false`):**
```json
{
  "jsonrpc": "2.0",
  "method": "eth_subscription",
  "params": {
    "result": {
      "blockHash": null,
      "blockNumber": null,
      "from": "0x098bdcdc84ab11a57b7c156557dca8cef853523d",
      "gas": "0x1284a",
      "gasPrice": "0x6fc23ac00",
      "hash": "0x10466101bd8979f3dcba18eb72155be87bdcd4962527d97c84ad93fc4ad5d461",
      "input": "0x…",
      "nonce": "0x11",
      "to": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "transactionIndex": null,
      "value": "0x0",
      "type": "0x0",
      "v": "0x26",
      "r": "0x…",
      "s": "0x…"
    },
    "subscription": "0xf13f7073ddef66a8c1b0c9c9f0e543c3"
  }
}
```

### B.2 Polymarket Data-API (leader state reconciliation)

#### B.2.1 Get trades for a user or markets

**Request shape (query params):**
- `user`: `0x…` (profile address)
- `market`: one or more `conditionId` values (comma-separated)
- `eventId`: one or more event IDs (comma-separated)
- `limit`, `offset`
- `side` (`BUY|SELL`)
- `takerOnly` (boolean; default `true`)
- `filterType` (`CASH|TOKENS`) + `filterAmount` (number)

**Response shape (array of trade records):**
```json
[
  {
    "proxyWallet": "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
    "side": "BUY",
    "asset": "<tokenId-as-string>",
    "conditionId": "0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917",
    "size": 10,
    "price": 0.57,
    "timestamp": 1672290701,
    "title": "<market title>",
    "slug": "<market slug>",
    "icon": "<url>",
    "eventSlug": "<event slug>",
    "outcome": "YES",
    "outcomeIndex": 0,
    "name": "<display name>",
    "pseudonym": "<pseudonym>",
    "bio": "<bio>",
    "profileImage": "<url>",
    "profileImageOptimized": "<url>",
    "transactionHash": "0x…"
  }
]
```

**Ingestion behavior requirements for this endpoint:**
- Data-API rows are a fallback/confirmation source and must be cross-source deduped against WS-triggered trades using canonical trade key.
- Poll cursor must advance from the newest **seen** trade timestamp even when all rows are deduped and `recordsInserted=0`.

#### B.2.2 Get current positions for a user

**Request shape (query params):**
- `user`: `0x…` (required)
- `market` (conditionId list) OR `eventId` (event IDs)
- `sizeThreshold` (default `1`)
- `redeemable`, `mergeable` (booleans)
- `limit`, `offset`
- `sortBy` (`CURRENT|INITIAL|TOKENS|CASHPNL|PERCENTPNL|TITLE|RESOLVING|PRICE|AVGPRICE`)
- `sortDirection` (`ASC|DESC`)
- `title` (string filter)

**Response shape (array of position records):**
```json
[
  {
    "proxyWallet": "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
    "asset": "<tokenId-as-string>",
    "conditionId": "0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917",
    "size": 10,
    "avgPrice": 0.57,
    "initialValue": 5.7,
    "currentValue": 5.7,
    "cashPnl": 0,
    "percentPnl": 0,
    "totalBought": 10,
    "realizedPnl": 0,
    "percentRealizedPnl": 0,
    "curPrice": 0.57,
    "redeemable": false,
    "mergeable": false,
    "title": "<market title>",
    "slug": "<market slug>",
    "icon": "<url>",
    "eventSlug": "<event slug>",
    "outcome": "YES",
    "outcomeIndex": 0,
    "oppositeOutcome": "NO",
    "oppositeAsset": "<tokenId-as-string>",
    "endDate": "<iso date string>",
    "negativeRisk": false
  }
]
```

### B.3 Polymarket CLOB REST API

#### B.3.1 Get order book summary

**Request:**
`GET /book?token_id=<tokenId>`

**Response (example from docs):**
```json
{
  "market": "0x1b6f76e5b8587ee896c35847e12d11e75290a8c3934c5952e8a9d6e4c6f03cfa",
  "asset_id": "1234567890",
  "timestamp": "2023-10-01T12:00:00Z",
  "hash": "0xabc123def456...",
  "bids": [{"price": "1800.50", "size": "10.5"}],
  "asks": [{"price": "1800.50", "size": "10.5"}],
  "min_order_size": "0.001",
  "tick_size": "0.01",
  "neg_risk": false
}
```

> Note: Polymarket outcome-token prices are typically between **$0.00 and $1.00** per share; the numeric values above are just a generic example payload shape.

#### B.3.2 Create & place an order

**Request (high-level shape):**
`POST /order`
```json
{
  "order": "<signed order object (produced by SDK using follower private key / L1 signer)>",
  "owner": "<api key of order owner>",
  "orderType": "FAK|FOK|GTC|GTD",
  "postOnly": false
}
```

> The exact “signed order object” schema is handled by the official CLOB client; we treat it as an opaque blob at the API boundary. The `owner` field is the follower’s **L2 API key** (not the wallet address).

### B.4 Polymarket CLOB WebSocket (dashboard + optional trading signals)

#### B.4.1 User Channel

**Subscribe:** `SUBSCRIBE <wss-channel> user` (authenticated)

**Trade message (example):**
```json
{
  "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  "event_type": "trade",
  "id": "28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e",
  "last_update": "1672290701",
  "maker_orders": [
    {
      "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
      "matched_amount": "10",
      "order_id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
      "outcome": "YES",
      "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
      "price": "0.57"
    }
  ],
  "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  "matchtime": "1672290701",
  "outcome": "YES",
  "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "price": "0.57",
  "side": "BUY",
  "size": "10",
  "status": "MATCHED",
  "taker_order_id": "0x06bc63e346ed4ceddce9efd6b3af37c8f8f440c92fe7da6b2d0f9e4ccbc50c42",
  "timestamp": "1672290701",
  "trade_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "type": "TRADE"
}
```

**Order message (example):**
```json
{
  "asset_id": "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  "associate_trades": null,
  "event_type": "order",
  "id": "0xff354cd7ca7539dfa9c28d90943ab5779a4eac34b9b37a757d7b32bdfb11790b",
  "market": "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  "order_owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "original_size": "10",
  "outcome": "YES",
  "owner": "9180014b-33c8-9240-a14b-bdca11c0a465",
  "price": "0.57",
  "side": "SELL",
  "size_matched": "0",
  "timestamp": "1672290687",
  "type": "PLACEMENT"
}
```

#### B.4.2 Market Channel (example: `price_change`)

```json
{
  "market": "0x5f65177b394277fd294cd75650044e32ba009a95022d88a0c1d565897d72f8f1",
  "price_changes": [
    {
      "asset_id": "71321045679252212594626385532706912750332728571942532289631379312455583992563",
      "price": "0.5",
      "size": "200",
      "side": "BUY",
      "hash": "56621a121a47ed9333273e21c83b660cff37ae50",
      "best_bid": "0.5",
      "best_ask": "1"
    }
  ],
  "timestamp": "1690000000000",
  "event_type": "price_change"
}
```

## Documentation and sources

Polymarket:
- Docs home: https://docs.polymarket.com/
- Auth overview (L1/L2 auth + headers): https://docs.polymarket.com/api-reference/authentication
- CLOB: WSS User Channel (trade + order messages): https://docs.polymarket.com/developers/CLOB/websocket/user-channel
- CLOB: WSS Market Channel (price_change / tick_size_change): https://docs.polymarket.com/developers/CLOB/websocket/market-channel
- CLOB: REST Order Book Summary: https://docs.polymarket.com/api-reference/orderbook/get-order-book-summary
- CLOB: Place Single Order: https://docs.polymarket.com/developers/CLOB/orders/create-order
- CLOB: Onchain Order Info (interpreting `OrderFilled`): https://docs.polymarket.com/developers/CLOB/orders/onchain-order-info
- Data-API: Get current positions: https://docs.polymarket.com/api-reference/core/get-current-positions-for-a-user
- Data-API: Get trades: https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets

Alchemy:
- `logs` subscription (topic filters + `removed` semantics): https://www.alchemy.com/docs/reference/logs
- `alchemy_pendingTransactions` subscription: https://www.alchemy.com/docs/reference/alchemy-pendingtransactions

EVM JSON-RPC reference for `eth_subscribe` (logs):
- Chainstack (clear request example): https://docs.chainstack.com/reference/ethereum-native-subscribe-logs

Explorers (to validate exchange contract addresses / event logs):
- PolygonScan: CTFExchange contract: https://polygonscan.com/address/0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e
- PolygonScan: NegRiskCtfExchange contract: https://polygonscan.com/address/0xc5d563a36ae78145c45a50134d48a1215220f80a

Notes:
- This spec includes example payload shapes copied/derived from the above docs. When implementing, prefer the official Polymarket clients/types for any signed-order payloads to avoid schema drift.
- Order signing for CLOB order placement is an **L1 EIP-712 signing step** and is distinct from L2 API-key authentication.
