import http from "node:http";
import { Prisma, PrismaClient } from "@copybot/db";
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
import { ClobFillTradeHistoryClient, FillAttributionService, FillReconcileService, PrismaFillAttributionStore } from "./fills/index.js";
import {
  ClobExecutionClient,
  ExecutionEngine,
  PrismaExecutionStore,
  resolvePolymarketSigningConfig
} from "./execution/index.js";
import { PrismaTargetNettingStore, TargetNettingEngine, type PriceSnapshot } from "./target/index.js";
import { PrismaReconcileStore, ReconcileEngine } from "./reconcile/index.js";
import { workerLogger } from "./logger.js";
import { runHistoryPruneSafely } from "./current-state/prune.js";
import { writeDashboardStatusSummary } from "./dashboard-status/store.js";
import {
  readGlobalRuntimeConfigOverrides,
  resolveEffectiveChainTriggerEnabled,
  resolveEffectiveGlobalRuntimeConfig,
  type EffectiveGlobalRuntimeConfig
} from "./config/global-runtime-config.js";

const GLOBAL_RUNTIME_CONFIG_ID = "global";

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
  const watchedBookRefreshIntervalMs = Math.max(
    15_000,
    Math.min(env.MARKET_CACHE_REST_PRICE_TTL_MS, env.MARKET_CACHE_METADATA_TTL_MS)
  );
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

  setInterval(() => {
    void marketData.refreshWatchedBooks().catch((error) => {
      workerLogger.warn("market.book_refresh_failed", {
        error: toErrorDetails(error)
      });
    });
  }, watchedBookRefreshIntervalMs);

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
    },
    resolvePriceSnapshots: async (requests) => {
      const bookStates = await marketData.getBookStates(requests.map((request) => request.tokenId));
      const snapshots = new Map<string, PriceSnapshot>();
      for (const request of requests) {
        const book = bookStates.get(request.tokenId);
        if (!book) {
          continue;
        }
        const topOfBookPrice = book.bestAsk ?? book.bestBid;
        snapshots.set(request.tokenId, {
          tokenId: request.tokenId,
          marketId: book.marketId ?? request.marketId,
          midPrice: book.midPrice,
          topOfBookPrice,
          minOrderSize: book.minOrderSize,
          stale: book.isStale,
          source: toTargetPriceSource(book.priceSource)
        });
      }
      return snapshots;
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
      minBookDepthForSizeEnabled: env.MIN_BOOK_DEPTH_FOR_SIZE_ENABLED,
      maxOpenOrders: env.MAX_OPEN_ORDERS,
      maxExposurePerLeaderUsd: env.MAX_EXPOSURE_PER_LEADER_USD,
      maxExposurePerMarketOutcomeUsd: env.MAX_EXPOSURE_PER_MARKET_OUTCOME_USD,
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

  const fillStore = new PrismaFillAttributionStore(prisma);
  const parseStarvationCheckIntervalMs = Math.max(
    5_000,
    Math.min(30_000, Math.trunc((env.FILL_PARSE_STARVATION_WINDOW_SECONDS * 1000) / 5))
  );

  const fillAttribution = new FillAttributionService({
    store: fillStore,
    config: {
      enabled: env.USER_CHANNEL_WS_ENABLED,
      url: env.CLOB_USER_WS_URL,
      apiKey: env.POLYMARKET_API_KEY,
      apiSecret: env.POLYMARKET_API_SECRET,
      passphrase: env.POLYMARKET_PASSPHRASE,
      parseStarvationWindowMs: env.FILL_PARSE_STARVATION_WINDOW_SECONDS * 1000,
      parseStarvationMinMessages: env.FILL_PARSE_STARVATION_MIN_MESSAGES,
      parseStarvationCheckIntervalMs
    }
  });
  fillAttribution.start();

  const fillReconcile = new FillReconcileService({
    store: fillStore,
    tradeClient: new ClobFillTradeHistoryClient({
      baseUrl: env.CLOB_REST_BASE_URL,
      chainId: toSupportedChainId(env.POLYMARKET_CHAIN_ID),
      creds: {
        key: env.POLYMARKET_API_KEY,
        secret: env.POLYMARKET_API_SECRET,
        passphrase: env.POLYMARKET_PASSPHRASE
      },
      privateKey: signingConfig?.privateKey,
      signatureType: signingConfig?.signatureType,
      funderAddress: signingConfig?.funderAddress
    }),
    config: {
      enabled: env.FILL_RECONCILE_ENABLED,
      intervalMs: env.FILL_RECONCILE_INTERVAL_SECONDS * 1000,
      defaultLookbackDays: env.FILL_BACKFILL_DEFAULT_LOOKBACK_DAYS,
      maxPagesPerAddress: env.LEADER_POLL_MAX_PAGES_PER_LEADER
    },
    preferredMakerAddresses: [
      env.POLYMARKET_FUNDER_ADDRESS ?? "",
      polymarketSignerAddress ?? ""
    ]
  });
  fillReconcile.start();

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

  const runtimeConfigBaseline: EffectiveGlobalRuntimeConfig = {
    tradeDetectionEnabled: env.TRADE_DETECTION_ENABLED,
    userChannelWsEnabled: env.USER_CHANNEL_WS_ENABLED,
    reconcileIntervalSeconds: env.RECONCILE_INTERVAL_SECONDS,
    runtimeOps: {
      chainTriggerWsEnabled: env.CHAIN_TRIGGER_WS_ENABLED,
      fillReconcileEnabled: env.FILL_RECONCILE_ENABLED,
      fillReconcileIntervalSeconds: env.FILL_RECONCILE_INTERVAL_SECONDS,
      fillParseStarvationWindowSeconds: env.FILL_PARSE_STARVATION_WINDOW_SECONDS,
      fillParseStarvationMinMessages: env.FILL_PARSE_STARVATION_MIN_MESSAGES,
      targetNettingEnabled: env.TARGET_NETTING_ENABLED,
      targetNettingIntervalMs: env.TARGET_NETTING_INTERVAL_MS,
      targetNettingTrackingErrorBps: env.TARGET_NETTING_TRACKING_ERROR_BPS,
      reconcileEngineEnabled: env.RECONCILE_ENGINE_ENABLED,
      reconcileStaleLeaderSyncSeconds: env.RECONCILE_STALE_LEADER_SYNC_SECONDS,
      reconcileStaleFollowerSyncSeconds: env.RECONCILE_STALE_FOLLOWER_SYNC_SECONDS,
      reconcileGuardrailFailureCycleThreshold: env.RECONCILE_GUARDRAIL_FAILURE_CYCLE_THRESHOLD,
      leaderTradesPollIntervalSeconds: env.LEADER_TRADES_POLL_INTERVAL_SECONDS,
      leaderTradesTakerOnly: env.LEADER_TRADES_TAKER_ONLY,
      executionEngineEnabled: env.EXECUTION_ENGINE_ENABLED,
      panicMode: env.PANIC_MODE
    }
  };
  let runtimeConfig = { ...runtimeConfigBaseline };

  async function applyRuntimeConfig(next: EffectiveGlobalRuntimeConfig, source: "bootstrap" | "refresh"): Promise<void> {
    const changed: Record<string, { from: number | boolean; to: number | boolean }> = {};
    const previousChainTriggerEnabled = resolveEffectiveChainTriggerEnabled(runtimeConfig);
    const nextChainTriggerEnabled = resolveEffectiveChainTriggerEnabled(next);

    if (next.tradeDetectionEnabled !== runtimeConfig.tradeDetectionEnabled) {
      changed.tradeDetectionEnabled = {
        from: runtimeConfig.tradeDetectionEnabled,
        to: next.tradeDetectionEnabled
      };
    }

    if (next.userChannelWsEnabled !== runtimeConfig.userChannelWsEnabled) {
      fillAttribution.setEnabled(next.userChannelWsEnabled);
      changed.userChannelWsEnabled = {
        from: runtimeConfig.userChannelWsEnabled,
        to: next.userChannelWsEnabled
      };
    }

    if (next.reconcileIntervalSeconds !== runtimeConfig.reconcileIntervalSeconds) {
      const intervalMs = next.reconcileIntervalSeconds * 1000;
      leaderPoller.setPositionsIntervalMs(intervalMs);
      reconcileEngine.setIntervalMs(intervalMs);
      changed.reconcileIntervalSeconds = {
        from: runtimeConfig.reconcileIntervalSeconds,
        to: next.reconcileIntervalSeconds
      };
    }

    if (next.runtimeOps.chainTriggerWsEnabled !== runtimeConfig.runtimeOps.chainTriggerWsEnabled) {
      changed.opsChainTriggerWsEnabled = {
        from: runtimeConfig.runtimeOps.chainTriggerWsEnabled,
        to: next.runtimeOps.chainTriggerWsEnabled
      };
    }

    if (nextChainTriggerEnabled !== previousChainTriggerEnabled) {
      await chainPipeline.setEnabled(nextChainTriggerEnabled);
    }

    if (next.runtimeOps.fillReconcileEnabled !== runtimeConfig.runtimeOps.fillReconcileEnabled) {
      fillReconcile.setEnabled(next.runtimeOps.fillReconcileEnabled);
      changed.opsFillReconcileEnabled = {
        from: runtimeConfig.runtimeOps.fillReconcileEnabled,
        to: next.runtimeOps.fillReconcileEnabled
      };
    }

    if (next.runtimeOps.fillReconcileIntervalSeconds !== runtimeConfig.runtimeOps.fillReconcileIntervalSeconds) {
      fillReconcile.setIntervalMs(next.runtimeOps.fillReconcileIntervalSeconds * 1000);
      changed.opsFillReconcileIntervalSeconds = {
        from: runtimeConfig.runtimeOps.fillReconcileIntervalSeconds,
        to: next.runtimeOps.fillReconcileIntervalSeconds
      };
    }

    if (
      next.runtimeOps.fillParseStarvationWindowSeconds !== runtimeConfig.runtimeOps.fillParseStarvationWindowSeconds ||
      next.runtimeOps.fillParseStarvationMinMessages !== runtimeConfig.runtimeOps.fillParseStarvationMinMessages
    ) {
      fillAttribution.setParseStarvationConfig({
        windowSeconds: next.runtimeOps.fillParseStarvationWindowSeconds,
        minMessages: next.runtimeOps.fillParseStarvationMinMessages
      });
      if (next.runtimeOps.fillParseStarvationWindowSeconds !== runtimeConfig.runtimeOps.fillParseStarvationWindowSeconds) {
        changed.opsFillParseStarvationWindowSeconds = {
          from: runtimeConfig.runtimeOps.fillParseStarvationWindowSeconds,
          to: next.runtimeOps.fillParseStarvationWindowSeconds
        };
      }
      if (next.runtimeOps.fillParseStarvationMinMessages !== runtimeConfig.runtimeOps.fillParseStarvationMinMessages) {
        changed.opsFillParseStarvationMinMessages = {
          from: runtimeConfig.runtimeOps.fillParseStarvationMinMessages,
          to: next.runtimeOps.fillParseStarvationMinMessages
        };
      }
    }

    if (next.runtimeOps.targetNettingEnabled !== runtimeConfig.runtimeOps.targetNettingEnabled) {
      targetNetting.setEnabled(next.runtimeOps.targetNettingEnabled);
      changed.opsTargetNettingEnabled = {
        from: runtimeConfig.runtimeOps.targetNettingEnabled,
        to: next.runtimeOps.targetNettingEnabled
      };
    }

    if (next.runtimeOps.targetNettingIntervalMs !== runtimeConfig.runtimeOps.targetNettingIntervalMs) {
      targetNetting.setIntervalMs(next.runtimeOps.targetNettingIntervalMs);
      changed.opsTargetNettingIntervalMs = {
        from: runtimeConfig.runtimeOps.targetNettingIntervalMs,
        to: next.runtimeOps.targetNettingIntervalMs
      };
    }

    if (next.runtimeOps.targetNettingTrackingErrorBps !== runtimeConfig.runtimeOps.targetNettingTrackingErrorBps) {
      targetNetting.setTrackingErrorBps(next.runtimeOps.targetNettingTrackingErrorBps);
      changed.opsTargetNettingTrackingErrorBps = {
        from: runtimeConfig.runtimeOps.targetNettingTrackingErrorBps,
        to: next.runtimeOps.targetNettingTrackingErrorBps
      };
    }

    if (next.runtimeOps.reconcileEngineEnabled !== runtimeConfig.runtimeOps.reconcileEngineEnabled) {
      reconcileEngine.setEnabled(next.runtimeOps.reconcileEngineEnabled);
      changed.opsReconcileEngineEnabled = {
        from: runtimeConfig.runtimeOps.reconcileEngineEnabled,
        to: next.runtimeOps.reconcileEngineEnabled
      };
    }

    if (
      next.runtimeOps.reconcileStaleLeaderSyncSeconds !== runtimeConfig.runtimeOps.reconcileStaleLeaderSyncSeconds ||
      next.runtimeOps.reconcileStaleFollowerSyncSeconds !== runtimeConfig.runtimeOps.reconcileStaleFollowerSyncSeconds
    ) {
      reconcileEngine.setStaleThresholds({
        leaderSeconds: next.runtimeOps.reconcileStaleLeaderSyncSeconds,
        followerSeconds: next.runtimeOps.reconcileStaleFollowerSyncSeconds
      });
      if (next.runtimeOps.reconcileStaleLeaderSyncSeconds !== runtimeConfig.runtimeOps.reconcileStaleLeaderSyncSeconds) {
        changed.opsReconcileStaleLeaderSyncSeconds = {
          from: runtimeConfig.runtimeOps.reconcileStaleLeaderSyncSeconds,
          to: next.runtimeOps.reconcileStaleLeaderSyncSeconds
        };
      }
      if (next.runtimeOps.reconcileStaleFollowerSyncSeconds !== runtimeConfig.runtimeOps.reconcileStaleFollowerSyncSeconds) {
        changed.opsReconcileStaleFollowerSyncSeconds = {
          from: runtimeConfig.runtimeOps.reconcileStaleFollowerSyncSeconds,
          to: next.runtimeOps.reconcileStaleFollowerSyncSeconds
        };
      }
    }

    if (
      next.runtimeOps.reconcileGuardrailFailureCycleThreshold !==
      runtimeConfig.runtimeOps.reconcileGuardrailFailureCycleThreshold
    ) {
      reconcileEngine.setGuardrailFailureCycleThreshold(next.runtimeOps.reconcileGuardrailFailureCycleThreshold);
      changed.opsReconcileGuardrailFailureCycleThreshold = {
        from: runtimeConfig.runtimeOps.reconcileGuardrailFailureCycleThreshold,
        to: next.runtimeOps.reconcileGuardrailFailureCycleThreshold
      };
    }

    if (next.runtimeOps.leaderTradesPollIntervalSeconds !== runtimeConfig.runtimeOps.leaderTradesPollIntervalSeconds) {
      leaderPoller.setTradesIntervalMs(next.runtimeOps.leaderTradesPollIntervalSeconds * 1000);
      changed.opsLeaderTradesPollIntervalSeconds = {
        from: runtimeConfig.runtimeOps.leaderTradesPollIntervalSeconds,
        to: next.runtimeOps.leaderTradesPollIntervalSeconds
      };
    }

    if (next.runtimeOps.leaderTradesTakerOnly !== runtimeConfig.runtimeOps.leaderTradesTakerOnly) {
      leaderPoller.setTradesTakerOnly(next.runtimeOps.leaderTradesTakerOnly);
      changed.opsLeaderTradesTakerOnly = {
        from: runtimeConfig.runtimeOps.leaderTradesTakerOnly,
        to: next.runtimeOps.leaderTradesTakerOnly
      };
    }

    if (next.runtimeOps.executionEngineEnabled !== runtimeConfig.runtimeOps.executionEngineEnabled) {
      executionEngine.setEnabled(next.runtimeOps.executionEngineEnabled);
      changed.opsExecutionEngineEnabled = {
        from: runtimeConfig.runtimeOps.executionEngineEnabled,
        to: next.runtimeOps.executionEngineEnabled
      };
    }

    if (next.runtimeOps.panicMode !== runtimeConfig.runtimeOps.panicMode) {
      executionEngine.setPanicMode(next.runtimeOps.panicMode);
      changed.opsPanicMode = {
        from: runtimeConfig.runtimeOps.panicMode,
        to: next.runtimeOps.panicMode
      };
    }

    runtimeConfig = next;
    if (Object.keys(changed).length > 0) {
      workerLogger.info("runtime_config.applied", {
        source,
        changed,
        effective: {
          ...runtimeConfig,
          chainTriggerEnabled: resolveEffectiveChainTriggerEnabled(runtimeConfig)
        }
      });
    }
  }

  async function refreshRuntimeConfig(source: "bootstrap" | "refresh"): Promise<void> {
    try {
      const rows = await prisma.$queryRaw<Array<{ config: Prisma.JsonValue | null }>>(
        Prisma.sql`
          SELECT "config"
          FROM "GlobalRuntimeConfig"
          WHERE "id" = ${GLOBAL_RUNTIME_CONFIG_ID}
          LIMIT 1
        `
      );
      const row = rows[0];
      const overrides = readGlobalRuntimeConfigOverrides(row?.config);
      const next = resolveEffectiveGlobalRuntimeConfig(runtimeConfigBaseline, overrides);
      await applyRuntimeConfig(next, source);
    } catch (error) {
      workerLogger.warn("runtime_config.refresh_failed", {
        source,
        error: toErrorDetails(error)
      });
    }
  }

  await refreshRuntimeConfig("bootstrap");
  const runtimeConfigRefresh = setInterval(() => {
    void refreshRuntimeConfig("refresh");
  }, env.WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS);

  async function refreshDashboardStatusSummary(source: "bootstrap" | "interval"): Promise<void> {
    try {
      const details = await writeDashboardStatusSummary(prisma, {
        retryBackoffBaseMs: env.EXECUTION_RETRY_BACKOFF_BASE_MS,
        retryBackoffMaxMs: env.EXECUTION_RETRY_BACKOFF_MAX_MS
      });

      if (source === "bootstrap") {
        workerLogger.info("dashboard_status.refreshed", {
          source,
          errorCounts: details.errorCounts,
          databaseSizeBytes: details.databaseSizeBytes
        });
      }
    } catch (error) {
      workerLogger.warn("dashboard_status.refresh_failed", {
        source,
        error: toErrorDetails(error)
      });
    }
  }

  await refreshDashboardStatusSummary("bootstrap");
  const dashboardStatusSummaryInterval = setInterval(() => {
    void refreshDashboardStatusSummary("interval");
  }, 60_000);

  async function runHistoryPruneJob(): Promise<void> {
    try {
      const result = await runHistoryPruneSafely(prisma);
      workerLogger.info("history_prune.completed", {
        ranAt: result.ranAt,
        batchSize: result.batchSize,
        tables: result.tables
      });
    } catch (error) {
      workerLogger.warn("history_prune.failed", {
        error: toErrorDetails(error)
      });
    }
  }

  let historyPruneInterval: NodeJS.Timeout | undefined;
  const historyPruneTimeout = setTimeout(() => {
    void runHistoryPruneJob();
    historyPruneInterval = setInterval(() => {
      void runHistoryPruneJob();
    }, 24 * 60 * 60 * 1_000);
  }, computeMsUntilNextUtcRun(3, 30));

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
          fillReconcile: fillReconcile.getStatus(),
          reconcile: reconcileEngine.getStatus(),
          runtimeConfig: {
            ...runtimeConfig,
            chainTriggerEnabled: resolveEffectiveChainTriggerEnabled(runtimeConfig)
          }
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

    if (url.pathname === "/fill-reconcile/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          fillReconcile: fillReconcile.getStatus()
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
          ? [...(await marketData.getBookStates(tokenIds)).values()]
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
    tradeDetectionEnabled: runtimeConfig.tradeDetectionEnabled,
    userChannelWsEnabled: runtimeConfig.userChannelWsEnabled,
    fillReconcileEnabled: runtimeConfig.runtimeOps.fillReconcileEnabled,
    fillReconcileIntervalSeconds: runtimeConfig.runtimeOps.fillReconcileIntervalSeconds,
    fillBackfillDefaultLookbackDays: env.FILL_BACKFILL_DEFAULT_LOOKBACK_DAYS,
    fillParseStarvationWindowSeconds: runtimeConfig.runtimeOps.fillParseStarvationWindowSeconds,
    fillParseStarvationMinMessages: runtimeConfig.runtimeOps.fillParseStarvationMinMessages,
    reconcileIntervalSeconds: runtimeConfig.reconcileIntervalSeconds,
    runtimeConfigRefreshIntervalMs: env.WORKER_RUNTIME_CONFIG_REFRESH_INTERVAL_MS,
    minNotionalPerOrderUsd: env.MIN_NOTIONAL_PER_ORDER_USD,
    minBookDepthForSizeEnabled: env.MIN_BOOK_DEPTH_FOR_SIZE_ENABLED,
    maxOpenOrders: env.MAX_OPEN_ORDERS,
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
    chainTriggerWsEnabled: runtimeConfig.runtimeOps.chainTriggerWsEnabled,
    chainTriggerEnabled: resolveEffectiveChainTriggerEnabled(runtimeConfig),
    chainTriggerExchangeContracts: exchangeContracts,
    chainTriggerDedupeTtlSeconds: env.CHAIN_TRIGGER_DEDUPE_TTL_SECONDS,
    chainTriggerWalletRefreshIntervalMs: env.CHAIN_TRIGGER_WALLET_REFRESH_INTERVAL_MS,
    chainTriggerReconcileQueueMaxSize: env.CHAIN_TRIGGER_RECONCILE_QUEUE_MAX_SIZE,
    targetNettingEnabled: runtimeConfig.runtimeOps.targetNettingEnabled,
    targetNettingIntervalMs: runtimeConfig.runtimeOps.targetNettingIntervalMs,
    targetNettingTrackingErrorBps: runtimeConfig.runtimeOps.targetNettingTrackingErrorBps,
    reconcileEngineEnabled: runtimeConfig.runtimeOps.reconcileEngineEnabled,
    reconcileStaleLeaderSyncSeconds: runtimeConfig.runtimeOps.reconcileStaleLeaderSyncSeconds,
    reconcileStaleFollowerSyncSeconds: runtimeConfig.runtimeOps.reconcileStaleFollowerSyncSeconds,
    reconcileGuardrailFailureCycleThreshold: runtimeConfig.runtimeOps.reconcileGuardrailFailureCycleThreshold,
    executionEngineEnabled: runtimeConfig.runtimeOps.executionEngineEnabled,
    executionIntervalMs: env.EXECUTION_INTERVAL_MS,
    executionMaxAttemptsPerRun: env.EXECUTION_MAX_ATTEMPTS_PER_RUN,
    executionRetryBackoffBaseMs: env.EXECUTION_RETRY_BACKOFF_BASE_MS,
    executionRetryBackoffMaxMs: env.EXECUTION_RETRY_BACKOFF_MAX_MS,
    executionDryRunMode: env.DRY_RUN_MODE,
    polymarketSignerAddress,
    polymarketSignatureType: signingConfig?.signatureTypeName ?? null,
    polymarketFunderAddress: signingConfig?.funderAddress ?? null,
    leaderTradesPollIntervalSeconds: runtimeConfig.runtimeOps.leaderTradesPollIntervalSeconds,
    leaderTradesTakerOnly: runtimeConfig.runtimeOps.leaderTradesTakerOnly,
    panicMode: runtimeConfig.runtimeOps.panicMode,
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
    clearInterval(runtimeConfigRefresh);
    clearInterval(dashboardStatusSummaryInterval);
    clearTimeout(historyPruneTimeout);
    if (historyPruneInterval) {
      clearInterval(historyPruneInterval);
    }
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
    fillReconcile.stop();
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

function toSupportedChainId(value: number): 137 | 80002 {
  if (value === 137 || value === 80002) {
    return value;
  }
  return 137;
}

function computeMsUntilNextUtcRun(hourUtc: number, minuteUtc: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      minuteUtc,
      0,
      0
    )
  );

  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  return Math.max(1_000, next.getTime() - now.getTime());
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
