export const ORDER_FILLED_TOPIC0 =
  "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";
export const ORDERS_MATCHED_TOPIC0 =
  "0x63bf4d16b764241a0e07a43d477a39e134f0c093e0ab12f30a66bc2633c1a9e0";

export type ChainTriggerEventName = "OrderFilled" | "OrdersMatched";
export type ChainTriggerSide = "BUY" | "SELL";

export interface LeaderWalletLink {
  leaderId: string;
  walletAddress: string;
}

export interface ChainTrigger {
  triggerId: string;
  chain: "polygon";
  event: ChainTriggerEventName;
  exchangeContract: string;
  leaderId: string;
  leaderWallet: string;
  leaderRole: "maker" | "taker";
  tokenId: string;
  side: ChainTriggerSide;
  tokenAmountBaseUnits: string;
  usdcAmountBaseUnits: string;
  feeBaseUnits: string;
  shares: string;
  notionalUsd: string;
  price: string;
  transactionHash: string;
  logIndex: number;
  blockNumberHex: string;
  blockHash: string;
  leaderFillAtMs: number;
  wsReceivedAtMs: number;
  detectedAtMs: number;
  removed: boolean;
  rawLog: Record<string, unknown>;
}

export interface ReconcileTask {
  leaderId: string;
  tokenId: string;
  triggerId: string;
  reason: "CHAIN_REORG";
  enqueuedAtMs: number;
}

export interface ChainPipelineStatus {
  enabled: boolean;
  connected: boolean;
  watchedWalletCount: number;
  activeSubscriptionCount: number;
  receivedMessages: number;
  decodedTriggers: number;
  persistedTriggers: number;
  duplicateTriggers: number;
  rollbackTriggers: number;
  queuedReconciles: number;
  reconnectCount: number;
  lastMessageAtMs?: number;
  lastTriggerAtMs?: number;
  lastLeaderFillAtMs?: number;
  lastWsReceivedAtMs?: number;
  lastDetectedAtMs?: number;
  lastTriggerLagMs?: number;
  lastWsLagMs?: number;
  lastDetectLagMs?: number;
  queueSize: number;
  lastError?: string;
}

export interface ChainTriggerStore {
  listActiveLeaderWallets(): Promise<LeaderWalletLink[]>;
  persistChainTrigger(trigger: ChainTrigger): Promise<{
    inserted: boolean;
    dedupedByCanonicalKey: boolean;
  }>;
  markTriggerRollback(args: {
    triggerId: string;
    leaderId: string;
    tokenId: string;
    removedAtMs: number;
    payload: Record<string, unknown>;
  }): Promise<void>;
  recordReconcileTask(task: ReconcileTask): Promise<void>;
  recordPipelineError(message: string, context?: Record<string, unknown>): Promise<void>;
}

export interface TriggerDeduper {
  reserve(triggerId: string, ttlSeconds: number): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface ChainPipelineConfig {
  wsUrl: string;
  exchangeContracts: string[];
  dedupeTtlSeconds: number;
  walletRefreshIntervalMs: number;
  reconcileQueueMaxSize: number;
  enabled: boolean;
}
