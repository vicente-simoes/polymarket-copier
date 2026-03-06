import type { ClobBookSummary } from "@copybot/shared";
import { ClobRestClient } from "./rest.js";
import type { MarketMetadataRedisStore } from "./redis.js";
import type {
  MarketBookState,
  MarketCacheConfig,
  MarketFreshnessMetrics,
  MarketMetadataSnapshot,
  PriceSource,
  SpreadState
} from "./types.js";
import type { MarketPriceUpdate, TickSizeUpdate } from "./ws.js";

interface MarketCacheEntry {
  tokenId: string;
  marketId?: string;
  tickSize?: number;
  minOrderSize?: number;
  negRisk?: boolean;
  metadataUpdatedAtMs?: number;
  wsBestBid?: number;
  wsBestAsk?: number;
  wsBestBidUpdatedAtMs?: number;
  wsBestAskUpdatedAtMs?: number;
  restBestBid?: number;
  restBestAsk?: number;
  restPriceUpdatedAtMs?: number;
}

export interface MarketCacheOptions {
  restClient: ClobRestClient;
  config: MarketCacheConfig;
  redisStore?: MarketMetadataRedisStore;
  now?: () => number;
}

const SPREAD_STALE_MS = 5_000;

export class MarketCache {
  private readonly restClient: ClobRestClient;
  private readonly redisStore?: MarketMetadataRedisStore;
  private readonly config: MarketCacheConfig;
  private readonly now: () => number;
  private readonly entries = new Map<string, MarketCacheEntry>();
  private readonly watchedTokenIds = new Set<string>();

  constructor(options: MarketCacheOptions) {
    this.restClient = options.restClient;
    this.redisStore = options.redisStore;
    this.config = options.config;
    this.now = options.now ?? Date.now;
  }

  setWatchedTokenIds(tokenIds: Iterable<string>): void {
    this.watchedTokenIds.clear();
    for (const tokenId of tokenIds) {
      this.watchedTokenIds.add(tokenId);
      this.ensureEntry(tokenId);
    }
  }

  getWatchedTokenIds(): string[] {
    return [...this.watchedTokenIds];
  }

  async warmWatchedBooks(): Promise<void> {
    const tokenIds = this.getWatchedTokenIds();
    if (tokenIds.length === 0) {
      return;
    }

    for (const batch of chunkTokens(tokenIds, 100)) {
      try {
        const books = await this.restClient.fetchBooks(batch);
        await Promise.all(books.map((book) => this.ingestRestBook(book)));
        const hydratedTokenIds = new Set(books.map((book) => book.asset_id));
        const missingTokenIds = batch.filter((tokenId) => !hydratedTokenIds.has(tokenId));
        if (missingTokenIds.length === 0) {
          continue;
        }

        await this.warmTokensIndividually(missingTokenIds);
        continue;
      } catch {
        // Some CLOB deployments reject oversized or mixed batches. Fall back to per-token hydration.
      }

      await this.warmTokensIndividually(batch);
    }
  }

  async ingestRestBook(book: ClobBookSummary): Promise<void> {
    const now = this.now();
    const entry = this.ensureEntry(book.asset_id);
    entry.marketId = book.market;
    entry.tickSize = book.tick_size;
    entry.minOrderSize = book.min_order_size;
    entry.negRisk = book.neg_risk;
    entry.metadataUpdatedAtMs = now;
    entry.restBestBid = bestBidFromLevels(book.bids);
    entry.restBestAsk = bestAskFromLevels(book.asks);
    entry.restPriceUpdatedAtMs = now;

    if (this.redisStore) {
      await this.redisStore.set(
        book.asset_id,
        {
          tokenId: book.asset_id,
          marketId: book.market,
          tickSize: book.tick_size,
          minOrderSize: book.min_order_size,
          negRisk: book.neg_risk,
          metadataUpdatedAtMs: now
        },
        this.config.redisMetadataTtlSeconds
      );
    }
  }

  ingestWsPrice(update: MarketPriceUpdate): void {
    const entry = this.ensureEntry(update.tokenId);
    if (update.bestBid !== undefined) {
      entry.wsBestBid = update.bestBid;
      entry.wsBestBidUpdatedAtMs = update.atMs;
    }
    if (update.bestAsk !== undefined) {
      entry.wsBestAsk = update.bestAsk;
      entry.wsBestAskUpdatedAtMs = update.atMs;
    }
  }

