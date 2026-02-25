# polymarket-copier

## Quick Start (Host-run Web/Worker + Docker infra)

1. Create local env file:
   - `cp .env.example .env`
2. Install dependencies:
   - `pnpm install`
3. Validate workspace:
   - `pnpm typecheck`
4. Start local dev infra only (Postgres + Redis):
   - `pnpm dev:infra:up`
5. Apply migrations:
   - `pnpm db:migrate`
6. Run web + worker from host:
   - `pnpm dev:web`
   - `pnpm dev:worker`

## Quick Start (Full Docker Stack)

1. Create local env file:
   - `cp .env.example .env`
2. Install dependencies:
   - `pnpm install`
3. Start full stack with Docker Compose:
   - `pnpm compose:up`

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
