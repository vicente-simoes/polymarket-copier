import { createClient } from "redis";
import type { TriggerDeduper } from "./types.js";

const DEFAULT_PREFIX = "copybot:chain-trigger";

interface RedisClientLike {
  setNX(key: string, value: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  quit(): Promise<unknown>;
  isOpen: boolean;
}

export class RedisTriggerDeduper implements TriggerDeduper {
  private readonly client: RedisClientLike;
  private readonly keyPrefix: string;

  constructor(client: RedisClientLike, keyPrefix = DEFAULT_PREFIX) {
    this.client = client;
    this.keyPrefix = keyPrefix;
  }

  static async connect(redisUrl: string, keyPrefix = DEFAULT_PREFIX): Promise<RedisTriggerDeduper> {
    const client = createClient({ url: redisUrl });
    await client.connect();
    return new RedisTriggerDeduper(client as unknown as RedisClientLike, keyPrefix);
  }

  async reserve(triggerId: string, ttlSeconds: number): Promise<boolean> {
    const key = this.key(triggerId);
    const inserted = await this.client.setNX(key, "1");
    if (inserted !== 1) {
      return false;
    }

    await this.client.expire(key, ttlSeconds);
    return true;
  }

  async disconnect(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private key(triggerId: string): string {
    return `${this.keyPrefix}:${triggerId}`;
  }
}

export class InMemoryTriggerDeduper implements TriggerDeduper {
  private readonly now: () => number;
  private readonly entries = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async reserve(triggerId: string, ttlSeconds: number): Promise<boolean> {
    const now = this.now();
    const existingExpiry = this.entries.get(triggerId);
    if (existingExpiry && existingExpiry > now) {
      return false;
    }

    this.entries.set(triggerId, now + ttlSeconds * 1000);
    this.evictExpired(now);
    return true;
  }

  async disconnect(): Promise<void> {
    this.entries.clear();
  }

  private evictExpired(nowMs: number): void {
    for (const [key, expiresAtMs] of this.entries) {
      if (expiresAtMs <= nowMs) {
        this.entries.delete(key);
      }
    }
  }
}
