# polymarket-copier

## Project Overview

`polymarket-copier` is a self-hosted copy-portfolio system for Polymarket.

It watches one or more public leader accounts and mirrors their portfolio exposure into your follower account at a configurable ratio. Instead of replaying every single trade, it continuously targets the leader's current net exposure and rebalances your account toward that target using configurable guardrails.

At a high level, the system works like this:

- Ingest leader activity and positions from Polymarket Data API (with on-chain websocket triggers for low-latency detection).
- Build target follower exposure by applying your copy ratio to leader positions.
- Net deltas and apply execution guardrails (minimum notional, slippage, spread, cooldown, retries).
- Submit signed CLOB orders from the worker and track outcomes in the dashboard.

Dashboard preview:

![Polymarket Copier dashboard overview](docs/images/dashboard-overview.png)

## Quick Start (Host-run Web/Worker + Docker infra)

1. Create local env file:
   - `cp .env.example .env`
2. Set your follower L1 signing key in `.env`:
   - `POLYMARKET_FOLLOWER_PRIVATE_KEY=0x...`
3. Generate/derive Polymarket L2 CLOB API credentials:
   - `pnpm polymarket:creds`
   - paste `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE` into `.env`
4. If your Polymarket account uses a proxy/safe wallet, also set:
   - `POLYMARKET_SIGNATURE_TYPE=POLY_PROXY` or `POLY_GNOSIS_SAFE`
   - `POLYMARKET_FUNDER_ADDRESS=0x...`
5. Optional execution cap:
   - set `MAX_PRICE_PER_SHARE_USD` to block BUY attempts above your chosen per-share price (leave blank to disable)
   - optional per-leader override: on the Leader detail page, set `maxPricePerShareUsd` to override (or clear) the global cap for that leader only
6. Install dependencies:
   - `pnpm install`
7. Validate workspace:
   - `pnpm typecheck`
8. Start local dev infra only (Postgres + Redis):
   - `pnpm dev:infra:up`
9. Apply migrations:
   - `pnpm db:migrate`
10. Run web + worker from host:
   - `pnpm dev:web`
   - `pnpm dev:worker`

## Quick Start (Full Docker Stack)

1. Create local env file:
   - `cp .env.example .env`
2. Set `POLYMARKET_FOLLOWER_PRIVATE_KEY` and Polymarket L2 API credentials in `.env`
3. Install dependencies:
   - `pnpm install`
4. Start full stack with Docker Compose:
   - `pnpm compose:up`

## Polymarket Trading Credentials

- Order placement requires both:
  - L1 signer: `POLYMARKET_FOLLOWER_PRIVATE_KEY`
  - L2 CLOB API credentials: `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_PASSPHRASE`
- The worker signs orders with the follower private key (EIP-712 / L1) and submits them over the CLOB API using L2 credentials.
- L2 credentials are also used for authenticated CLOB operations and the user-channel WebSocket.
- For proxy/safe account setups, configure:
  - `POLYMARKET_SIGNATURE_TYPE` (`EOA`, `POLY_PROXY`, `POLY_GNOSIS_SAFE`)
  - `POLYMARKET_FUNDER_ADDRESS` (required for proxy/safe modes)
- Troubleshooting:
  - If the Copies page shows `not enough balance / allowance` while your portfolio has cash, verify signing mode:
    - `EOA` mode checks signer-wallet USDC/allowance.
    - proxy/safe-funded accounts must use `POLY_PROXY` or `POLY_GNOSIS_SAFE` plus `POLYMARKET_FUNDER_ADDRESS=<your profile address>`.
- Safety behavior:
  - If `EXECUTION_ENGINE_ENABLED=true` and required signing config is missing/invalid, the worker fails startup intentionally.

## GitHub Auth / Allowlist

- The web dashboard is protected by GitHub OAuth.
- Access is controlled by `AUTH_GITHUB_ALLOWED_USERS` (comma-separated GitHub usernames/handles).
- To grant access to multiple people, add each GitHub username to the same env var separated by commas.
- To add another user later, append their username to the list and restart the web app/container.
- Example:
  - `AUTH_GITHUB_ALLOWED_USERS=alice,bob,carol`
