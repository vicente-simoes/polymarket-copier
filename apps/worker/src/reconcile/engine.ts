import type {
  ReconcileEngineDeps,
  ReconcileEngineStatus,
  ReconcileStore
} from "./types.js";

interface DetectedIssue {
  code: string;
  message: string;
  severity: "WARN" | "ERROR";
  context?: Record<string, unknown>;
}

interface IntegrityStats {
  openAttemptCollisions: number;
  duplicateDecisionExecutions: number;
}

export class ReconcileEngine {
  private readonly store: ReconcileStore;
  private readonly config: ReconcileEngineDeps["config"];
  private readonly leaderPoller: ReconcileEngineDeps["leaderPoller"];
  private readonly targetNetting: ReconcileEngineDeps["targetNetting"];
  private readonly getMarketDataStatus: ReconcileEngineDeps["getMarketDataStatus"];
  private readonly getExecutionStatus: ReconcileEngineDeps["getExecutionStatus"];
  private readonly now: () => number;
  private interval?: NodeJS.Timeout;
  private inFlight = false;
  private previousExecutionTotals?: {
    totalGuardrailBlocks: number;
    totalOrdersPlaced: number;
  };
  private activeIssueCodes = new Set<string>();
  private readonly status: ReconcileEngineStatus;

  constructor(deps: ReconcileEngineDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.leaderPoller = deps.leaderPoller;
    this.targetNetting = deps.targetNetting;
    this.getMarketDataStatus = deps.getMarketDataStatus;
    this.getExecutionStatus = deps.getExecutionStatus;
    this.now = deps.now ?? Date.now;
    this.status = {
      enabled: deps.config.enabled,
      running: false,
      totalRuns: 0,
      totalFailures: 0,
      totalDegradedRuns: 0,
      lastProfilesProcessed: 0,
      lastFollowerTokensSnapshotted: 0,
      lastIntegrityViolations: 0,
      lastDetectedIssues: [],
      consecutiveGuardrailFailureCycles: 0
    };
  }

