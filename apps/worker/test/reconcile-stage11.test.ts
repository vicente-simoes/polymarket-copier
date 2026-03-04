import assert from "node:assert/strict";
import test from "node:test";
import { ReconcileEngine } from "../src/reconcile/engine.js";
import type { ExecutionEngineStatus } from "../src/execution/types.js";
import type { LeaderPollerStatus } from "../src/leader/types.js";
import type { MarketDataStatus } from "../src/market/service.js";
import type { ReconcileAuditRecord, ReconcileStore } from "../src/reconcile/types.js";
import type { TargetNettingStatus } from "../src/target/types.js";

class FakeReconcileStore implements ReconcileStore {
  activeCopyProfileIds: string[] = [];
  latestLeaderSnapshotAt: Date | null = null;
  latestFollowerSnapshotAtByProfile = new Map<string, Date | null>();
  rebuildResultsByProfile = new Map<string, { tokensSnapshotted: number; absoluteSharesSum: number }>();
  rebuildCalls: Array<{ copyProfileId: string; snapshotAt: Date; snapshotAtMs: number }> = [];
  audits: ReconcileAuditRecord[] = [];
  issues: Array<{ code: string; message: string; severity: "WARN" | "ERROR"; context?: Record<string, unknown> }> = [];
  openAttemptCollisions = 0;
  duplicateDecisionExecutions = 0;
  updateFollowerSnapshotOnRebuild = true;

  async listActiveCopyProfileIds(): Promise<string[]> {
    return [...this.activeCopyProfileIds];
  }

  async rebuildFollowerSnapshot(copyProfileId: string, snapshotAt: Date, snapshotAtMs: number): Promise<{
    tokensSnapshotted: number;
    absoluteSharesSum: number;
  }> {
    this.rebuildCalls.push({
      copyProfileId,
      snapshotAt,
      snapshotAtMs
    });

    if (this.updateFollowerSnapshotOnRebuild) {
      this.latestFollowerSnapshotAtByProfile.set(copyProfileId, snapshotAt);
    }

    return (
      this.rebuildResultsByProfile.get(copyProfileId) ?? {
        tokensSnapshotted: 0,
        absoluteSharesSum: 0
      }
    );
  }

  async getLatestLeaderSnapshotAt(): Promise<Date | null> {
    return this.latestLeaderSnapshotAt;
  }

  async getLatestFollowerSnapshotAt(copyProfileId: string): Promise<Date | null> {
    return this.latestFollowerSnapshotAtByProfile.get(copyProfileId) ?? null;
  }

  async countOpenAttemptCollisions(): Promise<number> {
    return this.openAttemptCollisions;
  }

  async countDuplicateOrderDecisionKeys(): Promise<number> {
    return this.duplicateDecisionExecutions;
  }

  async writeReconcileAudit(input: ReconcileAuditRecord): Promise<void> {
    this.audits.push(input);
  }

  async writeReconcileIssue(input: {
    code: string;
    message: string;
    severity: "WARN" | "ERROR";
    context?: Record<string, unknown>;
  }): Promise<void> {
    this.issues.push(input);
  }
}

