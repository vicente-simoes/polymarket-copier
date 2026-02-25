import { createClient } from "redis";
import type { MarketMetadataSnapshot } from "./types.js";

const DEFAULT_KEY_PREFIX = "copybot:market-metadata";

export interface MarketMetadataRedisStore {
  get(tokenId: string): Promise<MarketMetadataSnapshot | null>;
  set(tokenId: string, snapshot: MarketMetadataSnapshot, ttlSeconds: number): Promise<void>;
  disconnect(): Promise<void>;
}

interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: {
      EX: number;
    }
  ): Promise<unknown>;
  quit(): Promise<unknown>;
  isOpen: boolean;
}

export class RedisMarketMetadataStore implements MarketMetadataRedisStore {
  private readonly client: RedisClientLike;
  private readonly keyPrefix: string;

  constructor(client: RedisClientLike, keyPrefix = DEFAULT_KEY_PREFIX) {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  static async connect(redisUrl: string, keyPrefix = DEFAULT_KEY_PREFIX): Promise<RedisMarketMetadataStore> {
    const client = createClient({ url: redisUrl });
    await client.connect();
    return new RedisMarketMetadataStore(client as unknown as RedisClientLike, keyPrefix);
  }

  async get(tokenId: string): Promise<MarketMetadataSnapshot | null> {
    const raw = await this.client.get(this.key(tokenId));
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as MarketMetadataSnapshot;
      if (
        typeof parsed.tokenId !== "string" ||
        typeof parsed.marketId !== "string" ||
        typeof parsed.tickSize !== "number" ||
        typeof parsed.minOrderSize !== "number" ||
        typeof parsed.negRisk !== "boolean" ||
        typeof parsed.metadataUpdatedAtMs !== "number"
      ) {
        return null;
      }

      return parsed;
    } catch {
      return null;
    }
  }

  async set(tokenId: string, snapshot: MarketMetadataSnapshot, ttlSeconds: number): Promise<void> {
    await this.client.set(this.key(tokenId), JSON.stringify(snapshot), {
      EX: ttlSeconds
    });
  }

  async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private key(tokenId: string): string {
    return `${this.keyPrefix}:${tokenId}`;
  }
}

export class InMemoryMarketMetadataStore implements MarketMetadataRedisStore {
  private readonly cache = new Map<string, { snapshot: MarketMetadataSnapshot; expiresAtMs: number }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(tokenId: string): Promise<MarketMetadataSnapshot | null> {
    const entry = this.cache.get(tokenId);
    if (!entry) {
      return null;
    }

    if (entry.expiresAtMs <= this.now()) {
      this.cache.delete(tokenId);
      return null;
    }

    return entry.snapshot;
  }

  async set(tokenId: string, snapshot: MarketMetadataSnapshot, ttlSeconds: number): Promise<void> {
    this.cache.set(tokenId, {
      snapshot,
      expiresAtMs: this.now() + ttlSeconds * 1000
    });
  }

  async disconnect(): Promise<void> {
    this.cache.clear();
  }
}
