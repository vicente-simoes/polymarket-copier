import { orderRetryKey } from "@copybot/shared";
import { workerLogger } from "../logger.js";
import { planExecution } from "./planner.js";
import type {
  ExecutionAttemptContext,
  ExecutionAttemptRecord,
  ExecutionBookLevel,
  ExecutionEngineConfig,
  ExecutionEngineStatus,
  ExecutionOrderBookSnapshot,
  ExecutionOrderResult,
  ExecutionSkipReason,
  ExecutionStore,
  ExecutionVenueClient
} from "./types.js";

export interface ExecutionEngineDeps {
  store: ExecutionStore;
  venueClient: ExecutionVenueClient;
  config: ExecutionEngineConfig;
  getMarketSnapshot: (tokenId: string) => Promise<{
    tokenId: string;
    marketId?: string;
    bestBid?: number;
    bestAsk?: number;
    midPrice?: number;
    tickSize?: number;
    minOrderSize?: number;
    negRisk?: boolean;
    isStale: boolean;
    priceSource: "WS" | "REST" | "NONE";
    wsConnected?: boolean;
  }>;
  fetchOrderBook: (tokenId: string) => Promise<{
    tokenId: string;
    marketId?: string;
    bids: ExecutionBookLevel[];
    asks: ExecutionBookLevel[];
  }>;
  now?: () => number;
}

type ProcessOutcome = "PLACED" | "DEFERRED" | "DRY_RUN_DEFERRED" | "ORDER_FAILURE" | "BACKOFF_SKIP" | "NOOP";

export class ExecutionEngine {
  private readonly store: ExecutionStore;
  private readonly venueClient: ExecutionVenueClient;
  private readonly config: ExecutionEngineConfig;
  private readonly getMarketSnapshot: ExecutionEngineDeps["getMarketSnapshot"];
  private readonly fetchOrderBook: ExecutionEngineDeps["fetchOrderBook"];
  private readonly now: () => number;
  private interval?: NodeJS.Timeout;
  private inFlight = false;
  private readonly status: ExecutionEngineStatus;

  constructor(deps: ExecutionEngineDeps) {
    this.store = deps.store;
    this.venueClient = deps.venueClient;
    this.config = deps.config;
    this.getMarketSnapshot = deps.getMarketSnapshot;
    this.fetchOrderBook = deps.fetchOrderBook;
    this.now = deps.now ?? Date.now;
    this.status = {
      enabled: deps.config.enabled,
      dryRunMode: deps.config.dryRunMode,
      running: false,
      totalRuns: 0,
      totalFailures: 0,
      totalOrdersPlaced: 0,
      totalOrderFailures: 0,
      totalDryRunDeferrals: 0,
      totalGuardrailBlocks: 0,
      totalControlBlocks: 0,
      totalBackoffSkips: 0,
      lastAttemptsEvaluated: 0,
      lastOrdersPlaced: 0,
      lastOrderFailures: 0,
      lastDryRunDeferrals: 0,
      lastDeferred: 0,
      lastBackoffSkips: 0
    };
  }