- Spaces are okay (`alice, bob, carol`), and matching is case-insensitive.
- Use GitHub usernames (the `login`/handle), not display names.
- After changing the allowlist, restart the web app/container so the new env value is loaded.
- Full setup instructions (GitHub OAuth App, callback URLs, local/prod examples): `authguide.md`

## Services (Docker Compose)

Compose and Docker assets live under `docker/`:
- `docker/docker-compose.yml`
- `docker/docker-compose.dev-infra.yml`
- `docker/Dockerfile`
- `docker/Dockerfile.dockerignore`
- `docker/nginx/default.conf`

- `nginx` -> public entrypoint on `http://localhost:8080` (configurable via `NGINX_PORT`)
- `web` -> Next.js dashboard
- `worker` -> copy engine process with health endpoint on `/health`
- `postgres` -> durable data store (named volume)
- `redis` -> cache/ephemeral store (named volume)
- `migrate` -> one-shot Prisma migration job that must complete before `worker` starts

## Dev Infra Commands

- Start Postgres + Redis only:
  - `pnpm dev:infra:up`
- Stop Postgres + Redis only:
  - `pnpm dev:infra:down`
- Inspect Postgres + Redis containers:
  - `pnpm dev:infra:ps`
- Tail Postgres + Redis logs:
  - `pnpm dev:infra:logs`

## Health Checks

- `nginx`: `GET /health`
- `web`: `GET /api/health`
- `worker`: `GET /health`
- `worker user channel`: `GET /user-channel/status`
- `postgres`: `pg_isready`
- `redis`: `redis-cli ping`

## DB Commands

- Generate Prisma client:
  - `pnpm --filter @copybot/db generate`
- Apply migrations:
  - `pnpm --filter @copybot/db migrate:deploy`
- Check migration status:
  - `pnpm --filter @copybot/db migrate:status`
- Seed bootstrap data:
  - `pnpm --filter @copybot/db seed`
- Run DB integration test:
  - `pnpm --filter @copybot/db test:integration`

## Reset Database

Use this when you want a clean local DB (all data removed, migrations re-applied from scratch).

1. Stop running app processes (`dev:web`, `dev:worker`) so they do not race the reset.
2. Reset schema and data:
   - `sh -ac 'set -a; . ./.env; set +a; pnpm --filter @copybot/db exec prisma migrate reset --force --skip-seed --schema prisma/schema.prisma'`
3. Regenerate Prisma client:
   - `pnpm --filter @copybot/db generate`
4. Optional: seed bootstrap data:
   - `pnpm --filter @copybot/db seed`
5. Start apps again:
   - `pnpm dev:web`
   - `pnpm dev:worker`

Notes:
- This is destructive and deletes all local Postgres data for this app schema.
- If your DB is managed by Docker and you want to wipe volumes too, run:
  - `docker compose -f docker/docker-compose.dev-infra.yml down -v`
  - then `pnpm dev:infra:up` and run the reset command above.

## Deployment Guide (DigitalOcean Droplet + `polymarketspy.live`)

This is a production-style guide for deploying on a droplet and serving the dashboard at:

- `https://polymarketspy.live`

Assumptions:
- Ubuntu droplet
- SSH access (example: `ssh polybot@165.22.205.182`)
- Repo already cloned at `~/apps/polymarket-copier`
- Domain DNS is under your control

### 1) Point DNS to the droplet

Create DNS records:

1. `A` record `@` -> `165.22.205.182`
2. Optional `A` record `www` -> `165.22.205.182`

Verify:

- `dig +short polymarketspy.live`
- `dig +short www.polymarketspy.live`

### 2) Install system dependencies

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx curl
sudo usermod -aG docker $USER
newgrp docker
```

Verify:

- `docker --version`
- `docker compose version`
- `nginx -v`

### 3) Prepare `.env` with production values

```bash
cd ~/apps/polymarket-copier
cp .env.example .env
```

Set at least:

```dotenv
AUTH_SECRET=<long-random-secret>
AUTH_GITHUB_ID=<github-oauth-client-id>
AUTH_GITHUB_SECRET=<github-oauth-client-secret>
AUTH_GITHUB_ALLOWED_USERS=<your-github-login[,other-logins...]>
AUTH_URL=https://polymarketspy.live
AUTH_TRUST_HOST=true

