import type {
  FillAttributionServiceDeps,
  NormalizedOrderCandidate,
  NormalizedTradeCandidate,
  UserChannelStatus
} from "./types.js";
import { UserChannelWsClient } from "./user-ws.js";

export class FillAttributionService {
  private readonly store: FillAttributionServiceDeps["store"];
  private readonly config: FillAttributionServiceDeps["config"];
  private readonly now: () => number;
  private readonly status: UserChannelStatus;
  private wsClient?: UserChannelWsClient;

  constructor(deps: FillAttributionServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.now = deps.now ?? Date.now;
    this.status = {
      enabled: deps.config.enabled,
      connected: false,
      watchedOrders: 0,
      receivedMessages: 0,
      tradeMessages: 0,
      orderMessages: 0,
      matchedTrades: 0,
      unmatchedTrades: 0,
      duplicateTrades: 0,
      fillsPersisted: 0,
      allocationsPersisted: 0,
      ledgerUpdates: 0,
      realizedPnlUpdates: 0,
      reconnectCount: 0
    };
  }

  start(): void {
    if (!this.config.enabled) {
      return;
    }

    this.wsClient = new UserChannelWsClient({
      url: this.config.url,
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      passphrase: this.config.passphrase,
      now: this.now,
      onMessage: () => {
        this.status.receivedMessages += 1;
        this.status.lastMessageAtMs = this.now();
      },
      onTrade: (trade) => this.handleTradeCandidate(trade),
      onOrder: (order) => this.handleOrderCandidate(order),
      onError: (message) => {
        this.status.lastError = message;
      }
    });

    this.wsClient.connect();
  }

  stop(): void {
    this.wsClient?.disconnect();
    this.wsClient = undefined;
    this.status.connected = false;
  }

  getStatus(): UserChannelStatus {
    const wsMetrics = this.wsClient?.getMetrics();
    return {
      ...this.status,
      connected: wsMetrics?.connected ?? false,
      lastMessageAtMs: wsMetrics?.lastMessageAtMs ?? this.status.lastMessageAtMs,
      lastTradeAtMs: wsMetrics?.lastTradeAtMs ?? this.status.lastTradeAtMs,
      lastOrderAtMs: wsMetrics?.lastOrderAtMs ?? this.status.lastOrderAtMs,
      lastError: wsMetrics?.lastError ?? this.status.lastError,
      reconnectCount: wsMetrics?.reconnectCount ?? this.status.reconnectCount
    };
  }

  private async handleTradeCandidate(candidate: NormalizedTradeCandidate): Promise<void> {
    this.status.tradeMessages += 1;
    this.status.lastTradeAtMs = this.now();
    const event = candidate.event;

    try {
      const order = await this.store.findCopyOrderForTrade(event);
      if (!order) {
        this.status.unmatchedTrades += 1;
        return;
      }

      this.status.matchedTrades += 1;
      const result = await this.store.ingestTradeFill({
        order,
        event
      });

      this.status.watchedOrders += 1;
      if (result.duplicate) {
        this.status.duplicateTrades += 1;
        return;
      }

      if (result.copyFillId) {
        this.status.fillsPersisted += 1;
      }
      this.status.allocationsPersisted += result.allocationsInserted;
      this.status.ledgerUpdates += result.ledgerUpdates;
      this.status.realizedPnlUpdates += Object.keys(result.realizedPnlDeltaByLeader).length;
    } catch (error) {
      this.status.lastError = toErrorMessage(error);
    }
  }

  private async handleOrderCandidate(candidate: NormalizedOrderCandidate): Promise<void> {
    this.status.orderMessages += 1;
    this.status.lastOrderAtMs = this.now();
    try {
      const applied = await this.store.applyOrderUpdate(candidate.event);
      if (applied) {
        this.status.watchedOrders += 1;
      }
    } catch (error) {
      this.status.lastError = toErrorMessage(error);
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
