import { decodeChainTrigger, encodeAddressTopic } from "./decoder.js";
import { workerLogger } from "../logger.js";
import type {
  ChainPipelineConfig,
  ChainPipelineStatus,
  ChainTriggerStore,
  ReconcileTask,
  TriggerDeduper
} from "./types.js";
import { ORDER_FILLED_TOPIC0, ORDERS_MATCHED_TOPIC0 } from "./types.js";

const WS_READY_STATE_OPEN = 1;

interface WsLike {
  readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  close(): void;
}

interface ChainTriggerPipelineOptions {
  store: ChainTriggerStore;
  deduper: TriggerDeduper;
  config: ChainPipelineConfig;
  now?: () => number;
  createSocket?: (url: string) => WsLike;
}

export class ChainTriggerPipeline {
  private readonly store: ChainTriggerStore;
  private readonly deduper: TriggerDeduper;
  private readonly config: ChainPipelineConfig;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => WsLike;
  private readonly walletToLeader = new Map<string, string>();
  private readonly subscriptionIds = new Set<string>();
  private readonly reconcileQueue: ReconcileTask[] = [];
  private readonly reconcileDedupeByKey = new Map<string, number>();
  private readonly status: ChainPipelineStatus;
  private socket?: WsLike;
  private walletSignature = "";
  private refreshTimer?: NodeJS.Timeout;
  private nextRpcRequestId = 1;

  constructor(options: ChainTriggerPipelineOptions) {
    this.store = options.store;
    this.deduper = options.deduper;
    this.config = options.config;
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

    this.status = {
      enabled: this.config.enabled,
      connected: false,
      watchedWalletCount: 0,
      activeSubscriptionCount: 0,
      receivedMessages: 0,
      decodedTriggers: 0,
      persistedTriggers: 0,
      duplicateTriggers: 0,
      rollbackTriggers: 0,
      queuedReconciles: 0,
      reconnectCount: 0,
      queueSize: 0
    };
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    await this.refreshLeaderWalletDirectory();
    this.connect();
    this.refreshTimer = setInterval(() => {
      void this.refreshLeaderWalletDirectory();
    }, this.config.walletRefreshIntervalMs);
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }

