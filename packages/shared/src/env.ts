import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return value;
}, z.boolean());

const optionalPositiveNumberFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" && value.trim().length === 0) {
    return undefined;
  }

  return value;
}, z.coerce.number().positive().optional());

function normalizeSignatureType(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }

  const value = raw.trim();
  if (value.length === 0) {
    return value;
  }

  if (value === "0") {
    return "EOA";
  }
  if (value === "1") {
    return "POLY_PROXY";
  }
  if (value === "2") {
    return "POLY_GNOSIS_SAFE";
  }

  return value.toUpperCase();
}

export const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  POLYMARKET_API_KEY: z.string().min(1),
  POLYMARKET_API_SECRET: z.string().min(1),
  POLYMARKET_PASSPHRASE: z.string().min(1),
  POLYMARKET_FOLLOWER_PRIVATE_KEY: z.string().min(1).optional(),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLYMARKET_SIGNATURE_TYPE: z.preprocess(
    normalizeSignatureType,
    z.enum(["EOA", "POLY_PROXY", "POLY_GNOSIS_SAFE"]).default("EOA")
  ),
  POLYMARKET_FUNDER_ADDRESS: z.string().min(1).optional(),
  ALCHEMY_WS_URL: z.string().url(),
  DATA_API_BASE_URL: z.string().url().default("https://data-api.polymarket.com"),
  CLOB_REST_BASE_URL: z.string().url().default("https://clob.polymarket.com"),
  CLOB_MARKET_WS_URL: z.string().url().default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  CLOB_USER_WS_URL: z.string().url().default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
  COPY_SYSTEM_ENABLED: booleanFromEnv.default(false),
  TRADE_DETECTION_ENABLED: booleanFromEnv.default(true),
  USER_CHANNEL_WS_ENABLED: booleanFromEnv.default(true),
  CHAIN_TRIGGER_WS_ENABLED: booleanFromEnv.default(true),
  POLYMARKET_EXCHANGE_CONTRACTS: z
    .string()
    .default("0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E,0xC5d563A36AE78145C45a50134d48A1215220f80a"),
  CHAIN_TRIGGER_DEDUPE_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  CHAIN_TRIGGER_WALLET_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  CHAIN_TRIGGER_RECONCILE_QUEUE_MAX_SIZE: z.coerce.number().int().positive().default(1000),
  MARKET_WS_ENABLED: booleanFromEnv.default(false),
  EXECUTION_ENGINE_ENABLED: booleanFromEnv.default(true),
  EXECUTION_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  EXECUTION_MAX_ATTEMPTS_PER_RUN: z.coerce.number().int().positive().default(25),
  EXECUTION_RETRY_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(5000),
  EXECUTION_RETRY_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300000),
  DRY_RUN_MODE: booleanFromEnv.default(false),
  TARGET_NETTING_ENABLED: booleanFromEnv.default(true),
  TARGET_NETTING_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  TARGET_NETTING_TRACKING_ERROR_BPS: z.coerce.number().int().nonnegative().default(0),
  MARKET_WATCH_TOKEN_IDS: z.string().default(""),
  PANIC_MODE: booleanFromEnv.default(false),
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  RECONCILE_ENGINE_ENABLED: booleanFromEnv.default(true),
  RECONCILE_STALE_LEADER_SYNC_SECONDS: z.coerce.number().int().positive().default(180),
  RECONCILE_STALE_FOLLOWER_SYNC_SECONDS: z.coerce.number().int().positive().default(180),
  RECONCILE_GUARDRAIL_FAILURE_CYCLE_THRESHOLD: z.coerce.number().int().positive().default(5),
  MARKET_CACHE_METADATA_TTL_MS: z.coerce.number().int().positive().default(300000),
  MARKET_CACHE_WS_PRICE_TTL_MS: z.coerce.number().int().positive().default(15000),
  MARKET_CACHE_REST_PRICE_TTL_MS: z.coerce.number().int().positive().default(45000),
  MARKET_CACHE_REDIS_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  LEADER_TRADES_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(30),
  LEADER_TRADES_TAKER_ONLY: booleanFromEnv.default(false),
  LEADER_POLL_PAGE_LIMIT: z.coerce.number().int().positive().default(100),
  LEADER_POLL_BATCH_SIZE: z.coerce.number().int().positive().default(5),
  LEADER_POLL_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  LEADER_POLL_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
  LEADER_POLL_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(15000),
  LEADER_POLL_MAX_PAGES_PER_LEADER: z.coerce.number().int().positive().default(20),
  MIN_NOTIONAL_PER_ORDER_USD: z.coerce.number().positive().default(1),
  MAX_WORSENING_BUY_USD: z.coerce.number().nonnegative().default(0.03),
  MAX_WORSENING_SELL_USD: z.coerce.number().nonnegative().default(0.06),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().nonnegative().default(200),
  MAX_SPREAD_USD: z.coerce.number().nonnegative().default(0.03),
  MAX_PRICE_PER_SHARE_USD: optionalPositiveNumberFromEnv,
  ATTEMPT_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(7200),
  COOLDOWN_PER_MARKET_SECONDS: z.coerce.number().int().nonnegative().default(5),
  MAX_EXPOSURE_PER_LEADER_USD: z.coerce.number().positive().default(100),
  MAX_EXPOSURE_PER_MARKET_OUTCOME_USD: z.coerce.number().positive().default(50),
  MAX_HOURLY_NOTIONAL_TURNOVER_USD: z.coerce.number().positive().default(25),
  MAX_DAILY_NOTIONAL_TURNOVER_USD: z.coerce.number().positive().default(100),
  MAX_RETRIES_PER_ATTEMPT: z.coerce.number().int().nonnegative().default(20),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(4001),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000)
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export function parseWorkerEnv(input: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return WorkerEnvSchema.parse(normalizeWorkerEnvInput(input));
}

function normalizeWorkerEnvInput(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...input };

  normalized.POLYMARKET_FOLLOWER_PRIVATE_KEY ??=
    input.POLYMARKET_FOLLOWER_PRIVATE_KEY ?? input.FOLLOWER_PRIVATE_KEY ?? input.PRIVATE_KEY;

  normalized.POLYMARKET_CHAIN_ID ??= input.POLYMARKET_CHAIN_ID ?? input.CHAIN_ID;

  if (typeof input.POLYMARKET_FUNDER_ADDRESS === "string") {
    const trimmed = input.POLYMARKET_FUNDER_ADDRESS.trim();
    normalized.POLYMARKET_FUNDER_ADDRESS = trimmed.length > 0 ? trimmed : undefined;
  }

  return normalized;
}
