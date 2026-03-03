export type FillSide = "BUY" | "SELL";

export type TradeOrderMatchStrategy = "EXTERNAL_ORDER_ID" | "FALLBACK_WINDOW" | "NONE";
export type TradeOrderUnmatchedReason = "NO_ORDER_ID_MATCH" | "NO_FALLBACK_CANDIDATE" | "AMBIGUOUS_FALLBACK";

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

export interface TradeOrderMatchResult {
  order: FillAttributionCopyOrder | null;
  strategy: TradeOrderMatchStrategy;
  unmatchedReason?: TradeOrderUnmatchedReason;
  ambiguousCandidateOrderIds?: string[];
}

export interface FillIssueInput {
  code: string;
  message: string;
  severity: "INFO" | "WARN" | "ERROR";
  context?: Record<string, unknown>;
}

export interface FillReconcileCheckpoint {
  cursorAtMs: number;
  updatedAtMs: number;
}

export interface FillAttributionStore {
  matchCopyOrderForTrade(event: UserTradeFillEvent): Promise<TradeOrderMatchResult>;
  ingestTradeFill(args: {
    order: FillAttributionCopyOrder;
    event: UserTradeFillEvent;
  }): Promise<IngestTradeFillResult>;
  applyOrderUpdate(event: UserOrderUpdateEvent): Promise<boolean>;
  hasCopyFillByExternalTradeId(externalTradeId: string): Promise<boolean>;
  listFollowerAddresses(copyProfileId?: string): Promise<string[]>;
  readFillReconcileCheckpoint(key: string): Promise<FillReconcileCheckpoint | null>;
  writeFillReconcileCheckpoint(key: string, checkpoint: FillReconcileCheckpoint): Promise<void>;
  reportFillIssue(input: FillIssueInput): Promise<void>;
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
  unknownMessages: number;
  parseErrors: number;
  recognizedEventMessages: number;
  lastRecognizedEventAtMs?: number;
  lastUnknownSampleAtMs?: number;
  lastUnknownSampleType?: string;
  degraded: boolean;
  degradedReason?: string;
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
  parseStarvationWindowMs: number;
  parseStarvationMinMessages: number;
  parseStarvationCheckIntervalMs: number;
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

export interface FillHistoryTrade {
  id: string;
  takerOrderId?: string;
  makerOrderIds: string[];
  tokenId: string;
  marketId?: string;
  side?: FillSide;
  size: number;
  price: number;
  feeRateBps?: number;
  matchTimeMs?: number;
  lastUpdateMs?: number;
  makerAddresses: string[];
  payload: Record<string, unknown>;
}

export interface FillTradeHistoryPage {
  trades: FillHistoryTrade[];
  nextCursor?: string;
}

export interface FillTradeHistoryClient {
  fetchTradesPage(args: {
    makerAddress: string;
    afterMs?: number;
    beforeMs?: number;
    nextCursor?: string;
  }): Promise<FillTradeHistoryPage>;
}

export interface FillReconcileStatus {
  enabled: boolean;
  running: boolean;
  totalRuns: number;
  totalFailures: number;
  totalTradesSeen: number;
  totalMatchedOrders: number;
  totalFillsInserted: number;
  totalDuplicates: number;
  totalUnmatched: number;
  totalAmbiguousUnmatched: number;
  lastRunAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastError?: string;
  lastDurationMs?: number;
  lastTradesSeen: number;
  lastMatchedOrders: number;
  lastFillsInserted: number;
  lastDuplicates: number;
  lastUnmatched: number;
  lastAmbiguousUnmatched: number;
}

export interface FillReconcileConfig {
  enabled: boolean;
  intervalMs: number;
  defaultLookbackDays: number;
  maxPagesPerAddress: number;
}

export interface FillReconcileServiceDeps {
  store: FillAttributionStore;
  tradeClient: FillTradeHistoryClient;
  config: FillReconcileConfig;
  preferredMakerAddresses: string[];
  now?: () => number;
}

export interface FillBackfillRunInput {
  apply: boolean;
  lookbackDays: number;
  fromMs?: number;
  toMs?: number;
  copyProfileId?: string;
  maxPagesPerAddress?: number;
}

export interface FillBackfillRunResult {
  tradesSeen: number;
  matchedOrders: number;
  fillsInserted: number;
  duplicates: number;
  unmatched: number;
  ambiguousUnmatched: number;
}
