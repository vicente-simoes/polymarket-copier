import type { DataApiPosition, DataApiTrade } from "@copybot/shared";
import { isRetryableDataApiError } from "./data-api.js";
import { workerLogger } from "../logger.js";
import type {
  LeaderDataApiClient,
  LeaderIngestionStore,
  LeaderPollerConfig,
  LeaderPollerStatus,
  LeaderRecord,
  NormalizedTradeEvent,
  PollJobSnapshot
} from "./types.js";
import { buildCanonicalTradeKey } from "../ingestion/canonical-trade-key.js";

interface PollerDependencies {
  dataApi: LeaderDataApiClient;
  store: LeaderIngestionStore;
  config: LeaderPollerConfig;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

export class LeaderPoller {
  private readonly dataApi: LeaderDataApiClient;
  private readonly store: LeaderIngestionStore;
  private readonly config: LeaderPollerConfig;
  private readonly now: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly status: LeaderPollerStatus;
  private positionsInterval?: NodeJS.Timeout;
  private tradesInterval?: NodeJS.Timeout;
  private positionsInFlight = false;
  private tradesInFlight = false;

  constructor(deps: PollerDependencies) {
    this.dataApi = deps.dataApi;
    this.store = deps.store;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ??
      ((durationMs) => {
        return new Promise((resolve) => {
          setTimeout(resolve, durationMs);
        });
      });

    this.status = {
      positions: newJobSnapshot(),
      trades: newJobSnapshot(),
      lastUpdatedAtMs: this.now()
    };
  }

  start(): void {
    if (!this.positionsInterval) {
      this.startPositionsInterval();
    }
    if (!this.tradesInterval) {
      this.startTradesInterval();
    }

    void this.runPositionsPoll();
    void this.runTradesPoll();
  }

  setPositionsIntervalMs(intervalMs: number): void {
    const normalized = Math.max(1000, Math.trunc(intervalMs));
    if (this.config.positionsIntervalMs === normalized) {
      return;
    }

    this.config.positionsIntervalMs = normalized;
    if (!this.positionsInterval) {
      return;
    }

    clearInterval(this.positionsInterval);
    this.startPositionsInterval();
  }

  setTradesIntervalMs(intervalMs: number): void {
    const normalized = Math.max(1000, Math.trunc(intervalMs));
    if (this.config.tradesIntervalMs === normalized) {
      return;
    }

    this.config.tradesIntervalMs = normalized;
    if (!this.tradesInterval) {
      return;
    }

    clearInterval(this.tradesInterval);
    this.startTradesInterval();
  }

  setTradesTakerOnly(enabled: boolean): void {
    this.config.tradesTakerOnly = enabled;
  }

  stop(): void {
    if (this.positionsInterval) {
      clearInterval(this.positionsInterval);
      this.positionsInterval = undefined;
    }
    if (this.tradesInterval) {
      clearInterval(this.tradesInterval);
      this.tradesInterval = undefined;
    }
  }

  getStatus(): LeaderPollerStatus {
    return {
      positions: { ...this.status.positions },
      trades: { ...this.status.trades },
      lastUpdatedAtMs: this.status.lastUpdatedAtMs
    };
  }

  private startPositionsInterval(): void {
    this.positionsInterval = setInterval(() => {
      void this.runPositionsPoll();
    }, this.config.positionsIntervalMs);
  }

  private startTradesInterval(): void {
    this.tradesInterval = setInterval(() => {
      void this.runTradesPoll();
    }, this.config.tradesIntervalMs);
  }

  async runPositionsPoll(): Promise<void> {
    if (this.positionsInFlight) {
      return;
    }

    this.positionsInFlight = true;
    const job = this.status.positions;
    job.running = true;
    job.lastRunAtMs = this.now();
    job.totalRuns += 1;
    const startedAtMs = this.now();

    let leadersProcessed = 0;
    let recordsSeen = 0;
    let recordsInserted = 0;

    try {
      const leaders = await this.store.listActiveLeaders();
      for (const batch of chunk(leaders, this.config.batchSize)) {
        await Promise.all(
          batch.map(async (leader) => {
            const outcome = await this.pollLeaderPositions(leader);
            leadersProcessed += 1;
            recordsSeen += outcome.recordsSeen;
            recordsInserted += outcome.recordsInserted;
          })
        );
      }

      job.lastSuccessAtMs = this.now();
      job.consecutiveFailures = 0;
      job.lastError = undefined;
    } catch (error) {
      job.totalFailures += 1;
      job.consecutiveFailures += 1;
      job.lastFailureAtMs = this.now();
      job.lastError = toErrorMessage(error);
    } finally {
      job.running = false;
      job.lastDurationMs = this.now() - startedAtMs;
      job.lastLeadersProcessed = leadersProcessed;
      job.lastRecordsSeen = recordsSeen;
      job.lastRecordsInserted = recordsInserted;
      this.status.lastUpdatedAtMs = this.now();
      this.positionsInFlight = false;
      await this.persistStatus();
    }
  }

