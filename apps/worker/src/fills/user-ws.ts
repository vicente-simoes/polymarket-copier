import type { FillSide, NormalizedOrderCandidate, NormalizedTradeCandidate } from "./types.js";

const WS_READY_STATE_OPEN = 1;
const CONTROL_FRAME_VALUES = new Set(["PING", "PONG"]);
const TIMESTAMP_SECONDS_THRESHOLD = 2_000_000_000;
const MAX_ACCEPTABLE_TIMESTAMP_MS = 4_102_444_800_000;
const TRADE_EVENT_TYPES = new Set(["TRADE", "TRADE_UPDATE", "MATCHED", "MATCH", "TRADE_MATCHED"]);
const ORDER_EVENT_TYPES = new Set(["ORDER", "PLACEMENT", "CANCEL", "CANCELLED", "CANCELLATION", "UPDATE", "ORDER_UPDATE"]);
const NESTED_EVENT_KEYS = ["payload", "data", "event", "message", "msg"] as const;

export interface WsLike {
  readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

export interface UserChannelWsClientOptions {
  url: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  now?: () => number;
  createSocket?: (url: string) => WsLike;
  onTrade?: (event: NormalizedTradeCandidate) => void | Promise<void>;
  onOrder?: (event: NormalizedOrderCandidate) => void | Promise<void>;
  onMessage?: () => void;
  onError?: (message: string) => void;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
}

export interface UserChannelWsMetrics {
  connected: boolean;
  lastMessageAtMs?: number;
  lastTradeAtMs?: number;
  lastOrderAtMs?: number;
  lastRecognizedEventAtMs?: number;
  lastUnknownSampleAtMs?: number;
  lastUnknownSampleType?: string;
  lastError?: string;
  receivedMessages: number;
  tradeMessages: number;
  orderMessages: number;
  unknownMessages: number;
  parseErrors: number;
  recognizedEventMessages: number;
  reconnectCount: number;
}

export class UserChannelWsClient {
  private static readonly HEARTBEAT_INTERVAL_MS = 10_000;
  private static readonly RECONNECT_DELAY_MS = 3000;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => WsLike;
  private readonly onTrade?: (event: NormalizedTradeCandidate) => void | Promise<void>;
  private readonly onOrder?: (event: NormalizedOrderCandidate) => void | Promise<void>;
  private readonly onMessage?: () => void;
  private readonly onError?: (message: string) => void;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private socket?: WsLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private closedByUser = false;
  private readonly metrics: UserChannelWsMetrics = {
    connected: false,
    receivedMessages: 0,
    tradeMessages: 0,
    orderMessages: 0,
    unknownMessages: 0,
    parseErrors: 0,
    recognizedEventMessages: 0,
    reconnectCount: 0
  };

  constructor(options: UserChannelWsClientOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.passphrase = options.passphrase;
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
    this.onTrade = options.onTrade;
    this.onOrder = options.onOrder;
    this.onMessage = options.onMessage;
    this.onError = options.onError;
    this.heartbeatIntervalMs = normalizePositiveInteger(
      options.heartbeatIntervalMs,
      UserChannelWsClient.HEARTBEAT_INTERVAL_MS
    );
    this.reconnectDelayMs = normalizePositiveInteger(options.reconnectDelayMs, UserChannelWsClient.RECONNECT_DELAY_MS);
  }

  connect(): void {
    if (this.socket) {
      return;
    }
    this.closedByUser = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    const socket = this.createSocket(this.url);
    this.socket = socket;

    socket.on("open", () => {
      this.metrics.connected = true;
      this.metrics.lastError = undefined;
      this.sendSubscribe();
      this.startHeartbeat();
    });

    socket.on("message", (data) => {
      this.metrics.receivedMessages += 1;
      this.metrics.lastMessageAtMs = this.now();
      this.onMessage?.();
      void this.handleRawMessage(data);
    });

    socket.on("close", () => {
      this.metrics.connected = false;
      this.stopHeartbeat();
      this.socket = undefined;
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    });

    socket.on("error", (error) => {
      this.metrics.lastError = error.message;
      this.onError?.(error.message);
    });
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
    this.metrics.connected = false;
  }

  reconnect(): void {
    this.metrics.reconnectCount += 1;
    this.disconnect();
    this.closedByUser = false;
    this.connect();
  }

  getMetrics(): UserChannelWsMetrics {
    return { ...this.metrics };
  }

  private sendSubscribe(): void {
    if (!this.socket || this.socket.readyState !== WS_READY_STATE_OPEN) {
      return;
    }

    this.socket.send(
      JSON.stringify({
        type: "user",
        auth: {
          apiKey: this.apiKey,
          secret: this.apiSecret,
          passphrase: this.passphrase
        }
      })
    );
  }