  async ingestWsTickSize(update: TickSizeUpdate): Promise<void> {
    const entry = this.ensureEntry(update.tokenId);
    entry.tickSize = update.tickSize;
    entry.metadataUpdatedAtMs = update.atMs;

    if (this.redisStore && entry.marketId && entry.minOrderSize !== undefined && entry.negRisk !== undefined) {
      await this.redisStore.set(
        update.tokenId,
        {
          tokenId: update.tokenId,
          marketId: entry.marketId,
          tickSize: update.tickSize,
          minOrderSize: entry.minOrderSize,
          negRisk: entry.negRisk,
          metadataUpdatedAtMs: update.atMs
        },
        this.config.redisMetadataTtlSeconds
      );
    }
  }

  async getBookState(tokenId: string, options?: { wsConnected?: boolean }): Promise<MarketBookState> {
    const entry = this.ensureEntry(tokenId);
    const now = this.now();
    const wsConnected = options?.wsConnected ?? true;
    try {
      await this.ensureMetadata(entry);
      if (wsConnected) {
        await this.ensureRestPriceWhenNeeded(entry);
      } else {
        await this.ensureRestPriceFresh(entry);
      }
    } catch {
      // Keep serving the best-known snapshot; stale markers will block execution upstream.
    }
    const state = this.toState(entry, now);
    return this.withSpreadFields(state, entry, now, wsConnected);
  }

  async getBookStates(tokenIds: Iterable<string>, options?: { wsConnected?: boolean }): Promise<Map<string, MarketBookState>> {
    const uniqueTokenIds = [...new Set([...tokenIds].filter((tokenId) => tokenId.trim().length > 0))];
    const states = await Promise.all(
      uniqueTokenIds.map(async (tokenId) => [tokenId, await this.getBookState(tokenId, options)] as const)
    );
    return new Map(states);
  }

  async getWatchedBookStates(options?: { wsConnected?: boolean }): Promise<MarketBookState[]> {
    const tokenIds = this.getWatchedTokenIds();
    return [...(await this.getBookStates(tokenIds, options)).values()];
  }

  getFreshnessMetrics(snapshotAtMs = this.now()): MarketFreshnessMetrics {
    let staleTokenCount = 0;
    let wsBackedTokenCount = 0;
    let restBackedTokenCount = 0;
    let staleMetadataCount = 0;
    let stalePriceCount = 0;

    for (const tokenId of this.watchedTokenIds) {
      const entry = this.entries.get(tokenId) ?? this.ensureEntry(tokenId);
      const state = this.toState(entry, snapshotAtMs);

      if (state.isStale) {
        staleTokenCount += 1;
      }
      if (state.priceSource === "WS") {
        wsBackedTokenCount += 1;
      }
      if (state.priceSource === "REST") {
        restBackedTokenCount += 1;
      }
      if (state.staleReasons.includes("MISSING_METADATA") || state.staleReasons.includes("STALE_METADATA")) {
        staleMetadataCount += 1;
      }
      if (state.staleReasons.includes("MISSING_PRICE") || state.staleReasons.includes("STALE_PRICE")) {
        stalePriceCount += 1;
      }
    }

    return {
      watchedTokenCount: this.watchedTokenIds.size,
      staleTokenCount,
      wsBackedTokenCount,
      restBackedTokenCount,
      staleMetadataCount,
      stalePriceCount,
      snapshotAtMs
    };
  }

  private async ensureMetadata(entry: MarketCacheEntry): Promise<void> {
    const now = this.now();
    const hasFreshMetadata =
      entry.metadataUpdatedAtMs !== undefined &&
      now - entry.metadataUpdatedAtMs <= this.config.metadataTtlMs &&
      entry.tickSize !== undefined &&
      entry.minOrderSize !== undefined &&
      entry.negRisk !== undefined &&
      entry.marketId !== undefined;

    if (hasFreshMetadata) {
      return;
    }

    if (
      this.redisStore &&
      (entry.tickSize === undefined ||
        entry.minOrderSize === undefined ||
        entry.negRisk === undefined ||
        entry.marketId === undefined)
    ) {
      const cached = await this.redisStore.get(entry.tokenId);
      if (cached) {
        this.applyMetadataSnapshot(entry, cached);
      }
    }

    const stillMissingMetadata =
      entry.tickSize === undefined ||
      entry.minOrderSize === undefined ||
      entry.negRisk === undefined ||
      entry.marketId === undefined ||
      entry.metadataUpdatedAtMs === undefined ||
      now - entry.metadataUpdatedAtMs > this.config.metadataTtlMs;

    if (!stillMissingMetadata) {
      return;
    }

    const book = await this.restClient.fetchBook(entry.tokenId);
    await this.ingestRestBook(book);
  }