  start(): void {
    if (!this.config.enabled) {
      return;
    }

    this.interval = setInterval(() => {
      void this.run();
    }, this.config.intervalMs);

    void this.run();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  getStatus(): ReconcileEngineStatus {
    return {
      ...this.status,
      lastDetectedIssues: [...this.status.lastDetectedIssues]
    };
  }

  async run(): Promise<void> {
    if (!this.config.enabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    this.status.running = true;
    this.status.totalRuns += 1;
    this.status.lastRunAtMs = this.now();
    const startedAtMs = this.now();
    const cycleAt = new Date(startedAtMs);

    let profilesProcessed = 0;
    let followerTokensSnapshotted = 0;
    let integrityViolations = 0;
    let issues: DetectedIssue[] = [];

    try {
      await this.leaderPoller.runPositionsPoll();

      const profileIds = await this.store.listActiveCopyProfileIds();
      profilesProcessed = profileIds.length;

      for (const copyProfileId of profileIds) {
        const rebuilt = await this.store.rebuildFollowerSnapshot(copyProfileId, cycleAt, startedAtMs);
        followerTokensSnapshotted += rebuilt.tokensSnapshotted;
      }

      await this.targetNetting.run();

      const integrity = await this.computeIntegrityStats();
      integrityViolations = integrity.openAttemptCollisions + integrity.duplicateDecisionExecutions;

      issues = await this.detectIssues({
        nowMs: startedAtMs,
        profileIds,
        integrity
      });

      const degraded = issues.length > 0;
      if (degraded) {
        this.status.totalDegradedRuns += 1;
      }

      this.status.lastSuccessAtMs = this.now();
      this.status.lastError = undefined;
      this.status.lastProfilesProcessed = profilesProcessed;
      this.status.lastFollowerTokensSnapshotted = followerTokensSnapshotted;
      this.status.lastIntegrityViolations = integrityViolations;
      this.status.lastDetectedIssues = issues.map((issue) => issue.code);

      await this.persistNewIssues(issues);

      await this.store.writeReconcileAudit({
        status: degraded ? "DEGRADED" : "OK",
        cycleAt,
        details: {
          durationMs: this.now() - startedAtMs,
          profilesProcessed,
          followerTokensSnapshotted,
          integrityViolations,
          issues: issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            severity: issue.severity
          })),
          leaderIngestion: this.leaderPoller.getStatus(),
          targetNetting: this.targetNetting.getStatus(),
          marketData: this.getMarketDataStatus(),
          execution: this.getExecutionStatus(),
          guardrailFailureCycles: this.status.consecutiveGuardrailFailureCycles
        }
      });
    } catch (error) {
      this.status.totalFailures += 1;
      this.status.totalDegradedRuns += 1;
      this.status.lastFailureAtMs = this.now();
      this.status.lastError = toErrorMessage(error);
      this.status.lastDetectedIssues = ["RECONCILE_RUN_FAILED"];
      issues = [
        {
          code: "RECONCILE_RUN_FAILED",
          message: toErrorMessage(error),
          severity: "ERROR"
        }
      ];

      await this.persistNewIssues(issues);
      await this.store.writeReconcileAudit({
        status: "DEGRADED",
        cycleAt,
        details: {
          durationMs: this.now() - startedAtMs,
          profilesProcessed,
          followerTokensSnapshotted,
          integrityViolations,
          issues: issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            severity: issue.severity
          })),
          error: toErrorMessage(error)
        }
      });
    } finally {
      this.status.running = false;
      this.status.lastDurationMs = this.now() - startedAtMs;
      this.inFlight = false;
    }
  }

  private async computeIntegrityStats(): Promise<IntegrityStats> {
    const [openAttemptCollisions, duplicateDecisionExecutions] = await Promise.all([
      this.store.countOpenAttemptCollisions(),
      this.store.countDuplicateOrderDecisionKeys()
    ]);

    return {
      openAttemptCollisions,
      duplicateDecisionExecutions
    };
  }

  private async detectIssues(input: {
    nowMs: number;
    profileIds: string[];
    integrity: IntegrityStats;
  }): Promise<DetectedIssue[]> {
    const issues: DetectedIssue[] = [];

    const marketStatus = this.getMarketDataStatus();
    if (
      marketStatus.freshness.watchedTokenCount > 0 &&
      (marketStatus.freshness.staleTokenCount > 0 || marketStatus.freshness.stalePriceCount > 0)
    ) {
      issues.push({
        code: "STALE_PRICES",
        message: "market price snapshots are stale for one or more watched tokens",
        severity: "WARN",
        context: {
          watchedTokenCount: marketStatus.freshness.watchedTokenCount,
          staleTokenCount: marketStatus.freshness.staleTokenCount,
          stalePriceCount: marketStatus.freshness.stalePriceCount
        }
      });
    }

    const latestLeaderAt = await this.store.getLatestLeaderSnapshotAt();
    if (!latestLeaderAt || input.nowMs - latestLeaderAt.getTime() > this.config.staleLeaderSyncMs) {
      issues.push({
        code: "STALE_LEADER_SYNC",
        message: "leader positions snapshot is stale",
        severity: "WARN",
        context: {
          latestLeaderSnapshotAt: latestLeaderAt?.toISOString(),
          staleLeaderSyncMs: this.config.staleLeaderSyncMs
        }
      });
    }

    const staleProfiles: Array<{ copyProfileId: string; latestFollowerSnapshotAt?: string }> = [];
    for (const copyProfileId of input.profileIds) {
      const latestFollowerAt = await this.store.getLatestFollowerSnapshotAt(copyProfileId);
      if (!latestFollowerAt || input.nowMs - latestFollowerAt.getTime() > this.config.staleFollowerSyncMs) {
        staleProfiles.push({
          copyProfileId,
          latestFollowerSnapshotAt: latestFollowerAt?.toISOString()
        });
      }
    }
    if (staleProfiles.length > 0) {
      issues.push({
        code: "STALE_FOLLOWER_SYNC",
        message: "follower position snapshots are stale for one or more copy profiles",
        severity: "WARN",
        context: {
          staleFollowerSyncMs: this.config.staleFollowerSyncMs,
          staleProfiles
        }
      });
    }

    this.updateGuardrailCycleCounter();
    if (this.status.consecutiveGuardrailFailureCycles >= this.config.guardrailFailureCycleThreshold) {
      issues.push({
        code: "REPEATED_GUARD_FAILURES",
        message: "execution guardrail blocks have repeated across reconcile cycles",
        severity: "WARN",
        context: {
          guardrailFailureCycleThreshold: this.config.guardrailFailureCycleThreshold,
          consecutiveGuardrailFailureCycles: this.status.consecutiveGuardrailFailureCycles
        }
      });
    }

    if (input.integrity.openAttemptCollisions > 0) {
      issues.push({
        code: "INTEGRITY_OPEN_ATTEMPT_COLLISION",
        message: "multiple open attempts exist for the same copy profile/token/side",
        severity: "ERROR",
        context: {
          collisionGroups: input.integrity.openAttemptCollisions
        }
      });
    }

    if (input.integrity.duplicateDecisionExecutions > 0) {
      issues.push({
        code: "INTEGRITY_DUPLICATE_DECISION_EXECUTION",
        message: "multiple successful orders exist for the same copy attempt",
        severity: "ERROR",
        context: {
          affectedAttempts: input.integrity.duplicateDecisionExecutions
        }
      });
    }

    return issues;
  }

  private updateGuardrailCycleCounter(): void {
    const execution = this.getExecutionStatus();

    if (!this.previousExecutionTotals) {
      this.previousExecutionTotals = {
        totalGuardrailBlocks: execution.totalGuardrailBlocks,
        totalOrdersPlaced: execution.totalOrdersPlaced
      };
      this.status.consecutiveGuardrailFailureCycles = 0;
      return;
    }

    const guardrailDelta = execution.totalGuardrailBlocks - this.previousExecutionTotals.totalGuardrailBlocks;
    const orderDelta = execution.totalOrdersPlaced - this.previousExecutionTotals.totalOrdersPlaced;

    if (guardrailDelta > 0 && orderDelta <= 0) {
      this.status.consecutiveGuardrailFailureCycles += 1;
    } else if (orderDelta > 0 || guardrailDelta <= 0) {
      this.status.consecutiveGuardrailFailureCycles = 0;
    }

    this.previousExecutionTotals = {
      totalGuardrailBlocks: execution.totalGuardrailBlocks,
      totalOrdersPlaced: execution.totalOrdersPlaced
    };
  }

  private async persistNewIssues(issues: DetectedIssue[]): Promise<void> {
    const currentCodes = new Set(issues.map((issue) => issue.code));

    for (const issue of issues) {
      if (this.activeIssueCodes.has(issue.code)) {
        continue;
      }

      try {
        await this.store.writeReconcileIssue({
          code: issue.code,
          message: issue.message,
          severity: issue.severity,
          context: issue.context
        });
      } catch (error) {
        this.status.lastError = `failed to persist reconcile issue ${issue.code}: ${toErrorMessage(error)}`;
      }
    }

    this.activeIssueCodes = currentCodes;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