  private async handleRawMessage(data: unknown): Promise<void> {
    const raw = rawToString(data);
    if (!raw) {
      return;
    }
    const normalized = raw.trim();
    if (normalized.length === 0 || isControlFrame(normalized)) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(normalized);
    } catch {
      this.metrics.parseErrors += 1;
      this.captureError("Failed to parse user-channel WS message");
      return;
    }

    if (Array.isArray(payload)) {
      for (const entry of payload) {
        await this.handleParsedMessage(entry);
      }
      return;
    }

    await this.handleParsedMessage(payload);
  }

  private async handleParsedMessage(payload: unknown): Promise<void> {
    const candidates = extractCandidateRecords(payload);
    for (const candidate of candidates) {
      const trade = parseTradeEventRecord(candidate);
      if (trade) {
        this.metrics.tradeMessages += 1;
        this.metrics.recognizedEventMessages += 1;
        this.metrics.lastTradeAtMs = this.now();
        this.metrics.lastRecognizedEventAtMs = this.now();
        if (this.onTrade) {
          await Promise.resolve(this.onTrade({ event: trade }));
        }
        return;
      }

      const order = parseOrderEventRecord(candidate);
      if (order) {
        this.metrics.orderMessages += 1;
        this.metrics.recognizedEventMessages += 1;
        this.metrics.lastOrderAtMs = this.now();
        this.metrics.lastRecognizedEventAtMs = this.now();
        if (this.onOrder) {
          await Promise.resolve(this.onOrder({ event: order }));
        }
        return;
      }
    }

    this.metrics.unknownMessages += 1;
    this.metrics.lastUnknownSampleAtMs = this.now();
    this.metrics.lastUnknownSampleType = resolveUnknownSampleType(payload);
  }

  private captureError(message: string): void {
    this.metrics.lastError = message;
    this.onError?.(message);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WS_READY_STATE_OPEN) {
        return;
      }
      this.socket.send("PING");
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer || this.socket) {
      return;
    }

    this.metrics.reconnectCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closedByUser || this.socket) {
        return;
      }
      try {
        this.connect();
      } catch (error) {
        this.captureError(error instanceof Error ? error.message : String(error));
        this.scheduleReconnect();
      }
    }, this.reconnectDelayMs);
  }
}

