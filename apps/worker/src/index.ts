import http from "node:http";
import { PrismaClient } from "@copybot/db";
import { parseWorkerEnv } from "@copybot/shared";
import { Wallet } from "ethers";
import {
  ChainTriggerPipeline,
  InMemoryTriggerDeduper,
  PrismaChainTriggerStore,
  RedisTriggerDeduper,
  type TriggerDeduper
} from "./chain/index.js";
import { DataApiClient, LeaderPoller, PrismaLeaderIngestionStore } from "./leader/index.js";
import {
  ClobRestClient,
  InMemoryMarketMetadataStore,
  MarketCache,
  MarketDataService,
  MarketWsClient,
  RedisMarketMetadataStore,
  type MarketMetadataRedisStore
} from "./market/index.js";
import { FillAttributionService, PrismaFillAttributionStore } from "./fills/index.js";
import {
  ClobExecutionClient,
  ExecutionEngine,
  PrismaExecutionStore,
  resolvePolymarketSigningConfig
} from "./execution/index.js";
import { PrismaTargetNettingStore, TargetNettingEngine } from "./target/index.js";
import { PrismaReconcileStore, ReconcileEngine } from "./reconcile/index.js";
import { workerLogger } from "./logger.js";

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return "******";
  }

  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

function parseTokenList(raw: string): string[] {
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function parseAddressList(raw: string): string[] {
  return raw
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter((address) => /^0x[a-f0-9]{40}$/.test(address));
}

async function bootstrap(): Promise<void> {
  const env = parseWorkerEnv();
  const prisma = new PrismaClient();
  await prisma.$connect();
  const startedAtMs = Date.now();
  let lastHeartbeatAtMs = startedAtMs;
  let redisMarketMetadataBackend: "REDIS" | "MEMORY" = "MEMORY";
  let redisTriggerDeduperBackend: "REDIS" | "MEMORY" = "MEMORY";

  let redisMetadataStore: MarketMetadataRedisStore;
  try {
    redisMetadataStore = await RedisMarketMetadataStore.connect(env.REDIS_URL);
    redisMarketMetadataBackend = "REDIS";
  } catch (error) {
    workerLogger.warn("bootstrap.redis_market_metadata_fallback", {
      message: "failed to connect to Redis market metadata store, falling back to in-memory cache",
      error: toErrorDetails(error)
    });
    redisMetadataStore = new InMemoryMarketMetadataStore();
  }

  let triggerDeduper: TriggerDeduper;
  try {
    triggerDeduper = await RedisTriggerDeduper.connect(env.REDIS_URL);
    redisTriggerDeduperBackend = "REDIS";
  } catch (error) {
    workerLogger.warn("bootstrap.chain_deduper_fallback", {
      message: "failed to connect to Redis chain deduper, falling back to in-memory dedupe",
      error: toErrorDetails(error)
    });
    triggerDeduper = new InMemoryTriggerDeduper();
  }

  await writeRedisSystemStatus(prisma, {
    marketMetadataBackend: redisMarketMetadataBackend,
    chainTriggerDeduperBackend: redisTriggerDeduperBackend
  });

  const clobRestClient = new ClobRestClient({ baseUrl: env.CLOB_REST_BASE_URL });
  const marketCache = new MarketCache({
    restClient: clobRestClient,
    redisStore: redisMetadataStore,
    config: {
      metadataTtlMs: env.MARKET_CACHE_METADATA_TTL_MS,
      wsPriceTtlMs: env.MARKET_CACHE_WS_PRICE_TTL_MS,
      restPriceTtlMs: env.MARKET_CACHE_REST_PRICE_TTL_MS,
      redisMetadataTtlSeconds: env.MARKET_CACHE_REDIS_TTL_SECONDS
    }
  });

  const marketWsClient = new MarketWsClient({
    url: env.CLOB_MARKET_WS_URL,
    onPriceUpdate: (update) => {
      marketCache.ingestWsPrice(update);
    },
    onTickSizeUpdate: async (update) => {
      await marketCache.ingestWsTickSize(update);
    }
  });

  const marketData = new MarketDataService({
    cache: marketCache,
    wsClient: marketWsClient,
    wsEnabled: env.MARKET_WS_ENABLED
  });

  marketData.start();

  const staticWatchedTokenIds = parseTokenList(env.MARKET_WATCH_TOKEN_IDS);
  const dynamicMarketWatchRefreshIntervalMs = 5_000;
  let lastWatchedTokenKey = "";

  async function refreshWatchedTokenUniverse(): Promise<void> {
    const [attemptTokens, pendingTokens] = await Promise.all([
      prisma.copyAttempt.findMany({
        where: {
          status: {
            in: ["PENDING", "RETRYING", "EXECUTING"]
          },
          decision: "PENDING"
        },
        select: {
          tokenId: true
        },
        distinct: ["tokenId"]
      }),
      prisma.pendingDelta.findMany({
        where: {
          status: {
            in: ["PENDING", "ELIGIBLE", "BLOCKED"]
          }
        },
        select: {
          tokenId: true
        },
        distinct: ["tokenId"]
      })
    ]);

    const tokenSet = new Set<string>(staticWatchedTokenIds);
    for (const row of attemptTokens) {
      if (row.tokenId) {
        tokenSet.add(row.tokenId);
      }
    }
    for (const row of pendingTokens) {
      if (row.tokenId) {
        tokenSet.add(row.tokenId);
      }
    }

    const nextWatchedTokens = [...tokenSet].sort();
    const nextKey = nextWatchedTokens.join(",");
    if (nextKey === lastWatchedTokenKey) {
      return;
    }

    await marketData.setWatchedTokenIds(nextWatchedTokens);
    lastWatchedTokenKey = nextKey;
  }

  try {
    await refreshWatchedTokenUniverse();
  } catch (error) {
    workerLogger.warn("bootstrap.market_watch_refresh_failed", {
      error: toErrorDetails(error)
    });
  }

  setInterval(() => {
    void refreshWatchedTokenUniverse().catch((error) => {
      workerLogger.warn("market.watch_refresh_failed", {
        error: toErrorDetails(error)
      });
    });
  }, dynamicMarketWatchRefreshIntervalMs);

  const dataApiClient = new DataApiClient({
    baseUrl: env.DATA_API_BASE_URL
  });

  const leaderPoller = new LeaderPoller({
    dataApi: dataApiClient,
    store: new PrismaLeaderIngestionStore(prisma),
    config: {
      positionsIntervalMs: env.RECONCILE_INTERVAL_SECONDS * 1000,
      tradesIntervalMs: env.LEADER_TRADES_POLL_INTERVAL_SECONDS * 1000,
      tradesTakerOnly: env.LEADER_TRADES_TAKER_ONLY,
      pageLimit: env.LEADER_POLL_PAGE_LIMIT,
      batchSize: env.LEADER_POLL_BATCH_SIZE,
      maxRetries: env.LEADER_POLL_MAX_RETRIES,
      backoffBaseMs: env.LEADER_POLL_BACKOFF_BASE_MS,
      backoffMaxMs: env.LEADER_POLL_BACKOFF_MAX_MS,
      maxPagesPerLeader: env.LEADER_POLL_MAX_PAGES_PER_LEADER
    }
  });
  leaderPoller.start();

  const exchangeContracts = parseAddressList(env.POLYMARKET_EXCHANGE_CONTRACTS);
  const chainPipeline = new ChainTriggerPipeline({
    store: new PrismaChainTriggerStore(prisma),
    deduper: triggerDeduper,
    config: {
      enabled: env.CHAIN_TRIGGER_WS_ENABLED && env.TRADE_DETECTION_ENABLED,
      wsUrl: env.ALCHEMY_WS_URL,
      exchangeContracts,
      dedupeTtlSeconds: env.CHAIN_TRIGGER_DEDUPE_TTL_SECONDS,
      walletRefreshIntervalMs: env.CHAIN_TRIGGER_WALLET_REFRESH_INTERVAL_MS,
      reconcileQueueMaxSize: env.CHAIN_TRIGGER_RECONCILE_QUEUE_MAX_SIZE
    }
  });
  await chainPipeline.start();

  const targetNetting = new TargetNettingEngine({
    store: new PrismaTargetNettingStore(prisma),
    config: {
      enabled: env.TARGET_NETTING_ENABLED,
      intervalMs: env.TARGET_NETTING_INTERVAL_MS,
      minNotionalUsd: env.MIN_NOTIONAL_PER_ORDER_USD,
      trackingErrorBps: env.TARGET_NETTING_TRACKING_ERROR_BPS,
      maxRetriesPerAttempt: env.MAX_RETRIES_PER_ATTEMPT,
      attemptExpirationSeconds: env.ATTEMPT_EXPIRATION_SECONDS
    },
    resolvePriceSnapshot: async (tokenId, marketId) => {
      const book = await marketData.getBookState(tokenId);
      const topOfBookPrice = book.bestAsk ?? book.bestBid;
      return {
        tokenId,
        marketId: book.marketId ?? marketId,
        midPrice: book.midPrice,
        topOfBookPrice,
        minOrderSize: book.minOrderSize,
        stale: book.isStale,
        source: toTargetPriceSource(book.priceSource)
      };
    }
  });
  targetNetting.start();

  const signingConfig = resolvePolymarketSigningConfig(env, {
    required: env.EXECUTION_ENGINE_ENABLED
  });
  const polymarketSignerAddress = deriveSignerAddress(signingConfig?.privateKey);

  if (signingConfig?.signatureTypeName === "EOA" && !signingConfig.funderAddress) {
    workerLogger.warn("worker.polymarket_signing_mode_warning", {
      message:
        "Using EOA signing without funderAddress. If your funded Polymarket account is proxy/safe-backed, set POLYMARKET_SIGNATURE_TYPE and POLYMARKET_FUNDER_ADDRESS.",
      signerAddress: polymarketSignerAddress,
      signatureType: signingConfig.signatureTypeName
    });
  }

  const executionEngine = new ExecutionEngine({
    store: new PrismaExecutionStore(prisma),
    venueClient: new ClobExecutionClient({
      baseUrl: env.CLOB_REST_BASE_URL,
      apiKey: env.POLYMARKET_API_KEY,
      apiSecret: env.POLYMARKET_API_SECRET,
      passphrase: env.POLYMARKET_PASSPHRASE,
      privateKey: signingConfig?.privateKey,
      chainId: signingConfig?.chainId,
      signatureType: signingConfig?.signatureType,
      funderAddress: signingConfig?.funderAddress
    }),
    config: {
      enabled: env.EXECUTION_ENGINE_ENABLED,
      intervalMs: env.EXECUTION_INTERVAL_MS,
      maxAttemptsPerRun: env.EXECUTION_MAX_ATTEMPTS_PER_RUN,
      retryBackoffBaseMs: env.EXECUTION_RETRY_BACKOFF_BASE_MS,
      retryBackoffMaxMs: env.EXECUTION_RETRY_BACKOFF_MAX_MS,
      dryRunMode: env.DRY_RUN_MODE,
      copySystemEnabled: env.COPY_SYSTEM_ENABLED,
      panicMode: env.PANIC_MODE,
      minNotionalUsd: env.MIN_NOTIONAL_PER_ORDER_USD,
      maxWorseningBuyUsd: env.MAX_WORSENING_BUY_USD,
      maxWorseningSellUsd: env.MAX_WORSENING_SELL_USD,
      maxSlippageBps: env.MAX_SLIPPAGE_BPS,
      maxSpreadUsd: env.MAX_SPREAD_USD,
      maxPricePerShare: env.MAX_PRICE_PER_SHARE_USD,
      maxDailyNotionalTurnoverUsd: env.MAX_DAILY_NOTIONAL_TURNOVER_USD,
      maxHourlyNotionalTurnoverUsd: env.MAX_HOURLY_NOTIONAL_TURNOVER_USD,
      cooldownPerMarketSeconds: env.COOLDOWN_PER_MARKET_SECONDS
    },
    getMarketSnapshot: async (tokenId) => {
      const state = await marketData.getBookState(tokenId);
      return {
        tokenId: state.tokenId,
        marketId: state.marketId,
        bestBid: state.bestBid,
        bestAsk: state.bestAsk,
        midPrice: state.midPrice,
        tickSize: state.tickSize,
        minOrderSize: state.minOrderSize,
        negRisk: state.negRisk,
        isStale: state.isStale,
        priceSource: state.priceSource,
        wsConnected: state.wsConnected
      };
    },
    fetchOrderBook: async (tokenId) => {
      const book = await clobRestClient.fetchBook(tokenId);
      return {
        tokenId: book.asset_id,
        marketId: book.market,
        bids: book.bids,
        asks: book.asks
      };
    }
  });
  executionEngine.start();

  const fillAttribution = new FillAttributionService({
    store: new PrismaFillAttributionStore(prisma),
    config: {
      enabled: env.USER_CHANNEL_WS_ENABLED,
      url: env.CLOB_USER_WS_URL,
      apiKey: env.POLYMARKET_API_KEY,
      apiSecret: env.POLYMARKET_API_SECRET,
      passphrase: env.POLYMARKET_PASSPHRASE
    }
  });
  fillAttribution.start();

  const reconcileEngine = new ReconcileEngine({
    store: new PrismaReconcileStore({
      prisma,
      dataApi: dataApiClient,
      dataApiPageLimit: env.LEADER_POLL_PAGE_LIMIT,
      dataApiMaxPages: env.LEADER_POLL_MAX_PAGES_PER_LEADER,
      followerAddressFallback: signingConfig?.funderAddress ?? polymarketSignerAddress ?? undefined
    }),
    config: {
      enabled: env.RECONCILE_ENGINE_ENABLED,
      intervalMs: env.RECONCILE_INTERVAL_SECONDS * 1000,
      staleLeaderSyncMs: env.RECONCILE_STALE_LEADER_SYNC_SECONDS * 1000,
      staleFollowerSyncMs: env.RECONCILE_STALE_FOLLOWER_SYNC_SECONDS * 1000,
      guardrailFailureCycleThreshold: env.RECONCILE_GUARDRAIL_FAILURE_CYCLE_THRESHOLD
    },
    leaderPoller: {
      runPositionsPoll: () => leaderPoller.runPositionsPoll(),
      getStatus: () => leaderPoller.getStatus()
    },
    targetNetting: {
      run: () => targetNetting.run(),
      getStatus: () => targetNetting.getStatus()
    },
    getMarketDataStatus: () => marketData.getStatus(),
    getExecutionStatus: () => executionEngine.getStatus()
  });
  reconcileEngine.start();

  const heartbeat = setInterval(() => {
    lastHeartbeatAtMs = Date.now();
  }, env.WORKER_HEARTBEAT_INTERVAL_MS);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "worker",
          now: new Date().toISOString(),
          startedAt: new Date(startedAtMs).toISOString(),
          lastHeartbeatAt: new Date(lastHeartbeatAtMs).toISOString(),
          marketData: marketData.getStatus(),
          leaderIngestion: leaderPoller.getStatus(),
          chainTriggers: chainPipeline.getStatus(),
          targetNetting: targetNetting.getStatus(),
          execution: executionEngine.getStatus(),
          userChannel: fillAttribution.getStatus(),
          reconcile: reconcileEngine.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/leader-ingestion/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          leaderIngestion: leaderPoller.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/chain-triggers/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          chainTriggers: chainPipeline.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/chain-triggers/reconcile-queue") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          count: chainPipeline.getPendingReconcileTasks().length,
          tasks: chainPipeline.getPendingReconcileTasks()
        })
      );
      return;
    }

    if (url.pathname === "/target-netting/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          targetNetting: targetNetting.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/execution/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          execution: executionEngine.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/user-channel/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          userChannel: fillAttribution.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/reconcile/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          reconcile: reconcileEngine.getStatus()
        })
      );
      return;
    }

    if (url.pathname === "/market/books") {
      const tokenIds = parseTokenList(url.searchParams.get("token_ids") ?? "");
      const books =
        tokenIds.length > 0
          ? await Promise.all(tokenIds.map((tokenId) => marketData.getBookState(tokenId)))
          : await marketData.getWatchedBookStates();

      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          count: books.length,
          books
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ status: "not_found" }));
  }

  server.listen(env.WORKER_HEALTH_PORT, "0.0.0.0");
  workerLogger.info("worker.health_server_started", {
    port: env.WORKER_HEALTH_PORT
  });

  const startupConfig = {
    nodeEnv: env.NODE_ENV,
    copySystemEnabled: env.COPY_SYSTEM_ENABLED,
    tradeDetectionEnabled: env.TRADE_DETECTION_ENABLED,
    userChannelWsEnabled: env.USER_CHANNEL_WS_ENABLED,
    reconcileIntervalSeconds: env.RECONCILE_INTERVAL_SECONDS,
    minNotionalPerOrderUsd: env.MIN_NOTIONAL_PER_ORDER_USD,
    maxExposurePerLeaderUsd: env.MAX_EXPOSURE_PER_LEADER_USD,
    maxExposurePerMarketOutcomeUsd: env.MAX_EXPOSURE_PER_MARKET_OUTCOME_USD,
    maxHourlyNotionalTurnoverUsd: env.MAX_HOURLY_NOTIONAL_TURNOVER_USD,
    maxDailyNotionalTurnoverUsd: env.MAX_DAILY_NOTIONAL_TURNOVER_USD,
    maxRetriesPerAttempt: env.MAX_RETRIES_PER_ATTEMPT,
    clobRestBaseUrl: env.CLOB_REST_BASE_URL,
    clobMarketWsUrl: maskSecret(env.CLOB_MARKET_WS_URL),
    clobUserWsUrl: maskSecret(env.CLOB_USER_WS_URL),
    marketWsEnabled: env.MARKET_WS_ENABLED,
    marketWatchedTokensCount: staticWatchedTokenIds.length,
    marketWatchRefreshIntervalMs: dynamicMarketWatchRefreshIntervalMs,
    dataApiBaseUrl: env.DATA_API_BASE_URL,
    chainTriggerWsEnabled: env.CHAIN_TRIGGER_WS_ENABLED,
    chainTriggerExchangeContracts: exchangeContracts,
    chainTriggerDedupeTtlSeconds: env.CHAIN_TRIGGER_DEDUPE_TTL_SECONDS,
    chainTriggerWalletRefreshIntervalMs: env.CHAIN_TRIGGER_WALLET_REFRESH_INTERVAL_MS,
    chainTriggerReconcileQueueMaxSize: env.CHAIN_TRIGGER_RECONCILE_QUEUE_MAX_SIZE,
    targetNettingEnabled: env.TARGET_NETTING_ENABLED,
    targetNettingIntervalMs: env.TARGET_NETTING_INTERVAL_MS,
    targetNettingTrackingErrorBps: env.TARGET_NETTING_TRACKING_ERROR_BPS,
    reconcileEngineEnabled: env.RECONCILE_ENGINE_ENABLED,
    reconcileStaleLeaderSyncSeconds: env.RECONCILE_STALE_LEADER_SYNC_SECONDS,
    reconcileStaleFollowerSyncSeconds: env.RECONCILE_STALE_FOLLOWER_SYNC_SECONDS,
    reconcileGuardrailFailureCycleThreshold: env.RECONCILE_GUARDRAIL_FAILURE_CYCLE_THRESHOLD,
    executionEngineEnabled: env.EXECUTION_ENGINE_ENABLED,
    executionIntervalMs: env.EXECUTION_INTERVAL_MS,
    executionMaxAttemptsPerRun: env.EXECUTION_MAX_ATTEMPTS_PER_RUN,
    executionRetryBackoffBaseMs: env.EXECUTION_RETRY_BACKOFF_BASE_MS,
    executionRetryBackoffMaxMs: env.EXECUTION_RETRY_BACKOFF_MAX_MS,
    executionDryRunMode: env.DRY_RUN_MODE,
    polymarketSignerAddress,
    polymarketSignatureType: signingConfig?.signatureTypeName ?? null,
    polymarketFunderAddress: signingConfig?.funderAddress ?? null,
    leaderTradesPollIntervalSeconds: env.LEADER_TRADES_POLL_INTERVAL_SECONDS,
    leaderTradesTakerOnly: env.LEADER_TRADES_TAKER_ONLY,
    leaderPollPageLimit: env.LEADER_POLL_PAGE_LIMIT,
    leaderPollBatchSize: env.LEADER_POLL_BATCH_SIZE,
    leaderPollMaxRetries: env.LEADER_POLL_MAX_RETRIES,
    leaderPollBackoffBaseMs: env.LEADER_POLL_BACKOFF_BASE_MS,
    leaderPollBackoffMaxMs: env.LEADER_POLL_BACKOFF_MAX_MS,
    leaderPollMaxPagesPerLeader: env.LEADER_POLL_MAX_PAGES_PER_LEADER,
    marketCacheMetadataTtlMs: env.MARKET_CACHE_METADATA_TTL_MS,
    marketCacheWsPriceTtlMs: env.MARKET_CACHE_WS_PRICE_TTL_MS,
    marketCacheRestPriceTtlMs: env.MARKET_CACHE_REST_PRICE_TTL_MS,
    marketCacheRedisTtlSeconds: env.MARKET_CACHE_REDIS_TTL_SECONDS,
    workerHealthPort: env.WORKER_HEALTH_PORT,
    workerHeartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
    alchemyWsUrl: maskSecret(env.ALCHEMY_WS_URL),
    databaseUrl: maskSecret(env.DATABASE_URL),
    redisUrl: maskSecret(env.REDIS_URL)
  };

  workerLogger.info("worker.config_validated", startupConfig);

  const shutdown = async () => {
    clearInterval(heartbeat);
    await writeRedisSystemStatus(
      prisma,
      {
        marketMetadataBackend: redisMarketMetadataBackend,
        chainTriggerDeduperBackend: redisTriggerDeduperBackend
      },
      "DOWN"
    );
    reconcileEngine.stop();
    fillAttribution.stop();
    executionEngine.stop();
    targetNetting.stop();
    chainPipeline.stop();
    leaderPoller.stop();
    marketData.stop();
    await triggerDeduper.disconnect();
    await redisMetadataStore.disconnect();
    await prisma.$disconnect();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function toTargetPriceSource(priceSource: "WS" | "REST" | "NONE"): "MARKET_WS" | "MARKET_REST" | "UNKNOWN" {
  if (priceSource === "WS") {
    return "MARKET_WS";
  }
  if (priceSource === "REST") {
    return "MARKET_REST";
  }
  return "UNKNOWN";
}

function deriveSignerAddress(privateKey: string | undefined): string | null {
  if (!privateKey) {
    return null;
  }

  try {
    return new Wallet(privateKey).address;
  } catch {
    return null;
  }
}

void bootstrap().catch((error) => {
  workerLogger.error("worker.bootstrap_failed", {
    error: toErrorDetails(error)
  });
  process.exit(1);
});

function toErrorDetails(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return {
    message: String(error)
  };
}

async function writeRedisSystemStatus(
  prisma: PrismaClient,
  details: {
    marketMetadataBackend: "REDIS" | "MEMORY";
    chainTriggerDeduperBackend: "REDIS" | "MEMORY";
  },
  forcedStatus?: "OK" | "DOWN"
): Promise<void> {
  const status =
    forcedStatus ??
    (details.marketMetadataBackend === "REDIS" && details.chainTriggerDeduperBackend === "REDIS" ? "OK" : "DOWN");

  try {
    await prisma.systemStatus.upsert({
      where: {
        component: "REDIS"
      },
      create: {
        component: "REDIS",
        status,
        lastEventAt: new Date(),
        details: {
          marketMetadataBackend: details.marketMetadataBackend,
          chainTriggerDeduperBackend: details.chainTriggerDeduperBackend,
          queueCounts: {}
        }
      },
      update: {
        status,
        lastEventAt: new Date(),
        details: {
          marketMetadataBackend: details.marketMetadataBackend,
          chainTriggerDeduperBackend: details.chainTriggerDeduperBackend,
          queueCounts: {}
        }
      }
    });
  } catch (error) {
    workerLogger.warn("status.redis_status_write_failed", {
      error: toErrorDetails(error)
    });
  }
}