  private async ensureRestPriceWhenNeeded(entry: MarketCacheEntry): Promise<void> {
    const now = this.now();
    const wsPriceFresh = this.isWsPriceFresh(entry, now);

    const restPriceFresh =
      entry.restPriceUpdatedAtMs !== undefined &&
      now - entry.restPriceUpdatedAtMs <= this.config.restPriceTtlMs &&
      entry.restBestBid !== undefined &&
      entry.restBestAsk !== undefined;

    if (wsPriceFresh || restPriceFresh) {
      return;
    }

    const book = await this.restClient.fetchBook(entry.tokenId);
    await this.ingestRestBook(book);
  }

  private async ensureRestPriceFresh(entry: MarketCacheEntry): Promise<void> {
    const now = this.now();
    const restPriceFresh =
      entry.restPriceUpdatedAtMs !== undefined &&
      now - entry.restPriceUpdatedAtMs <= this.config.restPriceTtlMs &&
      entry.restBestBid !== undefined &&
      entry.restBestAsk !== undefined;

    if (restPriceFresh) {
      return;
    }

    const book = await this.restClient.fetchBook(entry.tokenId);
    await this.ingestRestBook(book);
  }

  private ensureEntry(tokenId: string): MarketCacheEntry {
    const existing = this.entries.get(tokenId);
    if (existing) {
      return existing;
    }

    const created: MarketCacheEntry = { tokenId };
    this.entries.set(tokenId, created);
    return created;
  }

  private async warmTokensIndividually(tokenIds: Iterable<string>): Promise<void> {
    for (const tokenId of tokenIds) {
      try {
        const book = await this.restClient.fetchBook(tokenId);
        await this.ingestRestBook(book);
      } catch {
        // Best-effort warm-up: leave token unresolved and let stale guards handle it upstream.
      }
    }
  }

  private toState(entry: MarketCacheEntry, now = this.now()): MarketBookState {
    const staleReasons: ("MISSING_METADATA" | "STALE_METADATA" | "STALE_PRICE" | "MISSING_PRICE")[] = [];

    const hasMetadata =
      entry.tickSize !== undefined &&
      entry.minOrderSize !== undefined &&
      entry.negRisk !== undefined &&
      entry.marketId !== undefined;
    if (!hasMetadata) {
      staleReasons.push("MISSING_METADATA");
    } else if (
      entry.metadataUpdatedAtMs === undefined ||
      now - entry.metadataUpdatedAtMs > this.config.metadataTtlMs
    ) {
      staleReasons.push("STALE_METADATA");
    }

    const wsPriceFresh = this.isWsPriceFresh(entry, now);

    const restPriceFresh =
      entry.restPriceUpdatedAtMs !== undefined &&
      now - entry.restPriceUpdatedAtMs <= this.config.restPriceTtlMs &&
      entry.restBestBid !== undefined &&
      entry.restBestAsk !== undefined;

    let priceSource: PriceSource = "NONE";
    let bestBid: number | undefined;
    let bestAsk: number | undefined;
    let priceUpdatedAtMs: number | undefined;

    if (wsPriceFresh) {
      priceSource = "WS";
      bestBid = entry.wsBestBid;
      bestAsk = entry.wsBestAsk;
      priceUpdatedAtMs = this.wsPriceUpdatedAtMs(entry);
    } else if (restPriceFresh) {
      priceSource = "REST";
      bestBid = entry.restBestBid;
      bestAsk = entry.restBestAsk;
      priceUpdatedAtMs = entry.restPriceUpdatedAtMs;
    } else {
      const hasAnyPrice =
        entry.wsBestBid !== undefined ||
        entry.wsBestAsk !== undefined ||
        entry.restBestBid !== undefined ||
        entry.restBestAsk !== undefined;
      staleReasons.push(hasAnyPrice ? "STALE_PRICE" : "MISSING_PRICE");
    }

    const midPrice =
      bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;

    return {
      tokenId: entry.tokenId,
      marketId: entry.marketId,
      tickSize: entry.tickSize,
      minOrderSize: entry.minOrderSize,
      negRisk: entry.negRisk,
      bestBid,
      bestAsk,
      midPrice,
      priceSource,
      wsConnected: false,
      spreadState: "UNAVAILABLE",
      isStale: staleReasons.length > 0,
      staleReasons,
      metadataUpdatedAtMs: entry.metadataUpdatedAtMs,
      priceUpdatedAtMs
    };
  }

  private applyMetadataSnapshot(entry: MarketCacheEntry, snapshot: MarketMetadataSnapshot): void {
    entry.marketId = snapshot.marketId;
    entry.tickSize = snapshot.tickSize;
    entry.minOrderSize = snapshot.minOrderSize;
    entry.negRisk = snapshot.negRisk;
    entry.metadataUpdatedAtMs = snapshot.metadataUpdatedAtMs;
  }

