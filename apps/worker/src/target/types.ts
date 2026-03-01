export type PendingDeltaSide = "BUY" | "SELL";
export type PendingDeltaStatus = "PENDING" | "ELIGIBLE" | "BLOCKED";

export interface ActiveCopyProfileLeader {
  leaderId: string;
  ratio: number;
}

export interface ActiveCopyProfile {
  copyProfileId: string;
  defaultRatio: number;
  leaders: ActiveCopyProfileLeader[];
}

export interface LeaderPositionPoint {
  leaderId: string;
  tokenId: string;
  marketId?: string;
  shares: number;
  currentPrice?: number;
  currentValueUsd?: number;
}

export interface FollowerPositionPoint {
  tokenId: string;
  shares: number;
}

export interface PriceSnapshot {
  tokenId: string;
  marketId?: string;
  midPrice?: number;
  topOfBookPrice?: number;
  minOrderSize?: number;
  stale?: boolean;
  source: "CUR_PRICE" | "MARKET_WS" | "MARKET_REST" | "UNKNOWN";
}

export interface PendingDeltaInput {
  copyProfileId: string;
  leaderId?: string;
  tokenId: string;
  marketId?: string;
  side: PendingDeltaSide;
  pendingDeltaShares: number;
  pendingDeltaNotionalUsd: number;
  minExecutableNotionalUsd: number;
  status: PendingDeltaStatus;
  blockReason?: "MIN_NOTIONAL" | "MIN_ORDER_SIZE" | "UNKNOWN";
  metadata: Record<string, unknown>;
  expiresAt: Date;
}

export interface PendingDeltaRecord {
  id: string;
  copyProfileId: string;
  leaderId?: string;
  tokenId: string;
  marketId?: string;
  side: PendingDeltaSide;
  pendingDeltaShares: number;
  pendingDeltaNotionalUsd: number;
  status: PendingDeltaStatus;
}

export interface OpenCopyAttemptRecord {
  id: string;
  pendingDeltaId: string;
  status: "PENDING" | "EXECUTING" | "RETRYING";
}

export interface TargetNettingStore {
  listActiveCopyProfiles(): Promise<ActiveCopyProfile[]>;
  getLatestLeaderPositions(leaderIds: string[]): Promise<LeaderPositionPoint[]>;
  getLatestFollowerPositions(copyProfileId: string): Promise<FollowerPositionPoint[]>;
  listOpenPendingTokenIds(copyProfileId: string): Promise<string[]>;
  upsertPendingDelta(input: PendingDeltaInput): Promise<PendingDeltaRecord>;
  expireOppositePendingDeltas(copyProfileId: string, tokenId: string, side: PendingDeltaSide): Promise<number>;
  clearTokenPendingDeltas(copyProfileId: string, tokenId: string): Promise<number>;
  findOpenCopyAttemptForPendingDelta(pendingDeltaId: string): Promise<OpenCopyAttemptRecord | null>;
  createCopyAttempt(input: {
    copyProfileId: string;
    leaderId?: string;
    pendingDeltaId: string;
    tokenId: string;
    marketId?: string;
    side: PendingDeltaSide;
    pendingDeltaShares: number;
    pendingDeltaNotionalUsd: number;
    expiresAt: Date;
    maxRetries: number;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface TargetNettingConfig {
  enabled: boolean;
  intervalMs: number;
  minNotionalUsd: number;
  trackingErrorBps: number;
  maxRetriesPerAttempt: number;
  attemptExpirationSeconds: number;
}

export interface TargetNettingStatus {
  enabled: boolean;
  running: boolean;
  totalRuns: number;
  totalFailures: number;
  lastRunAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastDurationMs?: number;
  lastProfilesProcessed: number;
  lastTokensEvaluated: number;
  lastPendingUpdated: number;
  lastAttemptsCreated: number;
  lastError?: string;
}
