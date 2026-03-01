import type { DataApiPosition, DataApiTrade } from "@copybot/shared";

export interface LeaderRecord {
  id: string;
  name: string;
  profileAddress: string;
}

export interface DataApiTradesPageRequest {
  user: string;
  limit: number;
  offset: number;
  takerOnly?: boolean;
}

export interface DataApiPositionsPageRequest {
  user: string;
  limit: number;
  offset: number;
  sizeThreshold?: number;
  sortBy?: "CURRENT" | "PRICE" | "AVGPRICE" | "TITLE";
  sortDirection?: "ASC" | "DESC";
}

export interface NormalizedTradeEvent {
  triggerId: string;
  canonicalKey: string;
  transactionHash?: string;
  leaderFillAtMs: number;
  detectedAtMs: number;
  marketId?: string;
  tokenId: string;
  outcome?: string;
  side: DataApiTrade["side"];
  shares: number;
  price: number;
  notionalUsd: number;
  payload: Record<string, unknown>;
}

export interface PollCursorProgress {
  oldestSeenTradeAtMs?: number;
  newestSeenTradeAtMs?: number;
  lastCursorMs?: number;
}

export interface PollOutcome {
  leaderId: string;
  pagesFetched: number;
  recordsSeen: number;
  recordsInserted: number;
  recordsSkipped: number;
  runDurationMs: number;
  cursor?: PollCursorProgress;
}

export interface PollFailure {
  leaderId: string;
  message: string;
  retryable: boolean;
  attemptCount: number;
}

export interface PollJobSnapshot {
  running: boolean;
  totalRuns: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastRunAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastError?: string;
  lastDurationMs?: number;
  lastLeadersProcessed: number;
  lastRecordsSeen: number;
  lastRecordsInserted: number;
}

export interface LeaderPollerStatus {
  positions: PollJobSnapshot;
  trades: PollJobSnapshot;
  lastUpdatedAtMs: number;
}

export interface LeaderIngestionStore {
  listActiveLeaders(): Promise<LeaderRecord[]>;
  getLatestDataApiTradeCursorMs(leaderId: string): Promise<number | null>;
  upsertLeaderWallets(leaderId: string, wallets: string[], seenAt: Date): Promise<void>;
  saveLeaderPositionSnapshots(args: {
    leaderId: string;
    snapshotAt: Date;
    snapshotAtMs: number;
    positions: DataApiPosition[];
  }): Promise<number>;
  saveLeaderTradeEvents(args: {
    leaderId: string;
    events: NormalizedTradeEvent[];
  }): Promise<number>;
  saveLeaderPollMeta(args: {
    leaderId: string;
    pollKind: "positions" | "trades";
    meta: Record<string, unknown>;
  }): Promise<void>;
  savePollFailure(args: {
    leaderId: string;
    pollKind: "positions" | "trades";
    message: string;
    retryable: boolean;
    attemptCount: number;
    context?: Record<string, unknown>;
  }): Promise<void>;
  saveWorkerPollStatus(status: LeaderPollerStatus): Promise<void>;
}

export interface LeaderDataApiClient {
  fetchTradesPage(args: DataApiTradesPageRequest): Promise<DataApiTrade[]>;
  fetchPositionsPage(args: DataApiPositionsPageRequest): Promise<DataApiPosition[]>;
}

export interface LeaderPollerConfig {
  positionsIntervalMs: number;
  tradesIntervalMs: number;
  tradesTakerOnly: boolean;
  pageLimit: number;
  batchSize: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxPagesPerLeader: number;
}
