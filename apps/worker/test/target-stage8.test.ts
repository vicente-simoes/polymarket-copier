import assert from "node:assert/strict";
import test from "node:test";
import { TargetNettingEngine } from "../src/target/engine.js";
import type {
  ActiveCopyProfile,
  FollowerPositionPoint,
  LeaderPositionPoint,
  OpenCopyAttemptRecord,
  PendingDeltaInput,
  PendingDeltaRecord,
  PendingDeltaSide,
  TargetNettingStore
} from "../src/target/types.js";

interface PendingState extends PendingDeltaRecord {
  blockReason?: "MIN_NOTIONAL" | "MIN_ORDER_SIZE" | "UNKNOWN";
  metadata: Record<string, unknown>;
}

class FakeTargetStore implements TargetNettingStore {
  profiles: ActiveCopyProfile[] = [];
  leaderPositions: LeaderPositionPoint[] = [];
  followerByProfile = new Map<string, FollowerPositionPoint[]>();
  pendingInputs: PendingDeltaInput[] = [];
  attempts = new Map<string, OpenCopyAttemptRecord>();

  private readonly pendingByKey = new Map<string, PendingState>();
  private pendingSeq = 0;
  private attemptSeq = 0;

  async listActiveCopyProfiles(): Promise<ActiveCopyProfile[]> {
    return this.profiles;
  }

  async getLatestLeaderPositions(_leaderIds: string[]): Promise<LeaderPositionPoint[]> {
    return this.leaderPositions;
  }

  async getLatestFollowerPositions(copyProfileId: string): Promise<FollowerPositionPoint[]> {
    return this.followerByProfile.get(copyProfileId) ?? [];
  }

  async listOpenPendingTokenIds(copyProfileId: string): Promise<string[]> {
    const tokens = new Set<string>();
    for (const pending of this.pendingByKey.values()) {
      if (pending.copyProfileId !== copyProfileId) {
        continue;
      }
      if (pending.status === "PENDING" || pending.status === "ELIGIBLE" || pending.status === "BLOCKED") {
        tokens.add(pending.tokenId);
      }
    }
    return [...tokens];
  }

  async upsertPendingDelta(input: PendingDeltaInput): Promise<PendingDeltaRecord> {
    this.pendingInputs.push(input);
    const key = pendingKey(input.copyProfileId, input.tokenId, input.side);
    const existing = this.pendingByKey.get(key);
    const id = existing?.id ?? `pending-${++this.pendingSeq}`;
    const record: PendingState = {
      id,
      copyProfileId: input.copyProfileId,
      tokenId: input.tokenId,
      marketId: input.marketId,
      side: input.side,
      pendingDeltaShares: input.pendingDeltaShares,
      pendingDeltaNotionalUsd: input.pendingDeltaNotionalUsd,
      status: input.status,
      blockReason: input.blockReason,
      metadata: input.metadata
    };
    this.pendingByKey.set(key, record);
    return {
      id: record.id,
      copyProfileId: record.copyProfileId,
      tokenId: record.tokenId,
      marketId: record.marketId,
      side: record.side,
      pendingDeltaShares: record.pendingDeltaShares,
      pendingDeltaNotionalUsd: record.pendingDeltaNotionalUsd,
      status: record.status
    };
  }

  async expireOppositePendingDeltas(copyProfileId: string, tokenId: string, side: PendingDeltaSide): Promise<number> {
    const opposite: PendingDeltaSide = side === "BUY" ? "SELL" : "BUY";
    const key = pendingKey(copyProfileId, tokenId, opposite);
    if (!this.pendingByKey.has(key)) {
      return 0;
    }
    this.pendingByKey.delete(key);
    return 1;
  }

  async clearTokenPendingDeltas(copyProfileId: string, tokenId: string): Promise<number> {
    let cleared = 0;
    for (const side of ["BUY", "SELL"] as const) {
      const key = pendingKey(copyProfileId, tokenId, side);
      if (this.pendingByKey.delete(key)) {
        cleared += 1;
      }
    }
    return cleared;
  }

  async findOpenCopyAttemptForPendingDelta(pendingDeltaId: string): Promise<OpenCopyAttemptRecord | null> {
    for (const attempt of this.attempts.values()) {
      if (attempt.pendingDeltaId === pendingDeltaId) {
        return attempt;
      }
    }
    return null;
  }

  async createCopyAttempt(input: {
    copyProfileId: string;
    pendingDeltaId: string;
    tokenId: string;
    marketId?: string;
    side: PendingDeltaSide;
    pendingDeltaShares: number;
    pendingDeltaNotionalUsd: number;
    expiresAt: Date;
    maxRetries: number;
    idempotencyKey: string;
  }): Promise<void> {
    const id = `attempt-${++this.attemptSeq}`;
    this.attempts.set(id, {
      id,
      pendingDeltaId: input.pendingDeltaId,
      status: "PENDING"
    });
  }

  getPending(copyProfileId: string, tokenId: string, side: PendingDeltaSide): PendingState | undefined {
    return this.pendingByKey.get(pendingKey(copyProfileId, tokenId, side));
  }
}