  start(): void {
    if (!this.config.enabled) {
      return;
    }

    this.interval = setInterval(() => {
      void this.run();
    }, this.config.intervalMs);

    void this.run();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  getStatus(): ExecutionEngineStatus {
    return {
      ...this.status
    };
  }

  async run(): Promise<void> {
    if (!this.config.enabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    this.status.running = true;
    this.status.totalRuns += 1;
    this.status.lastRunAtMs = this.now();
    const startedAtMs = this.now();

    let attemptsEvaluated = 0;
    let ordersPlaced = 0;
    let orderFailures = 0;
    let dryRunDeferrals = 0;
    let deferred = 0;
    let backoffSkips = 0;

    try {
      const repairOutcome = await this.store.repairExecutionInvariants(new Date(startedAtMs));
      if (repairOutcome.pendingDeltasConverted > 0 || repairOutcome.attemptsClosed > 0) {
        workerLogger.warn("execution.invariant_repaired", {
          pendingDeltasConverted: repairOutcome.pendingDeltasConverted,
          attemptsClosed: repairOutcome.attemptsClosed
        });
      }

      const attempts = await this.store.listOpenAttempts(this.config.maxAttemptsPerRun);
      for (const attempt of attempts) {
        if (!this.isRetryDue(attempt)) {
          backoffSkips += 1;
          continue;
        }

        attemptsEvaluated += 1;
        const outcome = await this.processAttempt(attempt);
        if (outcome === "PLACED") {
          ordersPlaced += 1;
        } else if (outcome === "ORDER_FAILURE") {
          orderFailures += 1;
        } else if (outcome === "DRY_RUN_DEFERRED") {
          dryRunDeferrals += 1;
          deferred += 1;
        } else if (outcome === "DEFERRED") {
          deferred += 1;
        } else if (outcome === "BACKOFF_SKIP") {
          backoffSkips += 1;
        }
      }

      this.status.lastSuccessAtMs = this.now();
      this.status.lastError = undefined;
    } catch (error) {
      this.status.totalFailures += 1;
      this.status.lastFailureAtMs = this.now();
      this.status.lastError = toErrorMessage(error);
      workerLogger.error("execution.run_failed", {
        error: toErrorMessage(error)
      });
    } finally {
      this.status.running = false;
      this.status.lastDurationMs = this.now() - startedAtMs;
      this.status.lastAttemptsEvaluated = attemptsEvaluated;
      this.status.lastOrdersPlaced = ordersPlaced;
      this.status.lastOrderFailures = orderFailures;
      this.status.lastDryRunDeferrals = dryRunDeferrals;
      this.status.lastDeferred = deferred;
      this.status.lastBackoffSkips = backoffSkips;
      this.status.totalOrdersPlaced += ordersPlaced;
      this.status.totalOrderFailures += orderFailures;
      this.status.totalDryRunDeferrals += dryRunDeferrals;
      this.status.totalBackoffSkips += backoffSkips;
      this.inFlight = false;
    }
  }

  private isRetryDue(attempt: ExecutionAttemptRecord): boolean {
    if (attempt.status !== "RETRYING" || !attempt.attemptedAt) {
      return true;
    }

    const elapsedMs = this.now() - attempt.attemptedAt.getTime();
    const requiredMs = this.computeBackoffMs(attempt.retries);
    return elapsedMs >= requiredMs;
  }

  private computeBackoffMs(retries: number): number {
    if (retries <= 0) {
      return 0;
    }

    const exponent = Math.max(0, retries - 1);
    const raw = this.config.retryBackoffBaseMs * 2 ** exponent;
    return Math.min(raw, this.config.retryBackoffMaxMs);
  }

  private async processAttempt(attempt: ExecutionAttemptRecord): Promise<ProcessOutcome> {
    const nowMs = this.now();
    const nowDate = new Date(nowMs);

    if (attempt.expiresAt.getTime() <= nowMs) {
      await this.deferAttempt(attempt, "EXPIRED", {
        nowDate,
        incrementRetry: false,
        forceTerminal: "EXPIRED",
        message: "attempt expired before execution"
      });
      return "DEFERRED";
    }

    const context = await this.store.getAttemptContext(attempt.id);
    if (!context) {
      return "NOOP";
    }

    if (!this.config.copySystemEnabled || context.copySystemEnabled === false || this.config.panicMode || context.copyProfileStatus !== "ACTIVE") {
      await this.deferAttempt(attempt, "KILL_SWITCH", {
        nowDate,
        incrementRetry: false,
        message: "copy system disabled by env/profile, panic mode enabled, or copy profile paused"
      });
      this.status.totalControlBlocks += 1;
      return "DEFERRED";
    }

    if (context.leaderStatus && context.leaderStatus !== "ACTIVE") {
      await this.deferAttempt(attempt, "LEADER_PAUSED", {
        nowDate,
        incrementRetry: false,
        message: "leader is not active"
      });
      this.status.totalControlBlocks += 1;
      return "DEFERRED";
    }

    const pendingState = resolvePendingDeltaState(context, attempt);
    if (pendingState.terminalExpired) {
      await this.deferAttempt(attempt, "EXPIRED", {
        nowDate,
        incrementRetry: false,
        forceTerminal: "EXPIRED",
        message: pendingState.message,
        context: {
          pendingDeltaStatus: context.pendingDeltaStatus ?? null,
          pendingDeltaId: context.pendingDeltaId ?? null
        }
      });
      return "DEFERRED";
    }

    if (pendingState.deferReason) {
      await this.deferAttempt(attempt, pendingState.deferReason, {
        nowDate,
        incrementRetry: false,
        message: pendingState.message,
        context: {
          pendingDeltaStatus: context.pendingDeltaStatus ?? null,
          pendingDeltaBlockReason: context.pendingDeltaBlockReason ?? null
        }
      });
      this.status.totalControlBlocks += 1;
      return "DEFERRED";
    }

    const effectiveDeltaShares = pendingState.deltaShares;
    const effectiveDeltaNotionalUsd = pendingState.deltaNotionalUsd;

    const dailySpent = await this.store.getNotionalTurnoverUsd(attempt.copyProfileId, new Date(nowMs - 86_400_000));
    const hourlySpent = await this.store.getNotionalTurnoverUsd(attempt.copyProfileId, new Date(nowMs - 3_600_000));
    const baselineNotional = positiveOrZero(effectiveDeltaNotionalUsd);

    if (dailySpent + baselineNotional > this.config.maxDailyNotionalTurnoverUsd) {
      await this.deferAttempt(attempt, "RATE_LIMIT", {
        nowDate,
        incrementRetry: true,
        message: "daily notional turnover cap exceeded",
        context: {
          dailySpent,
          baselineNotional,
          maxDailyNotionalTurnoverUsd: this.config.maxDailyNotionalTurnoverUsd
        }
      });
      this.status.totalControlBlocks += 1;
      return "DEFERRED";
    }

    if (hourlySpent + baselineNotional > this.config.maxHourlyNotionalTurnoverUsd) {
      await this.deferAttempt(attempt, "RATE_LIMIT", {
        nowDate,
        incrementRetry: true,
        message: "hourly notional turnover cap exceeded",
        context: {
          hourlySpent,
          baselineNotional,
          maxHourlyNotionalTurnoverUsd: this.config.maxHourlyNotionalTurnoverUsd
        }
      });
      this.status.totalControlBlocks += 1;
      return "DEFERRED";
    }

    const lastOrderAt = await this.store.getLastOrderAttemptAt(attempt.copyProfileId, attempt.tokenId);
    const cooldownMs = this.config.cooldownPerMarketSeconds * 1000;
    if (lastOrderAt && nowMs - lastOrderAt.getTime() < cooldownMs) {
      await this.deferAttempt(attempt, "RATE_LIMIT", {
        nowDate,
        incrementRetry: true,
        message: "market cooldown is active",
        context: {
          cooldownPerMarketSeconds: this.config.cooldownPerMarketSeconds
        }
      });
      this.status.totalControlBlocks += 1;
      return "DEFERRED";
    }

    let market: Awaited<ReturnType<ExecutionEngineDeps["getMarketSnapshot"]>>;
    try {
      market = await this.getMarketSnapshot(attempt.tokenId);
    } catch (error) {
      await this.deferAttempt(attempt, "BOOK_UNAVAILABLE", {
        nowDate,
        incrementRetry: true,
        message: `failed to load market snapshot: ${toErrorMessage(error)}`
      });
      this.status.totalGuardrailBlocks += 1;
      return "DEFERRED";
    }

    if (market.isStale || market.midPrice === undefined || market.midPrice <= 0) {
      const reason =
        market.priceSource === "NONE" && market.wsConnected === false
          ? "MARKET_WS_DISCONNECTED"
          : "STALE_PRICE";
      await this.deferAttempt(attempt, reason, {
        nowDate,
        incrementRetry: true,
        message: "stale or missing market prices",
        context: {
          priceSource: market.priceSource,
          isStale: market.isStale,
          wsConnected: market.wsConnected
        }
      });
      this.status.totalGuardrailBlocks += 1;
      return "DEFERRED";
    }

    if (
      market.tickSize === undefined ||
      market.tickSize <= 0 ||
      market.minOrderSize === undefined ||
      market.minOrderSize <= 0 ||
      market.negRisk === undefined
    ) {
      await this.deferAttempt(attempt, "BOOK_UNAVAILABLE", {
        nowDate,
        incrementRetry: true,
        message: "market metadata unavailable"
      });
      this.status.totalGuardrailBlocks += 1;
      return "DEFERRED";
    }

    let book: Awaited<ReturnType<ExecutionEngineDeps["fetchOrderBook"]>>;
    try {
      book = await this.fetchOrderBook(attempt.tokenId);
    } catch (error) {
      await this.deferAttempt(attempt, "BOOK_UNAVAILABLE", {
        nowDate,
        incrementRetry: true,
        message: `failed to load order book: ${toErrorMessage(error)}`
      });
      this.status.totalGuardrailBlocks += 1;
      return "DEFERRED";
    }

    const bookBestBid = bestBidPrice(book.bids);
    const bookBestAsk = bestAskPrice(book.asks);
    const guardBestBid = bookBestBid ?? market.bestBid;
    const guardBestAsk = bookBestAsk ?? market.bestAsk;
    const guardMidPrice =
      guardBestBid !== undefined && guardBestAsk !== undefined
        ? (guardBestBid + guardBestAsk) / 2
        : market.midPrice;

    const leaderPrice = resolveLeaderPrice(context, attempt, effectiveDeltaShares, effectiveDeltaNotionalUsd);
    const effectiveMaxPricePerShare = resolveMaxPricePerShare(this.config.maxPricePerShare, context);
    const plan = planExecution({
      side: attempt.side,
      deltaShares: effectiveDeltaShares,
      minOrderSize: market.minOrderSize,
      minNotionalUsd: this.config.minNotionalUsd,
      leaderPrice,
      midPrice: guardMidPrice,
      bestBid: guardBestBid,
      bestAsk: guardBestAsk,
      tickSize: market.tickSize,
      maxWorseningBuyUsd: this.config.maxWorseningBuyUsd,
      maxWorseningSellUsd: this.config.maxWorseningSellUsd,
      maxSlippageBps: this.config.maxSlippageBps,
      maxSpreadUsd: this.config.maxSpreadUsd,
      maxPricePerShare: effectiveMaxPricePerShare,
      book: {
        tokenId: attempt.tokenId,
        marketId: market.marketId ?? attempt.marketId,
        bids: book.bids,
        asks: book.asks
      }
    });

    if (!plan.executable) {
      await this.deferAttempt(attempt, plan.blockReason ?? "UNKNOWN", {
        nowDate,
        incrementRetry: true,
        message: plan.blockMessage ?? "execution plan blocked",
        context: {
          guardrailReasons: plan.guardrailReasons
        }
      });
      this.status.totalGuardrailBlocks += 1;
      return "DEFERRED";
    }

    const intendedNotionalUsd = plan.amountKind === "USD" ? plan.amount : plan.estimatedNotionalUsd;
    const intendedShares = plan.amountKind === "SHARES" ? plan.amount : plan.estimatedShares;
    if (intendedNotionalUsd <= 0 || intendedShares <= 0) {
      await this.deferAttempt(attempt, "UNKNOWN", {
        nowDate,
        incrementRetry: true,
        message: "non-positive planned notional or shares"
      });
      return "DEFERRED";
    }

    if (this.config.dryRunMode) {
      await this.deferAttempt(attempt, "KILL_SWITCH", {
        nowDate,
        incrementRetry: true,
        suppressMaxRetries: true,
        message: "dry-run mode enabled; execution submission skipped",
        context: {
          dryRunMode: true,
          planned: {
            amountKind: plan.amountKind,
            amount: plan.amount,
            intendedNotionalUsd,
            intendedShares,
            priceLimit: plan.priceLimit
          }
        }
      });
      this.status.totalControlBlocks += 1;
      workerLogger.info("execution.dry_run_deferred", {
        attemptId: attempt.id,
        tokenId: attempt.tokenId,
        side: attempt.side,
        amountKind: plan.amountKind,
        amount: plan.amount,
        intendedNotionalUsd,
        intendedShares,
        priceLimit: plan.priceLimit
      });
      return "DRY_RUN_DEFERRED";
    }

    const idempotencyKey = orderRetryKey(attempt.id, attempt.retries);
    const orderRecord = await this.store.createCopyOrderDraft({
      copyProfileId: attempt.copyProfileId,
      copyAttemptId: attempt.id,
      tokenId: attempt.tokenId,
      marketId: market.marketId ?? attempt.marketId,
      side: attempt.side,
      intendedNotionalUsd,
      intendedShares,
      priceLimit: plan.priceLimit,
      leaderWeights: resolveLeaderWeights(context, attempt.leaderId),
      idempotencyKey,
      retryCount: attempt.retries,
      attemptedAt: nowDate
    });

    if (isPlacedLike(orderRecord.status)) {
      await this.store.markCopyOrderPlaced({
        copyOrderId: orderRecord.id,
        attemptId: attempt.id,
        pendingDeltaId: attempt.pendingDeltaId,
        status: toPlacedStatus(orderRecord.status),
        externalOrderId: orderRecord.externalOrderId,
        responsePayload: {
          replayedPlacement: true
        },
        attemptedAt: nowDate
      });
      workerLogger.info("execution.order_replayed", {
        attemptId: attempt.id,
        tokenId: attempt.tokenId,
        side: attempt.side,
        copyOrderId: orderRecord.id,
        status: orderRecord.status
      });
      return "PLACED";
    }

    if (orderRecord.status === "CANCELLED") {
      await this.deferAttempt(attempt, "UNKNOWN", {
        nowDate,
        incrementRetry: true,
        message: "existing order for retry idempotency key is cancelled"
      });
      return "DEFERRED";
    }

    try {
      const result = await this.venueClient.createAndSubmitOrder({
        copyAttemptId: attempt.id,
        tokenId: attempt.tokenId,
        marketId: market.marketId ?? attempt.marketId,
        side: attempt.side,
        orderType: "FAK",
        amountKind: plan.amountKind,
        amount: plan.amount,
        priceLimit: plan.priceLimit,
        tickSize: market.tickSize,
        negRisk: market.negRisk,
        idempotencyKey
      });

      const normalizedStatus = normalizePlacedStatus(result);
      if (!normalizedStatus) {
        await this.store.markCopyOrderFailure({
          copyOrderId: orderRecord.id,
          orderStatus: "FAILED",
          attemptTransition: this.transitionFor(attempt, {
            reason: "UNKNOWN",
            attemptedAt: nowDate,
            incrementRetry: true,
            message: "exchange returned non-placement status",
            context: {
              venueStatus: result.status ?? "UNKNOWN",
              responsePayload: result.responsePayload ?? {}
            }
          })
        });
        return "ORDER_FAILURE";
      }

      await this.store.markCopyOrderPlaced({
        copyOrderId: orderRecord.id,
        attemptId: attempt.id,
        pendingDeltaId: attempt.pendingDeltaId,
        status: normalizedStatus,
        externalOrderId: result.externalOrderId,
        responsePayload: result.responsePayload,
        attemptedAt: nowDate
      });
      workerLogger.info("execution.order_placed", {
        attemptId: attempt.id,
        tokenId: attempt.tokenId,
        side: attempt.side,
        copyOrderId: orderRecord.id,
        status: normalizedStatus,
        externalOrderId: result.externalOrderId
      });
      return "PLACED";
    } catch (error) {
      const message = toErrorMessage(error);
      await this.store.markCopyOrderFailure({
        copyOrderId: orderRecord.id,
        orderStatus: "FAILED",
        attemptTransition: this.transitionFor(attempt, {
          reason: classifySubmitErrorReason(message),
          attemptedAt: nowDate,
          incrementRetry: true,
          message,
          context: {
            stage: "submit_order"
          }
        })
      });
      workerLogger.warn("execution.order_failed", {
        attemptId: attempt.id,
        tokenId: attempt.tokenId,
        side: attempt.side,
        copyOrderId: orderRecord.id,
        error: toErrorMessage(error)
      });
      return "ORDER_FAILURE";
    }
  }

  private async deferAttempt(
    attempt: ExecutionAttemptRecord,
    reason: ExecutionSkipReason,
    args: {
      nowDate: Date;
      incrementRetry: boolean;
      forceTerminal?: "FAILED" | "EXPIRED";
      suppressMaxRetries?: boolean;
      message?: string;
      context?: Record<string, unknown>;
    }
  ): Promise<void> {
    const transition = this.transitionFor(attempt, {
      reason,
      attemptedAt: args.nowDate,
      incrementRetry: args.incrementRetry,
      forceTerminal: args.forceTerminal,
      suppressMaxRetries: args.suppressMaxRetries,
      message: args.message,
      context: args.context
    });

    await this.store.deferAttempt(transition);

    const payload = {
      attemptId: attempt.id,
      tokenId: attempt.tokenId,
      side: attempt.side,
      reason: transition.reason,
      retries: transition.nextRetries,
      terminalStatus: transition.terminalStatus ?? null,
      message: transition.message ?? null
    };

    if (transition.terminalStatus) {
      workerLogger.warn("execution.attempt_terminal", payload);
    } else {
      workerLogger.info("execution.attempt_deferred", payload);
    }
  }

  private transitionFor(
    attempt: ExecutionAttemptRecord,
    args: {
      reason: ExecutionSkipReason;
      attemptedAt: Date;
      incrementRetry: boolean;
      forceTerminal?: "FAILED" | "EXPIRED";
      suppressMaxRetries?: boolean;
      message?: string;
      context?: Record<string, unknown>;
    }
  ) {
    const nextRetries = attempt.retries + (args.incrementRetry ? 1 : 0);
    const nowMs = args.attemptedAt.getTime();
    let terminalStatus = args.forceTerminal;
    if (!terminalStatus && nowMs >= attempt.expiresAt.getTime()) {
      terminalStatus = "EXPIRED";
    }
    if (!terminalStatus && !args.suppressMaxRetries && nextRetries > attempt.maxRetries) {
      terminalStatus = "FAILED";
    }

    return {
      attemptId: attempt.id,
      pendingDeltaId: attempt.pendingDeltaId,
      reason: terminalStatus === "EXPIRED" ? "EXPIRED" : args.reason,
      nextRetries,
      terminalStatus,
      message: args.message,
      context: {
        ...(args.context ?? {}),
        backoffMs: this.computeBackoffMs(nextRetries),
        retries: nextRetries
      },
      attemptedAt: args.attemptedAt
    } as const;
  }
}

function resolveLeaderPrice(
  context: ExecutionAttemptContext,
  attempt: ExecutionAttemptRecord,
  effectiveDeltaShares: number,
  effectiveDeltaNotionalUsd: number
): number | undefined {
  const metadata = context.pendingDeltaMetadata;
  const byTokenPrice = readNumber(metadata.tokenPrice);
  if (byTokenPrice && byTokenPrice > 0) {
    return byTokenPrice;
  }

  const byLeaderPrice = readNumber(metadata.leaderPrice);
  if (byLeaderPrice && byLeaderPrice > 0) {
    return byLeaderPrice;
  }

  if (effectiveDeltaShares > 0 && effectiveDeltaNotionalUsd > 0) {
    return effectiveDeltaNotionalUsd / effectiveDeltaShares;
  }

  if (attempt.accumulatedDeltaShares > 0 && attempt.accumulatedDeltaNotionalUsd > 0) {
    return attempt.accumulatedDeltaNotionalUsd / attempt.accumulatedDeltaShares;
  }

  return undefined;
}

function resolveLeaderWeights(context: ExecutionAttemptContext, fallbackLeaderId?: string): Record<string, number> {
  const candidate = context.pendingDeltaMetadata.leaderTargetShares;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }

  const entries = Object.entries(candidate as Record<string, unknown>)
    .map(([leaderId, value]) => [leaderId, readNumber(value) ?? 0] as const)
    .filter(([, value]) => value > 0);

  if (entries.length === 0) {
    if (fallbackLeaderId) {
      return { [fallbackLeaderId]: 1 };
    }
    return {};
  }

  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) {
    return {};
  }

