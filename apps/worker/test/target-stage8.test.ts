import assert from "node:assert/strict";
import test from "node:test";
import { TargetNettingEngine } from "../src/target/engine.js";
import type {
  ActiveCopyProfile,
  FollowerPositionPoint,
  LeaderPositionPoint,
  LeaderTradePricePoint,
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

interface CreatedAttemptInput {
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
}

class FakeTargetStore implements TargetNettingStore {
  profiles: ActiveCopyProfile[] = [];
  leaderPositions: LeaderPositionPoint[] = [];
  leaderTradePrices: LeaderTradePricePoint[] = [];
  followerByProfile = new Map<string, FollowerPositionPoint[]>();
  pendingInputs: PendingDeltaInput[] = [];
  attempts = new Map<string, OpenCopyAttemptRecord>();
  createdAttempts: CreatedAttemptInput[] = [];

  private readonly pendingByKey = new Map<string, PendingState>();
  private pendingSeq = 0;
  private attemptSeq = 0;

  async listActiveCopyProfiles(): Promise<ActiveCopyProfile[]> {
    return this.profiles;
  }

  async getLatestLeaderPositions(_leaderIds: string[]): Promise<LeaderPositionPoint[]> {
    return this.leaderPositions;
  }

  async getLatestLeaderTradePrices(args: {
    leaderIds: string[];
    tokenIds: string[];
  }): Promise<LeaderTradePricePoint[]> {
    const leaderSet = new Set(args.leaderIds);
    const tokenSet = new Set(args.tokenIds);
    return this.leaderTradePrices.filter((point) => leaderSet.has(point.leaderId) && tokenSet.has(point.tokenId));
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
    this.createdAttempts.push(input);
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
      leaders: [{ leaderId: "leader-1", ratio: 0.1, settings: {} }]
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
      leaders: [{ leaderId: "leader-2", ratio: 0.1, settings: {} }]
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

test("Stage 8 baseline metadata uses buy avg-entry, sell last-sell-fill, and weighted multi-leader aggregation", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-baseline-weighted",
      defaultRatio: 1,
      leaders: [
        { leaderId: "leader-1", ratio: 1, settings: {} },
        { leaderId: "leader-2", ratio: 1, settings: {} }
      ]
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-1",
      tokenId: "token-weighted",
      marketId: "market-weighted",
      shares: 10,
      avgPrice: 0.4,
      currentPrice: 0.6,
      currentValueUsd: 6
    },
    {
      leaderId: "leader-2",
      tokenId: "token-weighted",
      marketId: "market-weighted",
      shares: 20,
      avgPrice: 0.5,
      currentPrice: 0.7,
      currentValueUsd: 14
    }
  ];
  store.leaderTradePrices = [
    {
      leaderId: "leader-1",
      tokenId: "token-weighted",
      side: "BUY",
      price: 0.45,
      leaderFillAtMs: 1_000
    },
    {
      leaderId: "leader-1",
      tokenId: "token-weighted",
      side: "SELL",
      price: 0.48,
      leaderFillAtMs: 2_000
    },
    {
      leaderId: "leader-2",
      tokenId: "token-weighted",
      side: "BUY",
      price: 0.52,
      leaderFillAtMs: 3_000
    },
    {
      leaderId: "leader-2",
      tokenId: "token-weighted",
      side: "SELL",
      price: 0.62,
      leaderFillAtMs: 4_000
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
      midPrice: 0.55,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  const pending = store.getPending("cp-baseline-weighted", "token-weighted", "BUY");
  assert.ok(pending);
  const baseline = readBaselineMetadata(pending.metadata);
  assert.ok(baseline);
  assertApprox(baseline.buy.weighted as number, 0.4666666667);
  assertApprox(baseline.sell.weighted as number, 0.5733333333);
  assert.equal(baseline.perLeader["leader-1"]?.buy?.source, "AVG_ENTRY");
  assert.equal(baseline.perLeader["leader-2"]?.buy?.source, "AVG_ENTRY");
  assert.equal(baseline.perLeader["leader-1"]?.sell?.source, "LAST_SELL_FILL");
  assert.equal(baseline.perLeader["leader-2"]?.sell?.source, "LAST_SELL_FILL");
});

test("Stage 8 baseline metadata fallback chains work for missing avg and fill inputs", async () => {
  const runScenario = async (args: {
    scenarioId: string;
    avgPrice?: number;
    currentPrice?: number;
    lastBuyFill?: number;
    lastSellFill?: number;
    expectedBuySource: string;
    expectedBuyWeighted: number;
    expectedSellSource: string;
    expectedSellWeighted: number;
  }) => {
    const store = new FakeTargetStore();
    store.profiles = [
      {
        copyProfileId: `cp-${args.scenarioId}`,
        defaultRatio: 1,
        leaders: [{ leaderId: "leader-1", ratio: 1, settings: {} }]
      }
    ];
    store.leaderPositions = [
      {
        leaderId: "leader-1",
        tokenId: `token-${args.scenarioId}`,
        marketId: `market-${args.scenarioId}`,
        shares: 10,
        avgPrice: args.avgPrice,
        currentPrice: args.currentPrice,
        currentValueUsd: args.currentPrice !== undefined ? args.currentPrice * 10 : 7
      }
    ];
    store.leaderTradePrices = [
      ...(args.lastBuyFill !== undefined
        ? [
            {
              leaderId: "leader-1" as const,
              tokenId: `token-${args.scenarioId}`,
              side: "BUY" as const,
              price: args.lastBuyFill,
              leaderFillAtMs: 1_000
            }
          ]
        : []),
      ...(args.lastSellFill !== undefined
        ? [
            {
              leaderId: "leader-1" as const,
              tokenId: `token-${args.scenarioId}`,
              side: "SELL" as const,
              price: args.lastSellFill,
              leaderFillAtMs: 2_000
            }
          ]
        : [])
    ];

    const engine = new TargetNettingEngine({
      store,
      config: {
        enabled: true,
        intervalMs: 5000,
        minNotionalUsd: 0.1,
        trackingErrorBps: 0,
        maxRetriesPerAttempt: 20,
        attemptExpirationSeconds: 120
      },
      resolvePriceSnapshot: async (tokenId, marketId) => ({
        tokenId,
        marketId,
        midPrice: 0.5,
        minOrderSize: 0,
        source: "MARKET_WS"
      })
    });

    await engine.run();

    const pending = store.getPending(`cp-${args.scenarioId}`, `token-${args.scenarioId}`, "BUY");
    assert.ok(pending);
    const baseline = readBaselineMetadata(pending.metadata);
    assert.ok(baseline);
    assert.equal(baseline.perLeader["leader-1"]?.buy?.source, args.expectedBuySource);
    assert.equal(baseline.perLeader["leader-1"]?.sell?.source, args.expectedSellSource);
    assertApprox(baseline.buy.weighted as number, args.expectedBuyWeighted);
    assertApprox(baseline.sell.weighted as number, args.expectedSellWeighted);
  };

  await runScenario({
    scenarioId: "fallback-last-buy",
    currentPrice: 0.7,
    lastBuyFill: 0.53,
    expectedBuySource: "LAST_BUY_FILL",
    expectedBuyWeighted: 0.53,
    expectedSellSource: "CUR_PRICE",
    expectedSellWeighted: 0.7
  });

  await runScenario({
    scenarioId: "fallback-cur",
    currentPrice: 0.68,
    expectedBuySource: "CUR_PRICE",
    expectedBuyWeighted: 0.68,
    expectedSellSource: "CUR_PRICE",
    expectedSellWeighted: 0.68
  });

  await runScenario({
    scenarioId: "fallback-avg-sell",
    avgPrice: 0.42,
    currentPrice: 0.7,
    expectedBuySource: "AVG_ENTRY",
    expectedBuyWeighted: 0.42,
    expectedSellSource: "AVG_ENTRY",
    expectedSellWeighted: 0.42
  });
});

test("Stage 8 applies tracking error threshold before creating attempts", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-3",
      defaultRatio: 1,
      leaders: [{ leaderId: "leader-3", ratio: 1, settings: {} }]
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

test("Stage 8 applies per-leader allow and deny market lists before token aggregation", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-allow-deny",
      defaultRatio: 1,
      leaders: [{ leaderId: "leader-allow-deny", ratio: 1, settings: { allowList: ["market-a"], denyList: ["market-b"] } }]
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-allow-deny",
      tokenId: "token-allow",
      marketId: "market-a",
      shares: 2,
      currentPrice: 1,
      currentValueUsd: 2
    },
    {
      leaderId: "leader-allow-deny",
      tokenId: "token-deny",
      marketId: "market-b",
      shares: 2,
      currentPrice: 1,
      currentValueUsd: 2
    },
    {
      leaderId: "leader-allow-deny",
      tokenId: "token-outside-allow",
      marketId: "market-c",
      shares: 2,
      currentPrice: 1,
      currentValueUsd: 2
    }
  ];

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
    resolvePriceSnapshot: async (tokenId, marketId) => ({
      tokenId,
      marketId,
      midPrice: 1,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  assert.ok(store.getPending("cp-allow-deny", "token-allow", "BUY"));
  assert.equal(store.getPending("cp-allow-deny", "token-deny", "BUY"), undefined);
  assert.equal(store.getPending("cp-allow-deny", "token-outside-allow", "BUY"), undefined);
});

test("Stage 8 applies per-leader minDeltaNotional OR minDeltaShares eligibility", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-min-delta-or",
      defaultRatio: 1,
      leaders: [{ leaderId: "leader-min-delta-or", ratio: 1, settings: { minDeltaNotionalUsd: 2, minDeltaShares: 10 } }]
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-min-delta-or",
      tokenId: "token-notional-pass",
      marketId: "market-notional-pass",
      shares: 1,
      currentPrice: 2,
      currentValueUsd: 2
    },
    {
      leaderId: "leader-min-delta-or",
      tokenId: "token-shares-pass",
      marketId: "market-shares-pass",
      shares: 20,
      currentPrice: 0.05,
      currentValueUsd: 1
    },
    {
      leaderId: "leader-min-delta-or",
      tokenId: "token-fail",
      marketId: "market-fail",
      shares: 5,
      currentPrice: 0.1,
      currentValueUsd: 0.5
    }
  ];

  const engine = new TargetNettingEngine({
    store,
    config: {
      enabled: true,
      intervalMs: 5000,
      minNotionalUsd: 0.2,
      trackingErrorBps: 0,
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

  assert.ok(store.getPending("cp-min-delta-or", "token-notional-pass", "BUY"));
  assert.ok(store.getPending("cp-min-delta-or", "token-shares-pass", "BUY"));
  assert.equal(store.getPending("cp-min-delta-or", "token-fail", "BUY"), undefined);
});

test("Stage 8 uses strictest contributor min-notional for multi-leader token eligibility", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-strictest-leader-min",
      defaultRatio: 0.1,
      leaders: [
        { leaderId: "leader-1", ratio: 0.1, settings: { minNotionalPerOrderUsd: 1 } },
        { leaderId: "leader-2", ratio: 0.1, settings: { minNotionalPerOrderUsd: 3 } }
      ],
      guardrailOverrides: {
        minNotionalUsd: 0.5
      }
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-1",
      tokenId: "token-shared",
      marketId: "market-shared",
      shares: 10,
      currentPrice: 1,
      currentValueUsd: 10
    },
    {
      leaderId: "leader-2",
      tokenId: "token-shared",
      marketId: "market-shared",
      shares: 15,
      currentPrice: 1,
      currentValueUsd: 15
    }
  ];

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
    resolvePriceSnapshot: async (tokenId, marketId) => ({
      tokenId,
      marketId,
      midPrice: 1,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  const pending = store.getPending("cp-strictest-leader-min", "token-shared", "BUY");
  assert.ok(pending);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.blockReason, "MIN_NOTIONAL");
  assert.equal(store.pendingInputs[0]?.minExecutableNotionalUsd, 3);
  assert.deepEqual((store.pendingInputs[0]?.metadata.contributorLeaderIds as string[] | undefined)?.sort(), ["leader-1", "leader-2"]);
});