  async runTradesPoll(): Promise<void> {
    if (this.tradesInFlight) {
      return;
    }

    this.tradesInFlight = true;
    const job = this.status.trades;
    job.running = true;
    job.lastRunAtMs = this.now();
    job.totalRuns += 1;
    const startedAtMs = this.now();

    let leadersProcessed = 0;
    let recordsSeen = 0;
    let recordsInserted = 0;

    try {
      const leaders = await this.store.listActiveLeaders();
      for (const batch of chunk(leaders, this.config.batchSize)) {
        await Promise.all(
          batch.map(async (leader) => {
            const outcome = await this.pollLeaderTrades(leader);
            leadersProcessed += 1;
            recordsSeen += outcome.recordsSeen;
            recordsInserted += outcome.recordsInserted;
          })
        );
      }

      job.lastSuccessAtMs = this.now();
      job.consecutiveFailures = 0;
      job.lastError = undefined;
    } catch (error) {
      job.totalFailures += 1;
      job.consecutiveFailures += 1;
      job.lastFailureAtMs = this.now();
      job.lastError = toErrorMessage(error);
    } finally {
      job.running = false;
      job.lastDurationMs = this.now() - startedAtMs;
      job.lastLeadersProcessed = leadersProcessed;
      job.lastRecordsSeen = recordsSeen;
      job.lastRecordsInserted = recordsInserted;
      this.status.lastUpdatedAtMs = this.now();
      this.tradesInFlight = false;
      await this.persistStatus();
    }
  }

  private async pollLeaderPositions(leader: LeaderRecord): Promise<{
    recordsSeen: number;
    recordsInserted: number;
    pagesFetched: number;
  }> {
    const startedAtMs = this.now();
    const snapshotAt = new Date(startedAtMs);
    const walletSet = new Set<string>();
    const allPositions: DataApiPosition[] = [];
    let offset = 0;
    let pagesFetched = 0;

    for (let pageIndex = 0; pageIndex < this.config.maxPagesPerLeader; pageIndex += 1) {
      const page = await this.withRetry(
        "positions",
        leader,
        () =>
          this.dataApi.fetchPositionsPage({
            user: leader.profileAddress,
            limit: this.config.pageLimit,
            offset,
            sizeThreshold: 0,
            sortBy: "CURRENT",
            sortDirection: "DESC"
          }),
        { offset }
      );

      pagesFetched += 1;
      if (page.length === 0) {
        break;
      }

      for (const position of page) {
        allPositions.push(position);
        if (position.proxyWallet) {
          walletSet.add(position.proxyWallet);
        }
      }

      if (page.length < this.config.pageLimit) {
        break;
      }

      offset += page.length;
    }

    const recordsInserted = await this.store.saveLeaderPositionSnapshots({
      leaderId: leader.id,
      snapshotAt,
      snapshotAtMs: startedAtMs,
      positions: allPositions
    });

    await this.store.upsertLeaderWallets(leader.id, [...walletSet], new Date(this.now()));
    await this.store.saveLeaderPollMeta({
      leaderId: leader.id,
      pollKind: "positions",
      meta: {
        lastSuccessAtMs: this.now(),
        lastSnapshotAt: snapshotAt.toISOString(),
        pagesFetched,
        recordsSeen: allPositions.length,
        recordsInserted,
        runDurationMs: this.now() - startedAtMs
      }
    });

    return {
      recordsSeen: allPositions.length,
      recordsInserted,
      pagesFetched
    };
  }