  const weights: Record<string, number> = {};
  for (const [leaderId, value] of entries) {
    weights[leaderId] = roundTo(value / total, 8);
  }
  return weights;
}

function resolveMaxPricePerShare(defaultValue: number | undefined, context: ExecutionAttemptContext): number | undefined {
  if (context.maxPricePerShareOverride === null) {
    return undefined;
  }
  if (context.maxPricePerShareOverride !== undefined) {
    return context.maxPricePerShareOverride;
  }
  return defaultValue;
}

function normalizePlacedStatus(result: ExecutionOrderResult): "PLACED" | "PARTIALLY_FILLED" | "FILLED" | null {
  if (!result.status || result.status === "PLACED") {
    return "PLACED";
  }

  if (result.status === "PARTIALLY_FILLED") {
    return "PARTIALLY_FILLED";
  }

  if (result.status === "FILLED") {
    return "FILLED";
  }

  return null;
}

function bestBidPrice(levels: ExecutionBookLevel[]): number | undefined {
  let best: number | undefined;
  for (const level of levels) {
    if (level.price <= 0 || level.size <= 0) {
      continue;
    }
    if (best === undefined || level.price > best) {
      best = level.price;
    }
  }
  return best;
}

function bestAskPrice(levels: ExecutionBookLevel[]): number | undefined {
  let best: number | undefined;
  for (const level of levels) {
    if (level.price <= 0 || level.size <= 0) {
      continue;
    }
    if (best === undefined || level.price < best) {
      best = level.price;
    }
  }
  return best;
}