POSTGRES_DB=polymarket_copier
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<64-hex-random-string>
DATABASE_URL=postgresql://postgres:<same-password>@localhost:5432/polymarket_copier

REDIS_PASSWORD=<64-hex-random-string>
REDIS_URL=redis://:<same-password>@localhost:6379

POLYMARKET_FOLLOWER_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=...
POLYMARKET_API_SECRET=...
POLYMARKET_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=EOA
POLYMARKET_FUNDER_ADDRESS=

ALCHEMY_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/<your-key>

COPY_SYSTEM_ENABLED=false
DRY_RUN_MODE=false
```

Generate secrets:

- `openssl rand -hex 32` for `AUTH_SECRET`
- `openssl rand -hex 32` for `POSTGRES_PASSWORD`
- `openssl rand -hex 32` for `REDIS_PASSWORD`

### 4) Ensure Compose receives required worker vars

In `docker/docker-compose.yml`, under `worker.environment`, ensure:

- `POLYMARKET_FOLLOWER_PRIVATE_KEY`
- `POLYMARKET_CHAIN_ID`
- `POLYMARKET_SIGNATURE_TYPE`
- `POLYMARKET_FUNDER_ADDRESS`
- `EXECUTION_ENGINE_ENABLED`
- `DRY_RUN_MODE`
- `WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS` (optional, default `5000`)

Example:

```yaml
      POLYMARKET_FOLLOWER_PRIVATE_KEY: ${POLYMARKET_FOLLOWER_PRIVATE_KEY:-}
      POLYMARKET_CHAIN_ID: ${POLYMARKET_CHAIN_ID:-137}
      POLYMARKET_SIGNATURE_TYPE: ${POLYMARKET_SIGNATURE_TYPE:-EOA}
      POLYMARKET_FUNDER_ADDRESS: ${POLYMARKET_FUNDER_ADDRESS:-}
      EXECUTION_ENGINE_ENABLED: ${EXECUTION_ENGINE_ENABLED:-true}
      DRY_RUN_MODE: ${DRY_RUN_MODE:-false}
      WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS: ${WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS:-5000}
```

### 5) Bring up stack with explicit env file

Always pass `--env-file .env` to avoid shell-variable overrides:

```bash
cd ~/apps/polymarket-copier
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
docker compose --env-file .env -f docker/docker-compose.yml run --rm migrate pnpm --filter @copybot/db seed:global-runtime
docker compose --env-file .env -f docker/docker-compose.yml up -d worker web
docker compose --env-file .env -f docker/docker-compose.yml ps
```

Notes:

- `migrate` runs Prisma migrations automatically as part of `up -d --build`.
- `seed:global-runtime` is idempotent and initializes/updates the singleton runtime-config row used for dynamic DB-driven runtime controls.
- Running `up -d worker web` after seeding ensures both services are definitely on latest code/config state.

Verify resolved env values inside Compose:

```bash
docker compose --env-file .env -f docker/docker-compose.yml config | rg -n 'AUTH_GITHUB_ALLOWED_USERS|AUTH_URL|POLYMARKET_FOLLOWER_PRIVATE_KEY|POLYMARKET_SIGNATURE_TYPE|POLYMARKET_FUNDER_ADDRESS'
```

Health checks:

- `curl -sS http://127.0.0.1:8080/health`
- `curl -sS http://127.0.0.1:8080/api/health`
- `docker compose --env-file .env -f docker/docker-compose.yml logs --tail=200 worker`

Important DB note:
- If you change `POSTGRES_PASSWORD` after Postgres volume initialization, auth may fail.
- Either restore old password or reset volumes:
  - `docker compose --env-file .env -f docker/docker-compose.yml down -v`
  - then `up -d --build` again.

### 6) Configure host Nginx reverse proxy

Proxy public 80/443 to the Docker nginx on `127.0.0.1:8080` (not `:3000`):