  private async pollLeaderTrades(leader: LeaderRecord): Promise<{
    recordsSeen: number;
    recordsInserted: number;
    pagesFetched: number;
  }> {
    const startedAtMs = this.now();
    const cursorMs = await this.store.getLatestDataApiTradeCursorMs(leader.id);
    const walletSet = new Set<string>();
    const tradeEvents: NormalizedTradeEvent[] = [];
    let offset = 0;
    let pagesFetched = 0;
    let recordsSeen = 0;
    let oldestSeenTradeAtMs: number | undefined;
    let newestSeenTradeAtMs: number | undefined;
    let stopByCursor = false;

    for (let pageIndex = 0; pageIndex < this.config.maxPagesPerLeader; pageIndex += 1) {
      const page = await this.withRetry(
        "trades",
        leader,
        () =>
          this.dataApi.fetchTradesPage({
            user: leader.profileAddress,
            limit: this.config.pageLimit,
            offset,
            takerOnly: this.config.tradesTakerOnly
          }),
        { offset, cursorMs }
      );

      pagesFetched += 1;
      if (page.length === 0) {
        break;
      }

      recordsSeen += page.length;
      const pageTimestamps = page.map((trade) => toUnixMs(trade.timestamp));
      const pageOldestMs = Math.min(...pageTimestamps);
      const pageNewestMs = Math.max(...pageTimestamps);
      oldestSeenTradeAtMs = oldestSeenTradeAtMs === undefined ? pageOldestMs : Math.min(oldestSeenTradeAtMs, pageOldestMs);
      newestSeenTradeAtMs = newestSeenTradeAtMs === undefined ? pageNewestMs : Math.max(newestSeenTradeAtMs, pageNewestMs);

      for (const trade of page) {
        if (trade.proxyWallet) {
          walletSet.add(trade.proxyWallet);
        }

        const leaderFillAtMs = toUnixMs(trade.timestamp);
        if (cursorMs !== null && leaderFillAtMs < cursorMs) {
          continue;
        }

        tradeEvents.push(normalizeTradeEvent(leader, trade, startedAtMs));
      }

      if (cursorMs !== null && page.every((trade) => toUnixMs(trade.timestamp) < cursorMs)) {
        stopByCursor = true;
        break;
      }

      if (page.length < this.config.pageLimit) {
        break;
      }

      offset += page.length;
    }

    const recordsInserted = await this.store.saveLeaderTradeEvents({
      leaderId: leader.id,
      events: tradeEvents
    });

    const nextCursorMs =
      newestSeenTradeAtMs === undefined
        ? cursorMs
        : cursorMs === null
          ? newestSeenTradeAtMs
          : Math.max(cursorMs, newestSeenTradeAtMs);

    await this.store.upsertLeaderWallets(leader.id, [...walletSet], new Date(this.now()));
    await this.store.saveLeaderPollMeta({
      leaderId: leader.id,
      pollKind: "trades",
      meta: {
        lastSuccessAtMs: this.now(),
        pagesFetched,
        recordsSeen,
        recordsInserted,
        oldestSeenTradeAtMs,
        newestSeenTradeAtMs,
        cursorMs: nextCursorMs,
        stopByCursor,
        runDurationMs: this.now() - startedAtMs
      }
    });

    return {
      recordsSeen,
      recordsInserted,
      pagesFetched
    };
  }

  private async withRetry<T>(
    pollKind: "positions" | "trades",
    leader: LeaderRecord,
    fetchFn: () => Promise<T>,
    context: Record<string, unknown>
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fetchFn();
      } catch (error) {
        const retryable = isRetryableDataApiError(error);
        const message = toErrorMessage(error);

        if (!retryable || attempt >= this.config.maxRetries) {
          await this.store.savePollFailure({
            leaderId: leader.id,
            pollKind,
            message,
            retryable,
            attemptCount: attempt + 1,
            context
          });
          throw error;
        }

        const delay = this.computeBackoffDelayMs(attempt);
        await this.sleep(delay);
        attempt += 1;
      }
    }
  }

  private computeBackoffDelayMs(attempt: number): number {
    const exponential = this.config.backoffBaseMs * 2 ** attempt;
    const capped = Math.min(exponential, this.config.backoffMaxMs);
    const jitter = Math.floor(Math.random() * Math.min(250, this.config.backoffBaseMs));
    return capped + jitter;
  }

  private async persistStatus(): Promise<void> {
    try {
      await this.store.saveWorkerPollStatus(this.getStatus());
    } catch (error) {
      workerLogger.error("leader.poll_status_persist_failed", {
        error: toErrorMessage(error)
      });
    }
  }
}

function newJobSnapshot(): PollJobSnapshot {
  return {
    running: false,
    totalRuns: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    lastLeadersProcessed: 0,
    lastRecordsSeen: 0,
    lastRecordsInserted: 0
  };
}

function normalizeTradeEvent(leader: LeaderRecord, trade: DataApiTrade, detectedAtMs: number): NormalizedTradeEvent {
  const transactionHash = trade.transactionHash?.toLowerCase();
  const leaderFillAtMs = toUnixMs(trade.timestamp);
  const shares = Number(trade.size);
  const price = Number(trade.price);
  const tokenId = trade.asset;
  const marketId = trade.conditionId;
  const side = trade.side;
  const notionalUsd = shares * price;
  const triggerId = [
    "data-api",
    leader.id,
    transactionHash ?? "nohash",
    tokenId,
    side,
    trimNumeric(shares),
    trimNumeric(price),
    String(leaderFillAtMs)
  ].join(":");
  const canonicalKey = buildCanonicalTradeKey({
    leaderId: leader.id,
    walletAddress: trade.proxyWallet,
    tokenId,
    side,
    shares,
    price,
    leaderFillAtMs
  });

  return {
    triggerId,
    canonicalKey,
    transactionHash,
    leaderFillAtMs,
    detectedAtMs,
    marketId,
    tokenId,
    outcome: trade.outcome,
    side,
    shares,
    price,
    notionalUsd,
    payload: {
      source: "DATA_API",
      raw: trade
    }
  };
}

function trimNumeric(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(12)));
}

function toUnixMs(value: number): number {
  return value > 2_000_000_000 ? Math.floor(value) : Math.floor(value * 1000);
}

function chunk<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) {
    return [items];
  }

  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    batches.push(items.slice(index, index + chunkSize));
  }
  return batches;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