export function parseTradeEvent(payload: unknown) {
  for (const candidate of extractCandidateRecords(payload)) {
    const parsed = parseTradeEventRecord(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

export function parseOrderEvent(payload: unknown) {
  for (const candidate of extractCandidateRecords(payload)) {
    const parsed = parseOrderEventRecord(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function parseTradeEventRecord(record: Record<string, unknown>) {
  const eventType = resolveEventType(record);
  const hasTradeShape =
    readString(record, "asset_id") !== undefined &&
    readNumber(record, "size") !== undefined &&
    readNumber(record, "price") !== undefined &&
    normalizeSide(readString(record, "side")) !== null;
  if (eventType !== "TRADE" && !hasTradeShape) {
    return null;
  }

  const externalTradeId = readString(record, "id") ?? readString(record, "trade_id");
  const tokenId = readString(record, "asset_id");
  const side = normalizeSide(readString(record, "side"));
  const size = readNumber(record, "size");
  const price = readNumber(record, "price");

  if (!externalTradeId || !tokenId || !side || !size || !price) {
    return null;
  }

  const feeUsdc =
    readNumber(record, "fee") ??
    readNumber(record, "fee_usdc") ??
    readNumber(record, "fee_paid") ??
    0;
  const filledUsdcGross = readNumber(record, "filled_usdc") ?? readNumber(record, "usdc") ?? size * price;
  const fallbackNowMs = Date.now();
  const timestampMs = normalizeTimestampMs(
    readNumber(record, "timestamp") ??
    readNumber(record, "matchtime") ??
    readNumber(record, "last_update"),
    fallbackNowMs
  );
  const filledAt = new Date(timestampMs);

  const externalOrderIds = new Set<string>();
  const takerOrderId = readString(record, "taker_order_id");
  if (takerOrderId) {
    externalOrderIds.add(takerOrderId);
  }

  const makerOrders = record.maker_orders;
  if (Array.isArray(makerOrders)) {
    for (const makerOrder of makerOrders) {
      if (!makerOrder || typeof makerOrder !== "object") {
        continue;
      }
      const orderId = readString(makerOrder as Record<string, unknown>, "order_id");
      if (orderId) {
        externalOrderIds.add(orderId);
      }
    }
  }

  return {
    externalTradeId,
    externalOrderIds: [...externalOrderIds],
    tokenId,
    marketId: readString(record, "market") ?? undefined,
    side,
    filledShares: size,
    price,
    filledUsdcGross,
    feeUsdc,
    filledAt,
    payload: toRecord(record)
  };
}

function parseOrderEventRecord(record: Record<string, unknown>) {
  const eventType = resolveEventType(record);
  const typeValue = readString(record, "type")?.toUpperCase();
  const hasOrderShape =
    (readString(record, "id") ?? readString(record, "order_id")) !== undefined &&
    (readString(record, "asset_id") !== undefined || readString(record, "market") !== undefined);
  const isOrderTypeValue = typeValue ? ORDER_EVENT_TYPES.has(typeValue) : false;
  if (eventType !== "ORDER" && !hasOrderShape && !isOrderTypeValue) {
    return null;
  }

  const externalOrderId = readString(record, "id") ?? readString(record, "order_id");
  if (!externalOrderId) {
    return null;
  }

  const updatedAtMs = normalizeTimestampMs(
    readNumber(record, "timestamp") ?? readNumber(record, "last_update"),
    Date.now()
  );

  const originalShares = readNumber(record, "original_size");
  const matchedShares = readNumber(record, "size_matched");
  const type = typeValue;
  let orderStatus: "PLACED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED" | undefined;

  if (type === "CANCELLATION" || type === "CANCELLED" || type === "CANCEL") {
    orderStatus = "CANCELLED";
  } else if (matchedShares !== undefined && originalShares !== undefined && originalShares > 0) {
    if (matchedShares >= originalShares) {
      orderStatus = "FILLED";
    } else if (matchedShares > 0) {
      orderStatus = "PARTIALLY_FILLED";
    } else {
      orderStatus = "PLACED";
    }
  } else if (type === "PLACEMENT") {
    orderStatus = "PLACED";
  }

  return {
    externalOrderId,
    tokenId: readString(record, "asset_id") ?? undefined,
    marketId: readString(record, "market") ?? undefined,
    side: normalizeSide(readString(record, "side")) ?? undefined,
    orderStatus,
    matchedShares,
    originalShares,
    updatedAt: new Date(updatedAtMs),
    payload: toRecord(record)
  };
}

function resolveEventType(record: Record<string, unknown>): "TRADE" | "ORDER" | undefined {
  const rawEventType = readString(record, "event_type") ?? readString(record, "type");
  if (!rawEventType) {
    return undefined;
  }
  const normalized = rawEventType.toUpperCase();
  if (TRADE_EVENT_TYPES.has(normalized)) {
    return "TRADE";
  }
  if (ORDER_EVENT_TYPES.has(normalized)) {
    return "ORDER";
  }
  return undefined;
}

function extractCandidateRecords(payload: unknown): Record<string, unknown>[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const queue: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  const seen = new Set<unknown>();
  const output: Record<string, unknown>[] = [];

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) {
      continue;
    }
    if (seen.has(next.value)) {
      continue;
    }
    seen.add(next.value);

    if (Array.isArray(next.value)) {
      if (next.depth >= 2) {
        continue;
      }
      for (const item of next.value) {
        queue.push({ value: item, depth: next.depth + 1 });
      }
      continue;
    }

    if (typeof next.value !== "object" || next.value === null) {
      continue;
    }

    const record = next.value as Record<string, unknown>;
    output.push(record);
    if (next.depth >= 2) {
      continue;
    }

    for (const key of NESTED_EVENT_KEYS) {
      const nested = record[key];
      if (!nested) {
        continue;
      }
      if (typeof nested === "object") {
        queue.push({ value: nested, depth: next.depth + 1 });
      }
    }
  }

  return output;
}

function resolveUnknownSampleType(payload: unknown): string {
  for (const candidate of extractCandidateRecords(payload)) {
    const kind = resolveEventType(candidate);
    if (kind) {
      return kind;
    }

    const explicitType = readString(candidate, "type") ?? readString(candidate, "event_type");
    if (explicitType) {
      return explicitType.slice(0, 128);
    }
  }

  if (Array.isArray(payload)) {
    return "ARRAY";
  }
  if (payload && typeof payload === "object") {
    return "OBJECT";
  }
  return typeof payload;
}

function normalizeSide(value: string | undefined): FillSide | null {
  if (!value) {
    return null;
  }
  const normalized = value.toUpperCase();
  if (normalized === "BUY" || normalized === "SELL") {
    return normalized;
  }
  return null;
}

function rawToString(data: unknown): string | null {
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

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
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

function toRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeTimestampMs(rawValue: number | undefined, fallbackMs: number): number {
  if (rawValue === undefined || !Number.isFinite(rawValue) || rawValue <= 0) {
    return fallbackMs;
  }

  const candidateMs = rawValue < TIMESTAMP_SECONDS_THRESHOLD ? rawValue * 1000 : rawValue;
  if (!Number.isFinite(candidateMs) || candidateMs <= 0 || candidateMs > MAX_ACCEPTABLE_TIMESTAMP_MS) {
    return fallbackMs;
  }

  return Math.trunc(candidateMs);
}

function isControlFrame(value: string): boolean {
  return CONTROL_FRAME_VALUES.has(value.toUpperCase());
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
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
