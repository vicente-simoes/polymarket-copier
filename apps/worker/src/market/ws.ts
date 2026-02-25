import type { MarketWsMetrics } from "./types.js";

const WS_READY_STATE_OPEN = 1;

export interface MarketPriceUpdate {
  tokenId: string;
  bestBid?: number;
  bestAsk?: number;
  atMs: number;
}

export interface TickSizeUpdate {
  tokenId: string;
  tickSize: number;
  atMs: number;
}

export interface WsLike {
  readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface MarketWsClientOptions {
  url: string;
  now?: () => number;
  createSocket?: (url: string) => WsLike;
  onPriceUpdate?: (update: MarketPriceUpdate) => void | Promise<void>;
  onTickSizeUpdate?: (update: TickSizeUpdate) => void | Promise<void>;
}

export class MarketWsClient {
  private readonly url: string;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => WsLike;
  private readonly onPriceUpdate?: (update: MarketPriceUpdate) => void | Promise<void>;
  private readonly onTickSizeUpdate?: (update: TickSizeUpdate) => void | Promise<void>;
  private readonly watchedTokenIds = new Set<string>();
  private readonly subscribedTokenIds = new Set<string>();
  private socket?: WsLike;
  private connected = false;
  private connectedAtMs?: number;
  private disconnectedAtMs?: number;
  private lastMessageAtMs?: number;
  private lastError?: string;

  constructor(options: MarketWsClientOptions) {
    this.url = options.url;
    this.now = options.now ?? Date.now;
    this.createSocket =
      options.createSocket ??
      ((url) => {
        const websocketCtor = (globalThis as unknown as { WebSocket?: new (targetUrl: string) => unknown }).WebSocket;
        if (!websocketCtor) {
          throw new Error("No WebSocket implementation available");
        }

        return new WebSocketAdapter(new websocketCtor(url) as DomSocketLike);
      });
    this.onPriceUpdate = options.onPriceUpdate;
    this.onTickSizeUpdate = options.onTickSizeUpdate;
  }

  connect(): void {
    if (this.socket) {
      return;
    }

    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.on("open", () => {
      this.connected = true;
      this.connectedAtMs = this.now();
      this.disconnectedAtMs = undefined;
      this.lastError = undefined;
      this.resubscribeAll();
    });

    socket.on("message", (data) => {
      const text = this.rawToString(data);
      if (!text) {
        return;
      }

      this.lastMessageAtMs = this.now();
      this.processMessage(text);
    });

    socket.on("close", () => {
      this.connected = false;
      this.disconnectedAtMs = this.now();
      this.subscribedTokenIds.clear();
      this.socket = undefined;
    });

    socket.on("error", (error) => {
      this.lastError = error.message;
    });
  }

  disconnect(): void {
    if (!this.socket) {
      this.connected = false;
      return;
    }

    this.socket.close();
    this.connected = false;
  }

  setWatchedTokenIds(tokenIds: Iterable<string>): void {
    const next = new Set(tokenIds);

    const toUnsubscribe: string[] = [];
    for (const tokenId of this.subscribedTokenIds) {
      if (!next.has(tokenId)) {
        toUnsubscribe.push(tokenId);
      }
    }

    const toSubscribe: string[] = [];
    for (const tokenId of next) {
      if (!this.subscribedTokenIds.has(tokenId)) {
        toSubscribe.push(tokenId);
      }
    }

    this.watchedTokenIds.clear();
    for (const tokenId of next) {
      this.watchedTokenIds.add(tokenId);
    }

    if (!this.isSocketOpen()) {
      return;
    }

    if (toUnsubscribe.length > 0) {
      this.send({
        type: "unsubscribe",
        channel: "market",
        asset_ids: toUnsubscribe
      });
      for (const tokenId of toUnsubscribe) {
        this.subscribedTokenIds.delete(tokenId);
      }
    }

    if (toSubscribe.length > 0) {
      this.send({
        type: "subscribe",
        channel: "market",
        asset_ids: toSubscribe
      });
      for (const tokenId of toSubscribe) {
        this.subscribedTokenIds.add(tokenId);
      }
    }
  }

  getMetrics(): MarketWsMetrics {
    return {
      connected: this.connected,
      watchedTokenCount: this.watchedTokenIds.size,
      subscribedTokenCount: this.subscribedTokenIds.size,
      connectedAtMs: this.connectedAtMs,
      disconnectedAtMs: this.disconnectedAtMs,
      lastMessageAtMs: this.lastMessageAtMs,
      lastError: this.lastError
    };
  }

  private resubscribeAll(): void {
    if (!this.isSocketOpen()) {
      return;
    }

    const tokenIds = [...this.watchedTokenIds];
    if (tokenIds.length === 0) {
      return;
    }

    this.send({
      type: "subscribe",
      channel: "market",
      asset_ids: tokenIds
    });
    this.subscribedTokenIds.clear();
    for (const tokenId of tokenIds) {
      this.subscribedTokenIds.add(tokenId);
    }
  }

  private isSocketOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === WS_READY_STATE_OPEN;
  }