test("Stage 8 uses copy-profile min-notional override when deciding eligibility", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-override-min",
      defaultRatio: 0.1,
      leaders: [{ leaderId: "leader-override-min", ratio: 0.1, settings: {} }],
      guardrailOverrides: {
        minNotionalUsd: 2
      }
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-override-min",
      tokenId: "token-override-min",
      marketId: "market-override-min",
      shares: 15,
      currentPrice: 1,
      currentValueUsd: 15
    }
  ];

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
    resolvePriceSnapshot: async (tokenId, marketId) => ({
      tokenId,
      marketId,
      midPrice: 1,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  const pending = store.getPending("cp-override-min", "token-override-min", "BUY");
  assert.ok(pending);
  assertApprox(pending.pendingDeltaNotionalUsd, 1.5);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.blockReason, "MIN_NOTIONAL");
  assert.equal(store.attempts.size, 0);
});

test("Stage 8 uses copy-profile maxRetries and expiration overrides for new attempts", async () => {
  const store = new FakeTargetStore();
  const nowMs = 10_000_000;
  store.profiles = [
    {
      copyProfileId: "cp-override-attempt",
      defaultRatio: 0.1,
      leaders: [{ leaderId: "leader-override-attempt", ratio: 0.1, settings: {} }],
      guardrailOverrides: {
        maxRetriesPerAttempt: 7,
        attemptExpirationSeconds: 30
      }
    }
  ];
  store.leaderPositions = [
    {
      leaderId: "leader-override-attempt",
      tokenId: "token-override-attempt",
      marketId: "market-override-attempt",
      shares: 100,
      currentPrice: 1,
      currentValueUsd: 100
    }
  ];

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
      midPrice: 1,
      minOrderSize: 0,
      source: "MARKET_WS"
    })
  });

  await engine.run();

  assert.equal(store.createdAttempts.length, 1);
  const created = store.createdAttempts[0];
  assert.ok(created);
  assert.equal(created.maxRetries, 7);
  assert.equal(created.expiresAt.getTime(), nowMs + 30_000);

  const pending = store.pendingInputs[0];
  assert.ok(pending);
  assert.equal(pending?.expiresAt.getTime(), nowMs + 30_000);
});

