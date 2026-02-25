export type PriceSource = "WS" | "REST" | "NONE";

export interface MarketMetadataSnapshot {
  tokenId: string;
  marketId: string;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  metadataUpdatedAtMs: number;
}

export interface MarketPriceSnapshot {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  priceUpdatedAtMs?: number;
}

export interface MarketBookState {
  tokenId: string;
  marketId?: string;
  tickSize?: number;
  minOrderSize?: number;
  negRisk?: boolean;
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  priceSource: PriceSource;
  isStale: boolean;
  staleReasons: ("MISSING_METADATA" | "STALE_METADATA" | "STALE_PRICE" | "MISSING_PRICE")[];
  metadataUpdatedAtMs?: number;
  priceUpdatedAtMs?: number;
}

export interface MarketWsMetrics {
  connected: boolean;
  watchedTokenCount: number;
  subscribedTokenCount: number;
  connectedAtMs?: number;
  disconnectedAtMs?: number;
  lastMessageAtMs?: number;
  lastError?: string;
}

export interface MarketFreshnessMetrics {
  watchedTokenCount: number;
  staleTokenCount: number;
  wsBackedTokenCount: number;
  restBackedTokenCount: number;
  staleMetadataCount: number;
  stalePriceCount: number;
  snapshotAtMs: number;
}

export interface MarketCacheConfig {
  metadataTtlMs: number;
  wsPriceTtlMs: number;
  restPriceTtlMs: number;
  redisMetadataTtlSeconds: number;
}
