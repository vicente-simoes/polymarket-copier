import type { ClobBookSummary } from "@copybot/shared";
import { ClobRestClient } from "./rest.js";
import type { MarketMetadataRedisStore } from "./redis.js";
import type {
  MarketBookState,
  MarketCacheConfig,
  MarketFreshnessMetrics,
  MarketMetadataSnapshot,
  PriceSource
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
  wsPriceUpdatedAtMs?: number;
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

    const books = await this.restClient.fetchBooks(tokenIds);
    await Promise.all(books.map((book) => this.ingestRestBook(book)));
  }

  async ingestRestBook(book: ClobBookSummary): Promise<void> {
    const now = this.now();
    const entry = this.ensureEntry(book.asset_id);
    entry.marketId = book.market;
    entry.tickSize = book.tick_size;
    entry.minOrderSize = book.min_order_size;
    entry.negRisk = book.neg_risk;
    entry.metadataUpdatedAtMs = now;
    entry.restBestBid = book.bids[0]?.price;
    entry.restBestAsk = book.asks[0]?.price;
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
    entry.wsBestBid = update.bestBid ?? entry.wsBestBid;
    entry.wsBestAsk = update.bestAsk ?? entry.wsBestAsk;
    entry.wsPriceUpdatedAtMs = update.atMs;
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

  async getBookState(tokenId: string): Promise<MarketBookState> {
    const entry = this.ensureEntry(tokenId);
    try {
      await this.ensureMetadata(entry);
      await this.ensureRestPriceWhenNeeded(entry);
    } catch {
      // Keep serving the best-known snapshot; stale markers will block execution upstream.
    }
    return this.toState(entry);
  }

  async getWatchedBookStates(): Promise<MarketBookState[]> {
    const tokenIds = this.getWatchedTokenIds();
    return Promise.all(tokenIds.map((tokenId) => this.getBookState(tokenId)));
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
    const wsPriceFresh =
      entry.wsPriceUpdatedAtMs !== undefined &&
      now - entry.wsPriceUpdatedAtMs <= this.config.wsPriceTtlMs &&
      entry.wsBestBid !== undefined &&
      entry.wsBestAsk !== undefined;

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

  private ensureEntry(tokenId: string): MarketCacheEntry {
    const existing = this.entries.get(tokenId);
    if (existing) {
      return existing;
    }

    const created: MarketCacheEntry = { tokenId };
    this.entries.set(tokenId, created);
    return created;
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

    const wsPriceFresh =
      entry.wsPriceUpdatedAtMs !== undefined &&
      now - entry.wsPriceUpdatedAtMs <= this.config.wsPriceTtlMs &&
      entry.wsBestBid !== undefined &&
      entry.wsBestAsk !== undefined;

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
      priceUpdatedAtMs = entry.wsPriceUpdatedAtMs;
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
}