  private send(payload: unknown): void {
    if (!this.socket) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private processMessage(raw: string): void {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.lastError = "Failed to parse market WS message";
      return;
    }

    if (!payload || typeof payload !== "object") {
      return;
    }

    const eventType = readString(payload, "event_type");
    if (eventType === "price_change") {
      const updates = extractPriceUpdates(payload, this.now());
      for (const update of updates) {
        if (this.onPriceUpdate) {
          void Promise.resolve(this.onPriceUpdate(update)).catch((error: unknown) => {
            this.lastError = error instanceof Error ? error.message : "Price update callback failed";
          });
        }
      }
      return;
    }

    if (eventType === "tick_size_change") {
      const updates = extractTickSizeUpdates(payload, this.now());
      for (const update of updates) {
        if (this.onTickSizeUpdate) {
          void Promise.resolve(this.onTickSizeUpdate(update)).catch((error: unknown) => {
            this.lastError = error instanceof Error ? error.message : "Tick-size update callback failed";
          });
        }
      }
    }
  }

  private rawToString(data: unknown): string | null {
    if (typeof data === "string") {
      return data;
    }

    if (Buffer.isBuffer(data)) {
      return data.toString("utf8");
    }

    if (data instanceof ArrayBuffer) {
      return Buffer.from(data).toString("utf8");
    }

    if (Array.isArray(data) && data.every((item) => item instanceof ArrayBuffer)) {
      return Buffer.concat(data.map((item) => Buffer.from(item))).toString("utf8");
    }

    return null;
  }
}

interface DomSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(event: "open", listener: () => void): void;
  addEventListener(event: "close", listener: () => void): void;
  addEventListener(event: "error", listener: (event: unknown) => void): void;
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
}

class WebSocketAdapter implements WsLike {
  private readonly socket: DomSocketLike;

  constructor(socket: DomSocketLike) {
    this.socket = socket;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "open" | "message" | "close" | "error",
    listener: (() => void) | ((data: unknown) => void) | ((error: Error) => void)
  ): void {
    if (event === "message") {
      this.socket.addEventListener("message", (messageEvent) => {
        (listener as (data: unknown) => void)(messageEvent.data);
      });
      return;
    }

    if (event === "error") {
      this.socket.addEventListener("error", (error) => {
        (listener as (error: Error) => void)(error instanceof Error ? error : new Error("WebSocket error"));
      });
      return;
    }

    if (event === "open") {
      this.socket.addEventListener("open", () => {
        (listener as () => void)();
      });
      return;
    }

    this.socket.addEventListener("close", () => {
      (listener as () => void)();
    });
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }
}

function extractPriceUpdates(payload: object, fallbackNowMs: number): MarketPriceUpdate[] {
  const rawChanges = readArray(payload, "price_changes");
  const fallbackAssetId = readString(payload, "asset_id");
  const fallbackBestBid = readNumber(payload, "best_bid");
  const fallbackBestAsk = readNumber(payload, "best_ask");
  const timestampMs = readTimestampMs(payload, "timestamp") ?? fallbackNowMs;
  const updates: MarketPriceUpdate[] = [];

  if (rawChanges.length > 0) {
    for (const rawChange of rawChanges) {
      if (!rawChange || typeof rawChange !== "object") {
        continue;
      }

      const tokenId = readString(rawChange, "asset_id");
      if (!tokenId) {
        continue;
      }

      const bestBid = readNumber(rawChange, "best_bid");
      const bestAsk = readNumber(rawChange, "best_ask");
      if (bestBid === undefined && bestAsk === undefined) {
        continue;
      }

      updates.push({
        tokenId,
        bestBid,
        bestAsk,
        atMs: readTimestampMs(rawChange, "timestamp") ?? timestampMs
      });
    }
    return updates;
  }

  if (!fallbackAssetId || (fallbackBestBid === undefined && fallbackBestAsk === undefined)) {
    return updates;
  }

  updates.push({
    tokenId: fallbackAssetId,
    bestBid: fallbackBestBid,
    bestAsk: fallbackBestAsk,
    atMs: timestampMs
  });
  return updates;
}

function extractTickSizeUpdates(payload: object, fallbackNowMs: number): TickSizeUpdate[] {
  const timestampMs = readTimestampMs(payload, "timestamp") ?? fallbackNowMs;
  const updates: TickSizeUpdate[] = [];

  const collections = [readArray(payload, "tick_size_changes"), readArray(payload, "changes")];
  for (const collection of collections) {
    for (const entry of collection) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const tokenId = readString(entry, "asset_id");
      const tickSize = readNumber(entry, "tick_size");
      if (!tokenId || tickSize === undefined) {
        continue;
      }

      updates.push({
        tokenId,
        tickSize,
        atMs: readTimestampMs(entry, "timestamp") ?? timestampMs
      });
    }
  }

  if (updates.length > 0) {
    return updates;
  }

  const topLevelTokenId = readString(payload, "asset_id");
  const topLevelTickSize = readNumber(payload, "tick_size");
  if (!topLevelTokenId || topLevelTickSize === undefined) {
    return updates;
  }

  updates.push({
    tokenId: topLevelTokenId,
    tickSize: topLevelTickSize,
    atMs: timestampMs
  });
  return updates;
}

function readArray(payload: object, key: string): unknown[] {
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

function readString(payload: object, key: string): string | undefined {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(payload: object, key: string): number | undefined {
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function readTimestampMs(payload: object, key: string): number | undefined {
  const parsed = readNumber(payload, key);
  if (parsed === undefined) {
    return undefined;
  }

  return parsed < 2_000_000_000 ? parsed * 1000 : parsed;
}