    this.subscriptionIds.clear();
    this.status.activeSubscriptionCount = 0;
    this.status.connected = false;
  }

  getStatus(): ChainPipelineStatus {
    return {
      ...this.status
    };
  }

  getPendingReconcileTasks(limit = 50): ReconcileTask[] {
    if (limit <= 0) {
      return [];
    }

    return this.reconcileQueue.slice(-limit);
  }

  async refreshLeaderWalletDirectory(): Promise<void> {
    try {
      const links = await this.store.listActiveLeaderWallets();
      const nextMap = new Map<string, string>();
      for (const link of links) {
        nextMap.set(link.walletAddress.toLowerCase(), link.leaderId);
      }

      const signature = [...nextMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([wallet, leaderId]) => `${wallet}:${leaderId}`)
        .join("|");

      if (signature === this.walletSignature) {
        this.status.watchedWalletCount = nextMap.size;
        return;
      }

      this.walletToLeader.clear();
      for (const [wallet, leaderId] of nextMap.entries()) {
        this.walletToLeader.set(wallet, leaderId);
      }

      this.walletSignature = signature;
      this.status.watchedWalletCount = this.walletToLeader.size;

      if (this.isSocketOpen()) {
        this.reconnect("wallet directory changed");
      }
    } catch (error) {
      await this.handleError("Failed to refresh chain wallet directory", {
        error: toErrorMessage(error)
      });
    }
  }

  async processNotification(payload: unknown, wsReceivedAtMs = this.now()): Promise<void> {
    const decoded = decodeChainTrigger(payload, this.walletToLeader, wsReceivedAtMs);
    if (!decoded) {
      return;
    }

    this.status.decodedTriggers += 1;
    this.status.lastTriggerAtMs = wsReceivedAtMs;
    this.status.lastLeaderFillAtMs = decoded.leaderFillAtMs;
    this.status.lastWsReceivedAtMs = decoded.wsReceivedAtMs;
    this.status.lastDetectedAtMs = decoded.detectedAtMs;
    this.status.lastTriggerLagMs = decoded.detectedAtMs - decoded.leaderFillAtMs;
    this.status.lastWsLagMs = decoded.wsReceivedAtMs - decoded.leaderFillAtMs;
    this.status.lastDetectLagMs = decoded.detectedAtMs - decoded.wsReceivedAtMs;

    if (decoded.removed) {
      this.status.rollbackTriggers += 1;
      await this.store.markTriggerRollback({
        triggerId: decoded.triggerId,
        leaderId: decoded.leaderId,
        tokenId: decoded.tokenId,
        removedAtMs: wsReceivedAtMs,
        payload: {
          event: decoded.event,
          transactionHash: decoded.transactionHash,
          logIndex: decoded.logIndex
        }
      });

      const task: ReconcileTask = {
        leaderId: decoded.leaderId,
        tokenId: decoded.tokenId,
        triggerId: decoded.triggerId,
        reason: "CHAIN_REORG",
        enqueuedAtMs: wsReceivedAtMs
      };
      this.enqueueReconcile(task);
      await this.store.recordReconcileTask(task);
      return;
    }

    const accepted = await this.deduper.reserve(decoded.triggerId, this.config.dedupeTtlSeconds);
    if (!accepted) {
      this.status.duplicateTriggers += 1;
      return;
    }

    await this.store.persistChainTrigger(decoded);
    this.status.persistedTriggers += 1;
  }

  private connect(): void {
    if (!this.config.enabled || this.socket) {
      return;
    }

    const socket = this.createSocket(this.config.wsUrl);
    this.socket = socket;

    socket.on("open", () => {
      this.status.connected = true;
      this.status.lastError = undefined;
      this.subscribeCurrentWallets();
    });

    socket.on("message", (data) => {
      this.status.receivedMessages += 1;
      this.status.lastMessageAtMs = this.now();
      void this.handleRawMessage(data);
    });

    socket.on("close", () => {
      this.status.connected = false;
      this.subscriptionIds.clear();
      this.status.activeSubscriptionCount = 0;
      this.socket = undefined;
    });

    socket.on("error", (error) => {
      this.status.lastError = error.message;
    });
  }

  private reconnect(reason: string): void {
    this.status.reconnectCount += 1;
    this.status.lastError = `reconnect: ${reason}`;
    if (this.socket) {
      this.socket.close();
      this.socket = undefined;
    }
    this.subscriptionIds.clear();
    this.status.activeSubscriptionCount = 0;
    this.connect();
  }

  private async handleRawMessage(data: unknown): Promise<void> {
    const raw = rawToString(data);
    if (!raw) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.status.lastError = "Failed to parse Alchemy WS message";
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const object = parsed as Record<string, unknown>;
    if (typeof object.id === "number" && typeof object.result === "string") {
      this.subscriptionIds.add(object.result);
      this.status.activeSubscriptionCount = this.subscriptionIds.size;
      return;
    }

    if (object.method === "eth_subscription") {
      try {
        await this.processNotification(parsed, this.now());
      } catch (error) {
        await this.handleError("Failed to process chain notification", {
          error: toErrorMessage(error)
        });
      }
      return;
    }

    if (object.error) {
      this.status.lastError = JSON.stringify(object.error);
    }
  }

  private subscribeCurrentWallets(): void {
    if (!this.isSocketOpen()) {
      return;
    }

    const walletTopics = [...this.walletToLeader.keys()].map((wallet) => encodeAddressTopic(wallet));
    if (walletTopics.length === 0) {
      return;
    }

    const contracts = this.config.exchangeContracts.map((address) => address.toLowerCase());
    for (const contract of contracts) {
      this.sendRpc({
        jsonrpc: "2.0",
        id: this.nextRpcRequestId++,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: contract,
            topics: [ORDER_FILLED_TOPIC0, null, walletTopics, null]
          }
        ]
      });

      this.sendRpc({
        jsonrpc: "2.0",
        id: this.nextRpcRequestId++,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: contract,
            topics: [ORDERS_MATCHED_TOPIC0, null, walletTopics]
          }
        ]
      });
    }
  }

  private sendRpc(payload: unknown): void {
    if (!this.socket) {
      return;
    }

    this.socket.send(JSON.stringify(payload));
  }

  private enqueueReconcile(task: ReconcileTask): void {
    const key = `${task.leaderId}:${task.tokenId}`;
    const lastAt = this.reconcileDedupeByKey.get(key);
    if (lastAt !== undefined && task.enqueuedAtMs - lastAt < 5_000) {
      return;
    }

    this.reconcileDedupeByKey.set(key, task.enqueuedAtMs);
    this.reconcileQueue.push(task);
    if (this.reconcileQueue.length > this.config.reconcileQueueMaxSize) {
      const removed = this.reconcileQueue.shift();
      if (removed) {
        const removedKey = `${removed.leaderId}:${removed.tokenId}`;
        const known = this.reconcileDedupeByKey.get(removedKey);
        if (known !== undefined && known <= removed.enqueuedAtMs) {
          this.reconcileDedupeByKey.delete(removedKey);
        }
      }
    }

    this.status.queuedReconciles += 1;
    this.status.queueSize = this.reconcileQueue.length;
  }

  private isSocketOpen(): boolean {
    return this.socket !== undefined && this.socket.readyState === WS_READY_STATE_OPEN;
  }

  private async handleError(message: string, context: Record<string, unknown> = {}): Promise<void> {
    this.status.lastError = message;
    try {
      await this.store.recordPipelineError(message, context);
    } catch (error) {
      workerLogger.error("chain.pipeline_error_persist_failed", {
        message,
        context,
        error: toErrorMessage(error)
      });
    }
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
