FROM node:22-bookworm-slim

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json

RUN pnpm install --frozen-lockfile

COPY . .

# Prisma client must exist for runtime imports in worker/web.
RUN pnpm --filter @copybot/db generate

# Build Next.js for production runtime (web service uses `next start`).
RUN AUTH_SECRET=build-secret \
  AUTH_GITHUB_ID=build-id \
  AUTH_GITHUB_SECRET=build-secret \
  AUTH_GITHUB_ALLOWED_USERS=build-user \
  AUTH_URL=http://localhost:3000 \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/polymarket_copier \
  REDIS_URL=redis://localhost:6379 \
  pnpm --filter @copybot/web build