function isPlacedLike(status: string): boolean {
  return status === "PLACED" || status === "PARTIALLY_FILLED" || status === "FILLED";
}

function toPlacedStatus(status: string): "PLACED" | "PARTIALLY_FILLED" | "FILLED" {
  if (status === "PARTIALLY_FILLED") {
    return "PARTIALLY_FILLED";
  }
  if (status === "FILLED") {
    return "FILLED";
  }
  return "PLACED";
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function positiveOrZero(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function classifySubmitErrorReason(message: string): ExecutionSkipReason {
  const normalized = message.toLowerCase();
  if (normalized.includes("balance") || normalized.includes("allowance")) {
    return "RATE_LIMIT";
  }
  return "UNKNOWN";
}

function resolvePendingDeltaState(
  context: ExecutionAttemptContext,
  attempt: ExecutionAttemptRecord
): {
  deltaShares: number;
  deltaNotionalUsd: number;
  deferReason?: ExecutionSkipReason;
  terminalExpired: boolean;
  message: string;
} {
  const deltaShares = resolveLiveDeltaShares(context, attempt);
  const deltaNotionalUsd = resolveLiveDeltaNotional(context, attempt, deltaShares);

  if (deltaShares <= 0) {
    return {
      deltaShares,
      deltaNotionalUsd,
      terminalExpired: true,
      message: "pending delta is empty"
    };
  }

  if (attempt.pendingDeltaId && !context.pendingDeltaStatus) {
    return {
      deltaShares,
      deltaNotionalUsd,
      terminalExpired: true,
      message: "pending delta is missing"
    };
  }

  if (context.pendingDeltaStatus === "CONVERTED" || context.pendingDeltaStatus === "EXPIRED") {
    return {
      deltaShares,
      deltaNotionalUsd,
      terminalExpired: true,
      message: `pending delta is ${context.pendingDeltaStatus.toLowerCase()}`
    };
  }

  if (context.pendingDeltaStatus === "BLOCKED" || context.pendingDeltaStatus === "PENDING") {
    const reason = mapPendingDeltaReason(context.pendingDeltaBlockReason, context.pendingDeltaMetadata);
    return {
      deltaShares,
      deltaNotionalUsd,
      deferReason: reason,
      terminalExpired: false,
      message: `pending delta is ${context.pendingDeltaStatus.toLowerCase()}`
    };
  }

  return {
    deltaShares,
    deltaNotionalUsd,
    terminalExpired: false,
    message: "pending delta is eligible"
  };
}

function resolveLiveDeltaShares(context: ExecutionAttemptContext, attempt: ExecutionAttemptRecord): number {
  const fromPending = positiveOrZero(context.pendingDeltaShares ?? Number.NaN);
  if (fromPending > 0) {
    return fromPending;
  }
  return positiveOrZero(attempt.accumulatedDeltaShares);
}

function resolveLiveDeltaNotional(context: ExecutionAttemptContext, attempt: ExecutionAttemptRecord, deltaShares: number): number {
  const fromPending = positiveOrZero(context.pendingDeltaNotionalUsd ?? Number.NaN);
  if (fromPending > 0) {
    return fromPending;
  }

  const fromAttempt = positiveOrZero(attempt.accumulatedDeltaNotionalUsd);
  if (fromAttempt > 0) {
    return fromAttempt;
  }

  const tokenPrice = readNumber(context.pendingDeltaMetadata.tokenPrice);
  if (tokenPrice && tokenPrice > 0 && deltaShares > 0) {
    return deltaShares * tokenPrice;
  }
  return 0;
}

function mapPendingDeltaReason(blockReason: string | undefined, metadata: Record<string, unknown>): ExecutionSkipReason {
  const fromBlock = normalizeSkipReason(blockReason);
  if (fromBlock) {
    return fromBlock;
  }
  const thresholdReason = normalizeSkipReason(readString(metadata.thresholdReason));
  if (thresholdReason) {
    return thresholdReason;
  }
  return "UNKNOWN";
}

function normalizeSkipReason(value: string | undefined): ExecutionSkipReason | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "MIN_NOTIONAL") {
    return "MIN_NOTIONAL";
  }
  if (value === "MIN_ORDER_SIZE") {
    return "MIN_ORDER_SIZE";
  }
  if (value === "SLIPPAGE") {
    return "SLIPPAGE";
  }
  if (value === "PRICE_GUARD") {
    return "PRICE_GUARD";
  }
  if (value === "SPREAD") {
    return "SPREAD";
  }
  if (value === "THIN_BOOK") {
    return "THIN_BOOK";
  }
  if (value === "STALE_PRICE") {
    return "STALE_PRICE";
  }
  if (value === "MARKET_WS_DISCONNECTED") {
    return "MARKET_WS_DISCONNECTED";
  }
  if (value === "RATE_LIMIT") {
    return "RATE_LIMIT";
  }
  if (value === "KILL_SWITCH") {
    return "KILL_SWITCH";
  }
  if (value === "LEADER_PAUSED") {
    return "LEADER_PAUSED";
  }
  if (value === "EXPIRED") {
    return "EXPIRED";
  }
  if (value === "BOOK_UNAVAILABLE") {
    return "BOOK_UNAVAILABLE";
  }
  if (value === "UNKNOWN") {
    return "UNKNOWN";
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}
