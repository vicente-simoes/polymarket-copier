import type { FillSide, NormalizedOrderCandidate, NormalizedTradeCandidate } from "./types.js";

const WS_READY_STATE_OPEN = 1;

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
}

export interface UserChannelWsMetrics {
  connected: boolean;
  lastMessageAtMs?: number;
  lastTradeAtMs?: number;
  lastOrderAtMs?: number;
  lastError?: string;
  receivedMessages: number;
  tradeMessages: number;
  orderMessages: number;
  reconnectCount: number;
}

export class UserChannelWsClient {
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
  private socket?: WsLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closedByUser = false;
  private readonly metrics: UserChannelWsMetrics = {
    connected: false,
    receivedMessages: 0,
    tradeMessages: 0,
    orderMessages: 0,
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
    });

    socket.on("message", (data) => {
      this.metrics.receivedMessages += 1;
      this.metrics.lastMessageAtMs = this.now();
      this.onMessage?.();
      void this.handleRawMessage(data);
    });

    socket.on("close", () => {
      this.metrics.connected = false;
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

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.captureError("Failed to parse user-channel WS message");
      return;
    }

    const trade = parseTradeEvent(payload);
    if (trade) {
      this.metrics.tradeMessages += 1;
      this.metrics.lastTradeAtMs = this.now();
      if (this.onTrade) {
        await Promise.resolve(this.onTrade({ event: trade }));
      }
      return;
    }

    const order = parseOrderEvent(payload);
    if (order) {
      this.metrics.orderMessages += 1;
      this.metrics.lastOrderAtMs = this.now();
      if (this.onOrder) {
        await Promise.resolve(this.onOrder({ event: order }));
      }
      return;
    }
  }

  private captureError(message: string): void {
    this.metrics.lastError = message;
    this.onError?.(message);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.socket) {
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
    }, UserChannelWsClient.RECONNECT_DELAY_MS);
  }
}

export function parseTradeEvent(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const eventType = readString(record, "event_type");
  if (eventType !== "trade") {
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
  const timestampSeconds =
    readNumber(record, "timestamp") ??
    readNumber(record, "matchtime") ??
    readNumber(record, "last_update") ??
    Math.floor(Date.now() / 1000);
  const filledAt = new Date(timestampSeconds * 1000);

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

export function parseOrderEvent(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const eventType = readString(record, "event_type");
  if (eventType !== "order") {
    return null;
  }

  const externalOrderId = readString(record, "id") ?? readString(record, "order_id");
  if (!externalOrderId) {
    return null;
  }

  const updatedAtSeconds =
    readNumber(record, "timestamp") ?? readNumber(record, "last_update") ?? Math.floor(Date.now() / 1000);

  const originalShares = readNumber(record, "original_size");
  const matchedShares = readNumber(record, "size_matched");
  const type = readString(record, "type")?.toUpperCase();
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
    updatedAt: new Date(updatedAtSeconds * 1000),
    payload: toRecord(record)
  };
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
