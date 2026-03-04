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
  private starvationMonitorTimer?: NodeJS.Timeout;
  private starvationActive = false;
  private readonly starvationSamples: Array<{ atMs: number; received: number; recognized: number }> = [];

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
      unknownMessages: 0,
      parseErrors: 0,
      recognizedEventMessages: 0,
      degraded: false,
      reconnectCount: 0
    };
  }

  start(): void {
    this.status.enabled = this.config.enabled;
    if (!this.config.enabled) {
      return;
    }
    if (this.wsClient) {
      return;
    }

    this.wsClient = new UserChannelWsClient({
      url: this.config.url,
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
      passphrase: this.config.passphrase,
      now: this.now,
      onTrade: (trade) => this.handleTradeCandidate(trade),
      onOrder: (order) => this.handleOrderCandidate(order),
      onError: (message) => {
        this.status.lastError = message;
      }
    });

    this.wsClient.connect();
    this.startParseHealthMonitor();
  }

  stop(): void {
    this.stopParseHealthMonitor();
    this.wsClient?.disconnect();
    this.wsClient = undefined;
    this.status.connected = false;
    this.status.degraded = false;
    this.status.degradedReason = undefined;
    this.status.enabled = false;
    this.starvationSamples.length = 0;
    this.starvationActive = false;
  }

  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) {
      this.status.enabled = enabled;
      return;
    }

    this.config.enabled = enabled;
    this.status.enabled = enabled;
    if (enabled) {
      this.start();
      return;
    }

    this.stop();
  }

  setParseStarvationConfig(input: { windowSeconds: number; minMessages: number }): void {
    const nextWindowMs = Math.max(1_000, Math.trunc(input.windowSeconds * 1000));
    const nextMinMessages = Math.max(1, Math.trunc(input.minMessages));
    const nextCheckIntervalMs = computeParseStarvationCheckIntervalMs(nextWindowMs);

    const changed =
      this.config.parseStarvationWindowMs !== nextWindowMs ||
      this.config.parseStarvationMinMessages !== nextMinMessages ||
      this.config.parseStarvationCheckIntervalMs !== nextCheckIntervalMs;

    if (!changed) {
      return;
    }

    this.config.parseStarvationWindowMs = nextWindowMs;
    this.config.parseStarvationMinMessages = nextMinMessages;
    this.config.parseStarvationCheckIntervalMs = nextCheckIntervalMs;

    if (this.wsClient) {
      this.startParseHealthMonitor();
    }
  }

  getStatus(): UserChannelStatus {
    const wsMetrics = this.wsClient?.getMetrics();
    const receivedMessages = wsMetrics?.receivedMessages ?? this.status.receivedMessages;
    const tradeMessages = wsMetrics?.tradeMessages ?? this.status.tradeMessages;
    const orderMessages = wsMetrics?.orderMessages ?? this.status.orderMessages;
    const unknownMessages = wsMetrics?.unknownMessages ?? this.status.unknownMessages;
    const parseErrors = wsMetrics?.parseErrors ?? this.status.parseErrors;
    const recognizedEventMessages = wsMetrics?.recognizedEventMessages ?? this.status.recognizedEventMessages;

    return {
      ...this.status,
      connected: wsMetrics?.connected ?? false,
      receivedMessages,
      tradeMessages,
      orderMessages,
      unknownMessages,
      parseErrors,
      recognizedEventMessages,
      lastMessageAtMs: wsMetrics?.lastMessageAtMs ?? this.status.lastMessageAtMs,
      lastTradeAtMs: wsMetrics?.lastTradeAtMs ?? this.status.lastTradeAtMs,
      lastOrderAtMs: wsMetrics?.lastOrderAtMs ?? this.status.lastOrderAtMs,
      lastRecognizedEventAtMs: wsMetrics?.lastRecognizedEventAtMs ?? this.status.lastRecognizedEventAtMs,
      lastUnknownSampleAtMs: wsMetrics?.lastUnknownSampleAtMs ?? this.status.lastUnknownSampleAtMs,
      lastUnknownSampleType: wsMetrics?.lastUnknownSampleType ?? this.status.lastUnknownSampleType,
      lastError: wsMetrics?.lastError ?? this.status.lastError,
      reconnectCount: wsMetrics?.reconnectCount ?? this.status.reconnectCount
    };
  }

  private async handleTradeCandidate(candidate: NormalizedTradeCandidate): Promise<void> {
    const event = candidate.event;

    try {
      const match = await this.store.matchCopyOrderForTrade(event);
      if (!match.order) {
        this.status.unmatchedTrades += 1;
        return;
      }

      this.status.matchedTrades += 1;
      const result = await this.store.ingestTradeFill({
        order: match.order,
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
    try {
      const applied = await this.store.applyOrderUpdate(candidate.event);
      if (applied) {
        this.status.watchedOrders += 1;
      }
    } catch (error) {
      this.status.lastError = toErrorMessage(error);
    }
  }

  private startParseHealthMonitor(): void {
    this.stopParseHealthMonitor();
    this.starvationMonitorTimer = setInterval(() => {
      void this.evaluateParseHealth().catch((error) => {
        this.status.lastError = toErrorMessage(error);
      });
    }, this.config.parseStarvationCheckIntervalMs);
  }

  private stopParseHealthMonitor(): void {
    if (!this.starvationMonitorTimer) {
      return;
    }
    clearInterval(this.starvationMonitorTimer);
    this.starvationMonitorTimer = undefined;
  }

  private async evaluateParseHealth(): Promise<void> {
    const wsMetrics = this.wsClient?.getMetrics();
    if (!wsMetrics) {
      return;
    }

    const nowMs = this.now();
    this.starvationSamples.push({
      atMs: nowMs,
      received: wsMetrics.receivedMessages,
      recognized: wsMetrics.recognizedEventMessages
    });

    const windowStartMs = nowMs - this.config.parseStarvationWindowMs;
    while (this.starvationSamples.length > 0 && this.starvationSamples[0] && this.starvationSamples[0].atMs < windowStartMs) {
      this.starvationSamples.shift();
    }

    if (!wsMetrics.connected || this.starvationSamples.length === 0) {
      if (this.starvationActive) {
        this.starvationActive = false;
        this.status.degraded = false;
        this.status.degradedReason = undefined;
      }
      return;
    }

    const baseline = this.starvationSamples[0];
    if (!baseline) {
      return;
    }

    const receivedInWindow = Math.max(0, wsMetrics.receivedMessages - baseline.received);
    const recognizedInWindow = Math.max(0, wsMetrics.recognizedEventMessages - baseline.recognized);
    const starving = receivedInWindow >= this.config.parseStarvationMinMessages && recognizedInWindow === 0;

    if (starving && !this.starvationActive) {
      this.starvationActive = true;
      this.status.degraded = true;
      this.status.degradedReason = "User-channel parse starvation: messages received but no recognizable trade/order events";
      await this.store.reportFillIssue({
        code: "USER_CHANNEL_PARSE_STARVATION",
        severity: "WARN",
        message: "User-channel WS messages are flowing but no trade/order events are being recognized",
        context: {
          receivedInWindow,
          recognizedInWindow,
          parseStarvationWindowMs: this.config.parseStarvationWindowMs,
          parseStarvationMinMessages: this.config.parseStarvationMinMessages,
          lastMessageAtMs: wsMetrics.lastMessageAtMs ?? null,
          lastUnknownSampleType: wsMetrics.lastUnknownSampleType ?? null
        }
      });
      return;
    }

    if (!starving && this.starvationActive) {
      this.starvationActive = false;
      this.status.degraded = false;
      this.status.degradedReason = undefined;
    }
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function computeParseStarvationCheckIntervalMs(windowMs: number): number {
  return Math.max(5_000, Math.min(30_000, Math.trunc(windowMs / 5)));
}