  private isWsPriceFresh(entry: MarketCacheEntry, now: number): boolean {
    const bidFresh =
      entry.wsBestBid !== undefined &&
      entry.wsBestBidUpdatedAtMs !== undefined &&
      now - entry.wsBestBidUpdatedAtMs <= this.config.wsPriceTtlMs;
    const askFresh =
      entry.wsBestAsk !== undefined &&
      entry.wsBestAskUpdatedAtMs !== undefined &&
      now - entry.wsBestAskUpdatedAtMs <= this.config.wsPriceTtlMs;
    return bidFresh && askFresh;
  }

  private wsPriceUpdatedAtMs(entry: MarketCacheEntry): number | undefined {
    if (entry.wsBestBidUpdatedAtMs === undefined || entry.wsBestAskUpdatedAtMs === undefined) {
      return undefined;
    }
    // A two-sided WS quote is only as fresh as its oldest side.
    return Math.min(entry.wsBestBidUpdatedAtMs, entry.wsBestAskUpdatedAtMs);
  }

  private withSpreadFields(
    state: MarketBookState,
    entry: MarketCacheEntry,
    now: number,
    wsConnected: boolean
  ): MarketBookState {
    const spreadView = wsConnected
      ? this.computeWsSpreadView(entry, now)
      : this.computeRestSpreadView(entry, now);

    return {
      ...state,
      wsConnected,
      spreadState: spreadView.spreadState,
      spreadUsd: spreadView.spreadUsd,
      quoteUpdatedAtMs: spreadView.quoteUpdatedAtMs
    };
  }

  private computeWsSpreadView(
    entry: MarketCacheEntry,
    now: number
  ): { spreadState: SpreadState; spreadUsd?: number; quoteUpdatedAtMs?: number } {
    const quoteUpdatedAtMs = this.wsPriceUpdatedAtMs(entry);
    if (
      quoteUpdatedAtMs === undefined ||
      entry.wsBestBid === undefined ||
      entry.wsBestAsk === undefined ||
      !Number.isFinite(entry.wsBestBid) ||
      !Number.isFinite(entry.wsBestAsk) ||
      entry.wsBestAsk < entry.wsBestBid
    ) {
      return { spreadState: "UNAVAILABLE" };
    }

    const spreadUsd = entry.wsBestAsk - entry.wsBestBid;
    const ageMs = Math.max(0, now - quoteUpdatedAtMs);
    if (ageMs > SPREAD_STALE_MS) {
      return { spreadState: "STALE", quoteUpdatedAtMs };
    }

    return { spreadState: "LIVE", spreadUsd, quoteUpdatedAtMs };
  }

  private computeRestSpreadView(
    entry: MarketCacheEntry,
    now: number
  ): { spreadState: SpreadState; spreadUsd?: number; quoteUpdatedAtMs?: number } {
    const quoteUpdatedAtMs = entry.restPriceUpdatedAtMs;
    if (
      quoteUpdatedAtMs === undefined ||
      entry.restBestBid === undefined ||
      entry.restBestAsk === undefined ||
      !Number.isFinite(entry.restBestBid) ||
      !Number.isFinite(entry.restBestAsk) ||
      entry.restBestAsk < entry.restBestBid
    ) {
      return { spreadState: "UNAVAILABLE" };
    }

    const spreadUsd = entry.restBestAsk - entry.restBestBid;
    const ageMs = Math.max(0, now - quoteUpdatedAtMs);
    if (ageMs > this.config.restPriceTtlMs) {
      return { spreadState: "STALE", quoteUpdatedAtMs };
    }

    return { spreadState: "LIVE", spreadUsd, quoteUpdatedAtMs };
  }
}

function chunkTokens(tokenIds: string[], size: number): string[][] {
  if (size <= 0 || tokenIds.length <= size) {
    return [tokenIds];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < tokenIds.length; index += size) {
    chunks.push(tokenIds.slice(index, index + size));
  }
  return chunks;
}

function bestBidFromLevels(levels: Array<{ price: number; size: number }>): number | undefined {
  let best: number | undefined;
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.price <= 0 || level.size <= 0) {
      continue;
    }
    if (best === undefined || level.price > best) {
      best = level.price;
    }
  }
  return best;
}

function bestAskFromLevels(levels: Array<{ price: number; size: number }>): number | undefined {
  let best: number | undefined;
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.price <= 0 || level.size <= 0) {
      continue;
    }
    if (best === undefined || level.price < best) {
      best = level.price;
    }
  }
  return best;
}