test("Stage 11 reconcile scheduler runs authoritative cycle and writes audit", async () => {
  const store = new FakeReconcileStore();
  store.activeCopyProfileIds = ["profile-a", "profile-b"];
  store.latestLeaderSnapshotAt = new Date(999_500);
  store.latestFollowerSnapshotAtByProfile.set("profile-a", new Date(999_200));
  store.latestFollowerSnapshotAtByProfile.set("profile-b", new Date(999_100));
  store.rebuildResultsByProfile.set("profile-a", {
    tokensSnapshotted: 2,
    absoluteSharesSum: 3.2
  });
  store.rebuildResultsByProfile.set("profile-b", {
    tokensSnapshotted: 1,
    absoluteSharesSum: 1.1
  });

  let leaderPollRuns = 0;
  let targetRuns = 0;
  const executionStatus = makeExecutionStatus({
    totalGuardrailBlocks: 4,
    totalOrdersPlaced: 2
  });

  const engine = new ReconcileEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 60_000,
      staleLeaderSyncMs: 60_000,
      staleFollowerSyncMs: 60_000,
      guardrailFailureCycleThreshold: 2
    },
    leaderPoller: {
      runPositionsPoll: async () => {
        leaderPollRuns += 1;
      },
      getStatus: () => makeLeaderStatus()
    },
    targetNetting: {
      run: async () => {
        targetRuns += 1;
      },
      getStatus: () => makeTargetStatus()
    },
    getMarketDataStatus: () =>
      makeMarketStatus({
        watchedTokenCount: 2,
        staleTokenCount: 0,
        stalePriceCount: 0
      }),
    getExecutionStatus: () => executionStatus,
    now: () => 1_000_000
  });

  await engine.run();

  assert.equal(leaderPollRuns, 1);
  assert.equal(targetRuns, 1);
  assert.equal(store.rebuildCalls.length, 2);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0]?.status, "OK");
  assert.equal(store.issues.length, 0);

  const status = engine.getStatus();
  assert.equal(status.totalRuns, 1);
  assert.equal(status.totalDegradedRuns, 0);
  assert.equal(status.lastProfilesProcessed, 2);
  assert.equal(status.lastFollowerTokensSnapshotted, 3);
  assert.equal(status.lastIntegrityViolations, 0);
  assert.deepEqual(status.lastDetectedIssues, []);
});

test("Stage 11 detects stale states, repeated guard failures, and integrity violations", async () => {
  const store = new FakeReconcileStore();
  store.activeCopyProfileIds = ["profile-a"];
  store.latestLeaderSnapshotAt = new Date(4_000_000);
  store.latestFollowerSnapshotAtByProfile.set("profile-a", new Date(4_000_000));
  store.openAttemptCollisions = 1;
  store.duplicateDecisionExecutions = 2;
  store.updateFollowerSnapshotOnRebuild = false;

  const executionStatus = makeExecutionStatus({
    totalGuardrailBlocks: 10,
    totalOrdersPlaced: 0
  });

  const engine = new ReconcileEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 60_000,
      staleLeaderSyncMs: 60_000,
      staleFollowerSyncMs: 60_000,
      guardrailFailureCycleThreshold: 1
    },
    leaderPoller: {
      runPositionsPoll: async () => undefined,
      getStatus: () => makeLeaderStatus()
    },
    targetNetting: {
      run: async () => undefined,
      getStatus: () => makeTargetStatus()
    },
    getMarketDataStatus: () =>
      makeMarketStatus({
        watchedTokenCount: 1,
        staleTokenCount: 1,
        stalePriceCount: 1
      }),
    getExecutionStatus: () => executionStatus,
    now: () => 5_000_000
  });

  await engine.run();
  executionStatus.totalGuardrailBlocks += 1;
  await engine.run();

  assert.equal(store.audits.length, 2);
  assert.equal(store.audits[0]?.status, "DEGRADED");
  assert.equal(store.audits[1]?.status, "DEGRADED");
  assert.equal(store.issues.length, 6);
  assert.ok(store.issues.some((issue) => issue.code === "STALE_PRICES"));
  assert.ok(store.issues.some((issue) => issue.code === "STALE_LEADER_SYNC"));
  assert.ok(store.issues.some((issue) => issue.code === "STALE_FOLLOWER_SYNC"));
  assert.ok(store.issues.some((issue) => issue.code === "INTEGRITY_OPEN_ATTEMPT_COLLISION"));
  assert.ok(store.issues.some((issue) => issue.code === "INTEGRITY_DUPLICATE_DECISION_EXECUTION"));
  assert.ok(store.issues.some((issue) => issue.code === "REPEATED_GUARD_FAILURES"));

  const status = engine.getStatus();
  assert.equal(status.totalRuns, 2);
  assert.equal(status.totalDegradedRuns, 2);
  assert.equal(status.lastIntegrityViolations, 3);
  assert.equal(status.consecutiveGuardrailFailureCycles, 1);
  assert.ok(status.lastDetectedIssues.includes("REPEATED_GUARD_FAILURES"));
});

