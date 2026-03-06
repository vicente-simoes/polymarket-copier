import type { ParsedLeaderSettings } from "../config/leader-settings.js";

export type ExecutionSide = "BUY" | "SELL";
export type ExecutionOrderAmountKind = "USD" | "SHARES";
export type ExecutionOrderType = "FAK";

export type ExecutionSkipReason =
  | "MIN_NOTIONAL"
  | "MIN_ORDER_SIZE"
  | "SLIPPAGE"
  | "PRICE_GUARD"
  | "SPREAD"
  | "THIN_BOOK"
  | "STALE_PRICE"
  | "MARKET_WS_DISCONNECTED"
  | "RATE_LIMIT"
  | "KILL_SWITCH"
  | "LEADER_PAUSED"
  | "EXPIRED"
  | "BOOK_UNAVAILABLE"
  | "UNKNOWN";

export type ExecutionCopyOrderStatus =
  | "PLACED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "FAILED"
  | "CANCELLED"
  | "RETRYING";

export interface ExecutionAttemptRecord {
  id: string;
  copyProfileId: string;
  leaderId?: string;
  pendingDeltaId?: string;
  tokenId: string;
  marketId?: string;
  side: ExecutionSide;
  retries: number;
  maxRetries: number;
  expiresAt: Date;
  attemptedAt?: Date;
  accumulatedDeltaShares: number;
  accumulatedDeltaNotionalUsd: number;
  status: "PENDING" | "RETRYING";
}

export interface ExecutionAttemptContext {
  attemptId: string;
  copyProfileStatus: "ACTIVE" | "PAUSED" | "DISABLED";
  copySystemEnabled?: boolean;
  leaderStatus?: "ACTIVE" | "PAUSED" | "DISABLED";
  maxPricePerShareOverride?: number | null;
  guardrailOverrides?: ExecutionGuardrailOverrides;
  profileSizingOverrides?: ExecutionProfileSizingOverrides;
  contributorLeaderIds: string[];
  contributorSettingsByLeaderId: Record<string, ParsedLeaderSettings>;
  pendingDeltaId?: string;
  pendingDeltaStatus?: "PENDING" | "ELIGIBLE" | "BLOCKED" | "EXPIRED" | "CONVERTED";
  pendingDeltaBlockReason?: string;
  pendingDeltaShares?: number;
  pendingDeltaNotionalUsd?: number;
  pendingDeltaMetadata: Record<string, unknown>;
}

export interface ExecutionGuardrailOverrides {
  minNotionalUsd?: number;
  maxWorseningBuyUsd?: number;
  maxWorseningSellUsd?: number;
  buyImprovementGuardEnabled?: boolean;
  maxBuyImprovementBps?: number | null;
  maxSlippageBps?: number;
  maxSpreadUsd?: number;
  minBookDepthForSizeEnabled?: boolean;
  cooldownPerMarketSeconds?: number;
  maxOpenOrders?: number | null;
}

export interface ExecutionProfileSizingOverrides {
  maxExposurePerLeaderUsd?: number;
  maxExposurePerMarketOutcomeUsd?: number;
  maxHourlyNotionalTurnoverUsd?: number;
  maxDailyNotionalTurnoverUsd?: number;
}

export interface ExecutionMarketSnapshot {
  tokenId: string;
  marketId?: string;
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  tickSize?: number;
  minOrderSize?: number;
  negRisk?: boolean;
  isStale: boolean;
  priceSource: "WS" | "REST" | "NONE";
  wsConnected?: boolean;
}

export interface ExecutionBookLevel {
  price: number;
  size: number;
}

export interface ExecutionOrderBookSnapshot {
  tokenId: string;
  marketId?: string;
  bids: ExecutionBookLevel[];
  asks: ExecutionBookLevel[];
}

export interface ExecutionOrderRequest {
  copyAttemptId: string;
  tokenId: string;
  marketId?: string;
  side: ExecutionSide;
  orderType: ExecutionOrderType;
  amountKind: ExecutionOrderAmountKind;
  amount: number;
  priceLimit: number;
  tickSize: number;
  negRisk: boolean;
  idempotencyKey: string;
}

export interface ExecutionOrderResult {
  status?: ExecutionCopyOrderStatus;
  externalOrderId?: string;
  responsePayload?: Record<string, unknown>;
}