test("Stage 8 small deltas accumulate into eligible attempts once notional threshold is crossed", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-1",
      defaultRatio: 0.1,
      leaders: [{ leaderId: "leader-1", ratio: 0.1 }]
    }
  ];

  let nowMs = 1_000_000;
  const engine = new TargetNettingEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 5000,
      minNotionalUsd: 1,
      trackingErrorBps: 0,
      maxRetriesPerAttempt: 20,
      attemptExpirationSeconds: 120
    },
    now: () => nowMs,
    resolvePriceSnapshot: async (tokenId, marketId) => ({
      tokenId,
      marketId,
      midPrice: 0.5,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  store.leaderPositions = [
    {
      leaderId: "leader-1",
      tokenId: "token-a",
      marketId: "market-a",
      shares: 8,
      currentPrice: 0.5,
      currentValueUsd: 4
    }
  ];

  await engine.run();

  const firstPending = store.getPending("cp-1", "token-a", "BUY");
  assert.ok(firstPending);
  assert.equal(firstPending.status, "PENDING");
  assert.equal(firstPending.blockReason, "MIN_NOTIONAL");
  assertApprox(firstPending.pendingDeltaNotionalUsd, 0.4);
  assert.equal(store.attempts.size, 0);

  nowMs += 5_000;
  store.leaderPositions = [
    {
      leaderId: "leader-1",
      tokenId: "token-a",
      marketId: "market-a",
      shares: 24,
      currentPrice: 0.5,
      currentValueUsd: 12
    }
  ];

  await engine.run();

  const secondPending = store.getPending("cp-1", "token-a", "BUY");
  assert.ok(secondPending);
  assert.equal(secondPending.status, "ELIGIBLE");
  assert.equal(secondPending.blockReason, undefined);
  assertApprox(secondPending.pendingDeltaNotionalUsd, 1.2);
  assert.equal(store.attempts.size, 1);

  nowMs += 5_000;
  await engine.run();
  assert.equal(store.attempts.size, 1);
});

test("Stage 8 price preference uses curPrice over market mid and does not block FAK by min order size", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-2",
      defaultRatio: 0.1,
      leaders: [{ leaderId: "leader-2", ratio: 0.1 }]
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-2",
      tokenId: "token-b",
      marketId: "market-b",
      shares: 100,
      currentPrice: 0.7,
      currentValueUsd: 7
    }
  ];

  const engine = new TargetNettingEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 5000,
      minNotionalUsd: 0.5,
      trackingErrorBps: 0,
      maxRetriesPerAttempt: 20,
      attemptExpirationSeconds: 120
    },
    resolvePriceSnapshot: async (tokenId, marketId) => ({
      tokenId,
      marketId,
      midPrice: 0.5,
      minOrderSize: 2,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  const pending = store.getPending("cp-2", "token-b", "BUY");
  assert.ok(pending);
  assertApprox(pending.pendingDeltaShares, 1);
  assertApprox(pending.pendingDeltaNotionalUsd, 0.7);
  assert.equal(pending.status, "ELIGIBLE");
  assert.equal(pending.blockReason, undefined);
  assert.equal(store.attempts.size, 1);
});

test("Stage 8 applies tracking error threshold before creating attempts", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-3",
      defaultRatio: 1,
      leaders: [{ leaderId: "leader-3", ratio: 1 }]
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-3",
      tokenId: "token-c",
      marketId: "market-c",
      shares: 100,
      currentPrice: 1,
      currentValueUsd: 100
    }
  ];
  store.followerByProfile.set("cp-3", [
    {
      tokenId: "token-c",
      shares: 99
    }
  ]);

  const engine = new TargetNettingEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 5000,
      minNotionalUsd: 1,
      trackingErrorBps: 500,
      maxRetriesPerAttempt: 20,
      attemptExpirationSeconds: 120
    },
    resolvePriceSnapshot: async (tokenId, marketId) => ({
      tokenId,
      marketId,
      midPrice: 1,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  const pending = store.getPending("cp-3", "token-c", "BUY");
  assert.ok(pending);
  assertApprox(pending.pendingDeltaNotionalUsd, 1);
  assert.equal(pending.status, "BLOCKED");
  assert.equal(pending.blockReason, "UNKNOWN");
  assert.equal(store.attempts.size, 0);
});

test("Stage 8 clears stale pending deltas when token disappears from leader and follower snapshots", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-4",
      defaultRatio: 1,
      leaders: [{ leaderId: "leader-4", ratio: 1 }]
    }
  ];
  store.leaderPositions = [];
  store.followerByProfile.set("cp-4", []);

  await store.upsertPendingDelta({
    copyProfileId: "cp-4",
    leaderId: "leader-4",
    tokenId: "token-stale",
    marketId: "market-stale",
    side: "BUY",
    pendingDeltaShares: 10,
    pendingDeltaNotionalUsd: 5,
    minExecutableNotionalUsd: 1,
    status: "PENDING",
    blockReason: "MIN_NOTIONAL",
    metadata: {},
    expiresAt: new Date(Date.now() + 60_000)
  });
  assert.ok(store.getPending("cp-4", "token-stale", "BUY"));

  const engine = new TargetNettingEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 5000,
      minNotionalUsd: 1,
      trackingErrorBps: 0,
      maxRetriesPerAttempt: 20,
      attemptExpirationSeconds: 120
    },
    resolvePriceSnapshot: async () => null
  });

  await engine.run();

  assert.equal(store.getPending("cp-4", "token-stale", "BUY"), undefined);
  assert.equal(store.attempts.size, 0);
});

function pendingKey(copyProfileId: string, tokenId: string, side: PendingDeltaSide): string {
  return `${copyProfileId}|${tokenId}|${side}`;
}

function assertApprox(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be approximately ${expected}`);
}