test("Stage 8 clears stale pending deltas when token disappears from leader and follower snapshots", async () => {
  const store = new FakeTargetStore();
  store.profiles = [
    {
      copyProfileId: "cp-4",
      defaultRatio: 1,
      leaders: [{ leaderId: "leader-4", ratio: 1, settings: {} }]
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

test("Stage 8 runtime setters update target netting config", () => {
  const store = new FakeTargetStore();
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

  engine.setEnabled(false);
  engine.setIntervalMs(7_500);
  engine.setTrackingErrorBps(15);

  const internals = engine as unknown as {
    config: { enabled: boolean; intervalMs: number; trackingErrorBps: number };
    status: { enabled: boolean };
  };
  assert.equal(internals.config.enabled, false);
  assert.equal(internals.status.enabled, false);
  assert.equal(internals.config.intervalMs, 7_500);
  assert.equal(internals.config.trackingErrorBps, 15);
});

function pendingKey(copyProfileId: string, tokenId: string, side: PendingDeltaSide): string {
  return `${copyProfileId}|${tokenId}|${side}`;
}

function readBaselineMetadata(metadata: Record<string, unknown>): {
  buy: { weighted?: number };
  sell: { weighted?: number };
  perLeader: Record<string, {
    buy?: { source?: string };
    sell?: { source?: string };
  }>;
} | null {
  const raw = metadata.baseline;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as {
    buy: { weighted?: number };
    sell: { weighted?: number };
    perLeader: Record<string, {
      buy?: { source?: string };
      sell?: { source?: string };
    }>;
  };
}

function assertApprox(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be approximately ${expected}`);
}