export interface CopyOrderDraft {
  copyProfileId: string;
  copyAttemptId: string;
  tokenId: string;
  marketId?: string;
  side: ExecutionSide;
  intendedNotionalUsd: number;
  intendedShares: number;
  priceLimit: number;
  leaderWeights: Record<string, number>;
  idempotencyKey: string;
  retryCount: number;
  attemptedAt: Date;
}

export interface CopyOrderRecord {
  id: string;
  status: ExecutionCopyOrderStatus;
  externalOrderId?: string;
}

export interface ExecutionTransitionInput {
  attemptId: string;
  pendingDeltaId?: string;
  reason: ExecutionSkipReason;
  nextRetries: number;
  terminalStatus?: "FAILED" | "EXPIRED";
  message?: string;
  context?: Record<string, unknown>;
  attemptedAt: Date;
}

export interface ExecutionInvariantRepairResult {
  pendingDeltasConverted: number;
  attemptsClosed: number;
}

export interface ExecutionStore {
  listOpenAttempts(limit: number): Promise<ExecutionAttemptRecord[]>;
  getAttemptContext(attemptId: string): Promise<ExecutionAttemptContext | null>;
  getNotionalTurnoverUsd(copyProfileId: string, since: Date): Promise<number>;
  getLeaderRecentNotionalTurnoverUsd(args: {
    copyProfileId: string;
    leaderIds: string[];
    since: Date;
  }): Promise<Record<string, number>>;
  listLeaderLedgerPositions(args: {
    copyProfileId: string;
    leaderIds: string[];
  }): Promise<ExecutionLeaderLedgerPosition[]>;
  countOpenOrders(copyProfileId: string): Promise<number>;
  getLastOrderAttemptAt(copyProfileId: string, tokenId: string): Promise<Date | null>;
  createCopyOrderDraft(input: CopyOrderDraft): Promise<CopyOrderRecord>;
  markCopyOrderPlaced(input: {
    copyOrderId: string;
    attemptId: string;
    pendingDeltaId?: string;
    status: Exclude<ExecutionCopyOrderStatus, "FAILED" | "RETRYING" | "CANCELLED">;
    externalOrderId?: string;
    responsePayload?: Record<string, unknown>;
    attemptedAt: Date;
  }): Promise<void>;
  markCopyOrderFailure(input: {
    copyOrderId: string;
    attemptTransition: ExecutionTransitionInput;
    orderStatus?: Extract<ExecutionCopyOrderStatus, "FAILED" | "CANCELLED" | "RETRYING">;
  }): Promise<void>;
  deferAttempt(input: ExecutionTransitionInput): Promise<void>;
  repairExecutionInvariants(now: Date): Promise<ExecutionInvariantRepairResult>;
}

export interface ExecutionLeaderLedgerPosition {
  leaderId: string;
  tokenId: string;
  shares: number;
}

export interface ExecutionVenueClient {
  createAndSubmitOrder(input: ExecutionOrderRequest): Promise<ExecutionOrderResult>;
}

export interface ExecutionEngineConfig {
  enabled: boolean;
  intervalMs: number;
  maxAttemptsPerRun: number;
  retryBackoffBaseMs: number;
  retryBackoffMaxMs: number;
  dryRunMode: boolean;
  copySystemEnabled: boolean;
  panicMode: boolean;
  minNotionalUsd: number;
  maxWorseningBuyUsd: number;
  maxWorseningSellUsd: number;
  buyImprovementGuardEnabled: boolean;
  maxBuyImprovementBps?: number | null;
  maxSlippageBps: number;
  maxSpreadUsd: number;
  maxPricePerShare?: number;
  minBookDepthForSizeEnabled: boolean;
  maxOpenOrders: number | null;
  maxExposurePerLeaderUsd: number;
  maxExposurePerMarketOutcomeUsd: number;
  maxDailyNotionalTurnoverUsd: number;
  maxHourlyNotionalTurnoverUsd: number;
  cooldownPerMarketSeconds: number;
}

export interface ExecutionEngineStatus {
  enabled: boolean;
  dryRunMode: boolean;
  running: boolean;
  totalRuns: number;
  totalFailures: number;
  totalOrdersPlaced: number;
  totalOrderFailures: number;
  totalDryRunDeferrals: number;
  totalGuardrailBlocks: number;
  totalControlBlocks: number;
  totalBackoffSkips: number;
  lastRunAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastDurationMs?: number;
  lastAttemptsEvaluated: number;
  lastOrdersPlaced: number;
  lastOrderFailures: number;
  lastDryRunDeferrals: number;
  lastDeferred: number;
  lastBackoffSkips: number;
  lastError?: string;
}