```bash
sudo tee /etc/nginx/sites-available/polymarketspy.live >/dev/null <<'EOF'
server {
  listen 80;
  server_name polymarketspy.live www.polymarketspy.live;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
EOF

sudo ln -sf /etc/nginx/sites-available/polymarketspy.live /etc/nginx/sites-enabled/polymarketspy.live
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

### 7) Issue/attach TLS cert

```bash
sudo certbot --nginx -d polymarketspy.live -d www.polymarketspy.live
sudo certbot renew --dry-run
```

### 8) Remove duplicate vhosts if conflicts appear

If nginx warns about conflicting server names, keep only one active domain config:

```bash
sudo grep -RIn "polymarketspy.live\|www.polymarketspy.live" /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d
```

Remove duplicate symlink(s), then reload:

```bash
sudo rm -f /etc/nginx/sites-enabled/<duplicate-file>
sudo nginx -t
sudo systemctl reload nginx
```

### 9) Configure firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw deny 8080/tcp
sudo ufw deny 5432/tcp
sudo ufw deny 6379/tcp
sudo ufw enable
sudo ufw status verbose
```

### 10) Configure GitHub OAuth app

Set in GitHub OAuth app:

- Homepage URL: `https://polymarketspy.live`
- Callback URL: `https://polymarketspy.live/api/auth/callback/github`

After auth env updates:

- `docker compose --env-file .env -f docker/docker-compose.yml restart web`

### 11) Final validation

```bash
curl -I https://polymarketspy.live/
curl -I https://polymarketspy.live/login
curl -sS https://polymarketspy.live/api/health
```

Expected:
- `/` redirects to `/login` when not authenticated
- `/login` returns `200`
- `/api/health` returns JSON status `ok`

### 12) Runtime config ownership (Config page vs env)

Config-page changes now split into two DB-driven buckets:

- Profile-scoped (`copyProfile.config`): guardrails + sizing values per profile.
- Global runtime ops (`GlobalRuntimeConfig.config.ops`): operations-safe toggles/intervals shared by all profiles.

Runtime precedence:

- Profile execution/netting behavior: per-leader override (where supported) -> profile config -> env fallback.
- Global runtime ops: `GlobalRuntimeConfig.config.ops` -> env fallback.

These global runtime ops are live-editable without worker restart:

- `chainTriggerWsEnabled`
- `fillReconcileEnabled`
- `fillReconcileIntervalSeconds`
- `fillParseStarvationWindowSeconds`
- `fillParseStarvationMinMessages`
- `targetNettingEnabled`
- `targetNettingIntervalMs`
- `targetNettingTrackingErrorBps`
- `reconcileEngineEnabled`
- `reconcileStaleLeaderSyncSeconds`
- `reconcileStaleFollowerSyncSeconds`
- `reconcileGuardrailFailureCycleThreshold`
- `leaderTradesPollIntervalSeconds`
- `leaderTradesTakerOnly`
- `executionEngineEnabled`
- `panicMode`

These remain env-only by design:

- `DRY_RUN_MODE`
- credentials/URLs/signing identity fields
- low-level polling/backoff/cache/process internals

Quick verification after changing runtime ops:

```bash
curl -sS http://127.0.0.1:8080/api/v1/config
docker compose --env-file .env -f docker/docker-compose.yml logs --tail=200 worker
```

Look for:

- `runtimeOps` values matching your change in `/api/v1/config`
- `runtime_config.applied` log entries in worker logs within refresh cadence

### 13) Day-2 updates (recommended sequence)

```bash
cd ~/apps/polymarket-copier
git fetch --all --prune
git pull --ff-only
docker compose --env-file .env -f docker/docker-compose.yml up -d --build
docker compose --env-file .env -f docker/docker-compose.yml run --rm migrate pnpm --filter @copybot/db seed:global-runtime
docker compose --env-file .env -f docker/docker-compose.yml up -d worker web
docker compose --env-file .env -f docker/docker-compose.yml ps
curl -sS http://127.0.0.1:8080/api/v1/config
```

If your update does not change runtime-config schema/behavior, keeping the seed command is still safe because it is idempotent.

Logs:

- `docker compose --env-file .env -f docker/docker-compose.yml logs -f --tail=200`
- `docker compose --env-file .env -f docker/docker-compose.yml logs -f --tail=200 worker`
- `docker compose --env-file .env -f docker/docker-compose.yml logs -f --tail=200 web`

### 14) Security notes

- Never paste private keys in terminal screenshots/chat.
- If a key was exposed, rotate immediately and regenerate Polymarket API credentials.
- Keep `COPY_SYSTEM_ENABLED=false` until login, leader setup, and health checks are confirmed.
