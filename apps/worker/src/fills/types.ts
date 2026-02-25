export type FillSide = "BUY" | "SELL";

export interface UserTradeFillEvent {
  externalTradeId: string;
  externalOrderIds: string[];
  tokenId: string;
  marketId?: string;
  side: FillSide;
  filledShares: number;
  price: number;
  filledUsdcGross: number;
  feeUsdc: number;
  filledAt: Date;
  payload: Record<string, unknown>;
}

export interface UserOrderUpdateEvent {
  externalOrderId: string;
  tokenId?: string;
  marketId?: string;
  side?: FillSide;
  orderStatus?: "PLACED" | "PARTIALLY_FILLED" | "FILLED" | "CANCELLED";
  matchedShares?: number;
  originalShares?: number;
  updatedAt: Date;
  payload: Record<string, unknown>;
}

export interface FillAttributionCopyOrder {
  id: string;
  copyProfileId: string;
  tokenId: string;
  marketId?: string;
  side: FillSide;
  externalOrderId?: string;
  leaderWeights: Record<string, number>;
  unattributedWeight?: number;
}

export interface FillAllocationResultRow {
  leaderId: string;
  shares: number;
  usdcNet: number;
  feeUsdc: number;
}

export interface IngestTradeFillResult {
  matchedOrder: boolean;
  duplicate: boolean;
  copyFillId?: string;
  copyOrderId?: string;
  allocationsInserted: number;
  ledgerUpdates: number;
  realizedPnlDeltaByLeader: Record<string, number>;
}

export interface FillAttributionStore {
  findCopyOrderForTrade(event: UserTradeFillEvent): Promise<FillAttributionCopyOrder | null>;
  ingestTradeFill(args: {
    order: FillAttributionCopyOrder;
    event: UserTradeFillEvent;
  }): Promise<IngestTradeFillResult>;
  applyOrderUpdate(event: UserOrderUpdateEvent): Promise<boolean>;
}

export interface UserChannelStatus {
  enabled: boolean;
  connected: boolean;
  watchedOrders: number;
  receivedMessages: number;
  tradeMessages: number;
  orderMessages: number;
  matchedTrades: number;
  unmatchedTrades: number;
  duplicateTrades: number;
  fillsPersisted: number;
  allocationsPersisted: number;
  ledgerUpdates: number;
  realizedPnlUpdates: number;
  lastMessageAtMs?: number;
  lastTradeAtMs?: number;
  lastOrderAtMs?: number;
  lastError?: string;
  reconnectCount: number;
}

export interface UserChannelConfig {
  enabled: boolean;
  url: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
}

export interface FillAttributionServiceDeps {
  store: FillAttributionStore;
  config: UserChannelConfig;
  now?: () => number;
}

export interface NormalizedTradeCandidate {
  event: UserTradeFillEvent;
}

export interface NormalizedOrderCandidate {
  event: UserOrderUpdateEvent;
}
