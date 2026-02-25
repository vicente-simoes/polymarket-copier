import type { ExecutionEngineStatus } from "../execution/types.js";
import type { LeaderPollerStatus } from "../leader/types.js";
import type { MarketDataStatus } from "../market/service.js";
import type { TargetNettingStatus } from "../target/types.js";

export interface ReconcileCycleConfig {
  enabled: boolean;
  intervalMs: number;
  staleLeaderSyncMs: number;
  staleFollowerSyncMs: number;
  guardrailFailureCycleThreshold: number;
}

export interface ReconcileAuditRecord {
  status: "OK" | "DEGRADED";
  cycleAt: Date;
  details: Record<string, unknown>;
}

export interface ReconcileStore {
  listActiveCopyProfileIds(): Promise<string[]>;
  rebuildFollowerSnapshot(copyProfileId: string, snapshotAt: Date, snapshotAtMs: number): Promise<{
    tokensSnapshotted: number;
    absoluteSharesSum: number;
  }>;
  getLatestLeaderSnapshotAt(): Promise<Date | null>;
  getLatestFollowerSnapshotAt(copyProfileId: string): Promise<Date | null>;
  countOpenAttemptCollisions(): Promise<number>;
  countDuplicateOrderDecisionKeys(): Promise<number>;
  writeReconcileAudit(input: ReconcileAuditRecord): Promise<void>;
  writeReconcileIssue(input: {
    code: string;
    message: string;
    severity: "WARN" | "ERROR";
    context?: Record<string, unknown>;
  }): Promise<void>;
}

export interface ReconcileEngineDeps {
  store: ReconcileStore;
  config: ReconcileCycleConfig;
  leaderPoller: {
    runPositionsPoll(): Promise<void>;
    getStatus(): LeaderPollerStatus;
  };
  targetNetting: {
    run(): Promise<void>;
    getStatus(): TargetNettingStatus;
  };
  getMarketDataStatus: () => MarketDataStatus;
  getExecutionStatus: () => ExecutionEngineStatus;
  now?: () => number;
}

export interface ReconcileEngineStatus {
  enabled: boolean;
  running: boolean;
  totalRuns: number;
  totalFailures: number;
  totalDegradedRuns: number;
  lastRunAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastDurationMs?: number;
  lastProfilesProcessed: number;
  lastFollowerTokensSnapshotted: number;
  lastIntegrityViolations: number;
  lastDetectedIssues: string[];
  consecutiveGuardrailFailureCycles: number;
  lastError?: string;
}