test("Stage 11 reconcile interval can be reconfigured at runtime", () => {
  const store = new FakeReconcileStore();
  const engine = new ReconcileEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 60_000,
      staleLeaderSyncMs: 60_000,
      staleFollowerSyncMs: 60_000,
      guardrailFailureCycleThreshold: 1
    },
    leaderPoller: {
      runPositionsPoll: async () => undefined,
      getStatus: () => makeLeaderStatus()
    },
    targetNetting: {
      run: async () => undefined,
      getStatus: () => makeTargetStatus()
    },
    getMarketDataStatus: () => makeMarketStatus({}),
    getExecutionStatus: () => makeExecutionStatus({})
  });

  engine.setIntervalMs(2_000);
  engine.setEnabled(false);
  engine.setStaleThresholds({ leaderSeconds: 7, followerSeconds: 9 });
  engine.setGuardrailFailureCycleThreshold(3);

  const config = engine as unknown as {
    config: {
      intervalMs: number;
      enabled: boolean;
      staleLeaderSyncMs: number;
      staleFollowerSyncMs: number;
      guardrailFailureCycleThreshold: number;
    };
    status: { enabled: boolean };
  };
  assert.equal(config.config.intervalMs, 2_000);
  assert.equal(config.config.enabled, false);
  assert.equal(config.status.enabled, false);
  assert.equal(config.config.staleLeaderSyncMs, 7_000);
  assert.equal(config.config.staleFollowerSyncMs, 9_000);
  assert.equal(config.config.guardrailFailureCycleThreshold, 3);
});

function makeLeaderStatus(): LeaderPollerStatus {
  const snapshot = {
    running: false,
    totalRuns: 1,
    totalFailures: 0,
    consecutiveFailures: 0,
    lastRunAtMs: 1,
    lastSuccessAtMs: 1,
    lastFailureAtMs: undefined,
    lastError: undefined,
    lastDurationMs: 10,
    lastLeadersProcessed: 1,
    lastRecordsSeen: 1,
    lastRecordsInserted: 1
  };

  return {
    positions: snapshot,
    trades: snapshot,
    lastUpdatedAtMs: 1
  };
}

function makeTargetStatus(): TargetNettingStatus {
  return {
    enabled: true,
    running: false,
    totalRuns: 1,
    totalFailures: 0,
    lastRunAtMs: 1,
    lastSuccessAtMs: 1,
    lastFailureAtMs: undefined,
    lastDurationMs: 20,
    lastProfilesProcessed: 1,
    lastTokensEvaluated: 1,
    lastPendingUpdated: 1,
    lastAttemptsCreated: 1,
    lastError: undefined
  };
}

function makeExecutionStatus(overrides: Partial<ExecutionEngineStatus> = {}): ExecutionEngineStatus {
  return {
    enabled: true,
    running: false,
    totalRuns: 1,
    totalFailures: 0,
    totalOrdersPlaced: 0,
    totalOrderFailures: 0,
    totalGuardrailBlocks: 0,
    totalControlBlocks: 0,
    totalBackoffSkips: 0,
    lastRunAtMs: undefined,
    lastSuccessAtMs: undefined,
    lastFailureAtMs: undefined,
    lastDurationMs: undefined,
    lastAttemptsEvaluated: 0,
    lastOrdersPlaced: 0,
    lastOrderFailures: 0,
    lastDeferred: 0,
    lastBackoffSkips: 0,
    lastError: undefined,
    ...overrides
  };
}

function makeMarketStatus(overrides: Partial<MarketDataStatus["freshness"]>): MarketDataStatus {
  return {
    ws: {
      connected: true,
      watchedTokenCount: 1,
      subscribedTokenCount: 1,
      reconnectCount: 0,
      connectedAtMs: 1,
      disconnectedAtMs: undefined,
      lastMessageAtMs: 1,
      lastError: undefined
    },
    freshness: {
      watchedTokenCount: 1,
      staleTokenCount: 0,
      wsBackedTokenCount: 1,
      restBackedTokenCount: 0,
      staleMetadataCount: 0,
      stalePriceCount: 0,
      snapshotAtMs: 1,
      ...overrides
    }
  };
}
