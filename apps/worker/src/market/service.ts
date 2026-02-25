import { MarketCache } from "./cache.js";
import type { MarketBookState, MarketFreshnessMetrics, MarketWsMetrics } from "./types.js";
import { MarketWsClient } from "./ws.js";

export interface MarketDataServiceOptions {
  cache: MarketCache;
  wsClient: MarketWsClient;
  wsEnabled: boolean;
}

export interface MarketDataStatus {
  ws: MarketWsMetrics;
  freshness: MarketFreshnessMetrics;
}

export class MarketDataService {
  private readonly cache: MarketCache;
  private readonly wsClient: MarketWsClient;
  private readonly wsEnabled: boolean;

  constructor(options: MarketDataServiceOptions) {
    this.cache = options.cache;
    this.wsClient = options.wsClient;
    this.wsEnabled = options.wsEnabled;
  }

  start(): void {
    if (this.wsEnabled) {
      this.wsClient.connect();
    }
  }

  stop(): void {
    this.wsClient.disconnect();
  }

  async setWatchedTokenIds(tokenIds: Iterable<string>): Promise<void> {
    this.cache.setWatchedTokenIds(tokenIds);
    this.wsClient.setWatchedTokenIds(tokenIds);
    await this.cache.warmWatchedBooks();
  }

  async refreshWatchedBooks(): Promise<void> {
    await this.cache.warmWatchedBooks();
  }

  async getBookState(tokenId: string): Promise<MarketBookState> {
    return this.cache.getBookState(tokenId);
  }

  async getWatchedBookStates(): Promise<MarketBookState[]> {
    return this.cache.getWatchedBookStates();
  }

  getStatus(): MarketDataStatus {
    return {
      ws: this.wsClient.getMetrics(),
      freshness: this.cache.getFreshnessMetrics()
    };
  }
}
