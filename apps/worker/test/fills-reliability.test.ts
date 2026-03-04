import assert from "node:assert/strict";
import test from "node:test";
import { FillAttributionService, FillReconcileService, PrismaFillAttributionStore, runFillBackfill } from "../src/fills/index.js";
import type {
  FillAttributionCopyOrder,
  FillAttributionStore,
  FillBackfillRunInput,
  FillHistoryTrade,
  FillIssueInput,
  FillReconcileCheckpoint,
  FillTradeHistoryClient,
  FillTradeHistoryPage,
  IngestTradeFillResult,
  TradeOrderMatchResult,
  UserOrderUpdateEvent,
  UserTradeFillEvent
} from "../src/fills/types.js";

const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";
const DEFAULT_ORDER: FillAttributionCopyOrder = {
  id: "copy-order-1",
  copyProfileId: "profile-1",
  tokenId: "token-1",
  marketId: "market-1",
  side: "BUY",
  externalOrderId: "order-1",
  leaderWeights: { leaderA: 1 }
};

test("CopyFill matching prefers strict externalOrderId before fallback window", async () => {
  const strictRow = makeCopyOrderRow({
    id: "strict-order",
    externalOrderId: "ext-123",
    attemptedAt: new Date("2026-03-01T12:00:00.000Z")
  });
  let fallbackLookupCalled = false;
  const prismaStub = {
    copyOrder: {
      findFirst: async () => strictRow,
      findMany: async () => {
        fallbackLookupCalled = true;
        return [];
      }
    },
    errorEvent: {
      create: async () => undefined
    }
  };

  const store = new PrismaFillAttributionStore(prismaStub as never);
  const result = await store.matchCopyOrderForTrade(makeTradeEvent({ externalOrderIds: ["ext-123"] }));

  assert.equal(result.strategy, "EXTERNAL_ORDER_ID");
  assert.equal(result.order?.id, "strict-order");
  assert.equal(fallbackLookupCalled, false);
});

test("CopyFill matching falls back safely when strict order id misses", async () => {
  const newest = makeCopyOrderRow({
    id: "fallback-newest",
    attemptedAt: new Date("2026-03-01T12:00:00.000Z")
  });
  const olderFar = makeCopyOrderRow({
    id: "fallback-older",
    attemptedAt: new Date("2026-03-01T11:40:00.000Z")
  });
  const prismaStub = {
    copyOrder: {
      findFirst: async () => null,
      findMany: async () => [newest, olderFar]
    },
    errorEvent: {
      create: async () => undefined
    }
  };

  const store = new PrismaFillAttributionStore(prismaStub as never);
  const result = await store.matchCopyOrderForTrade(
    makeTradeEvent({
      externalOrderIds: ["missing-order-id"],
      filledAt: new Date("2026-03-01T12:01:00.000Z")
    })
  );

  assert.equal(result.strategy, "FALLBACK_WINDOW");
  assert.equal(result.order?.id, "fallback-newest");
});

test("CopyFill matching rejects ambiguous fallback candidates and records structured warning", async () => {
  const createdErrorEvents: Array<{ code: string; context: Record<string, unknown> | undefined }> = [];
  const newest = makeCopyOrderRow({
    id: "fallback-1",
    attemptedAt: new Date("2026-03-01T12:00:00.000Z")
  });
  const closeCompetitor = makeCopyOrderRow({
    id: "fallback-2",
    attemptedAt: new Date("2026-03-01T11:58:45.000Z")
  });
  const prismaStub = {
    copyOrder: {
      findFirst: async () => null,
      findMany: async () => [newest, closeCompetitor]
    },
    errorEvent: {
      create: async (input: { data: { code: string; context?: Record<string, unknown> } }) => {
        createdErrorEvents.push({
          code: input.data.code,
          context: input.data.context
        });
      }
    }
  };

  const store = new PrismaFillAttributionStore(prismaStub as never);
  const result = await store.matchCopyOrderForTrade(
    makeTradeEvent({
      externalTradeId: "trade-ambiguous",
      externalOrderIds: [],
      filledAt: new Date("2026-03-01T12:01:00.000Z")
    })
  );

  assert.equal(result.strategy, "NONE");
  assert.equal(result.unmatchedReason, "AMBIGUOUS_FALLBACK");
  assert.deepEqual(result.ambiguousCandidateOrderIds, ["fallback-1", "fallback-2"]);
  assert.equal(createdErrorEvents.length, 1);
  assert.equal(createdErrorEvents[0]?.code, "USER_CHANNEL_AMBIGUOUS_ORDER_MATCH");
});

test("Fill reconcile loop ingests matched trades once, updates checkpoints, and tracks unmatched/duplicates", async () => {
  const nowMs = 1_700_000_000_000;
  const store = new FakeFillStore();
  store.defaultOrder = DEFAULT_ORDER;
  store.followerAddresses = [ADDRESS_B];
  store.existingFillIds.add("trade-2");
  store.matchOverrides.set("trade-3", {
    order: null,
    strategy: "NONE",
    unmatchedReason: "AMBIGUOUS_FALLBACK"
  });
  store.checkpoints.set(`maker:${ADDRESS_A}`, {
    cursorAtMs: 500,
    updatedAtMs: nowMs - 60_000
  });

  const tradeClient = new FakeTradeHistoryClient({
    [ADDRESS_A]: {
      "": {
        trades: [
          makeHistoryTrade({ id: "trade-1", makerOrderIds: ["order-1"], matchTimeMs: nowMs - 50_000 }),
          makeHistoryTrade({ id: "trade-2", makerOrderIds: ["order-2"], matchTimeMs: nowMs - 40_000 })
        ],
        nextCursor: "cursor-a-1"
      },
      "cursor-a-1": {
        trades: [makeHistoryTrade({ id: "trade-1", makerOrderIds: ["order-1"], matchTimeMs: nowMs - 50_000 })]
      }
    },
    [ADDRESS_B]: {
      "": {
        trades: [
          makeHistoryTrade({ id: "trade-2", makerOrderIds: ["order-2"], matchTimeMs: nowMs - 40_000 }),
          makeHistoryTrade({ id: "trade-3", makerOrderIds: ["order-3"], matchTimeMs: nowMs - 30_000 })
        ]
      }
    }
  });

  const reconcile = new FillReconcileService({
    store,
    tradeClient,
    preferredMakerAddresses: [ADDRESS_A],
    config: {
      enabled: true,
      intervalMs: 30_000,
      defaultLookbackDays: 1,
      maxPagesPerAddress: 10
    },
    now: () => nowMs
  });

  await reconcile.run();
  const status = reconcile.getStatus();

  assert.equal(status.totalRuns, 1);
  assert.equal(status.totalFailures, 0);
  assert.equal(status.lastTradesSeen, 3);
  assert.equal(status.lastMatchedOrders, 2);
  assert.equal(status.lastFillsInserted, 1);
  assert.equal(status.lastDuplicates, 1);
  assert.equal(status.lastUnmatched, 1);
  assert.equal(status.lastAmbiguousUnmatched, 1);
  assert.deepEqual(store.ingestCalls, ["trade-1", "trade-2"]);
  assert.equal(store.checkpoints.get(`maker:${ADDRESS_A}`)?.cursorAtMs, nowMs - 40_000);
  assert.equal(store.checkpoints.get(`maker:${ADDRESS_B}`)?.cursorAtMs, nowMs - 30_000);

  const firstCallForA = tradeClient.calls.find((call) => call.makerAddress === ADDRESS_A);
  const firstCallForB = tradeClient.calls.find((call) => call.makerAddress === ADDRESS_B);
  assert.equal(firstCallForA?.afterMs, 500);
  assert.equal(firstCallForB?.afterMs, nowMs - 86_400_000);
});

test("fills:backfill dry-run reports inserts/duplicates without writes", async () => {
  const nowMs = 1_700_100_000_000;
  const store = new FakeFillStore();
  store.defaultOrder = DEFAULT_ORDER;
  store.existingFillIds.add("trade-2");
  const tradeClient = new FakeTradeHistoryClient({
    [ADDRESS_A]: {
      "": {
        trades: [
          makeHistoryTrade({ id: "trade-1", makerOrderIds: ["order-1"], matchTimeMs: 1_000 }),
          makeHistoryTrade({ id: "trade-2", makerOrderIds: ["order-2"], matchTimeMs: 2_000 })
        ]
      }
    }
  });

  const input: FillBackfillRunInput = {
    apply: false,
    lookbackDays: 7,
    maxPagesPerAddress: 5
  };

  const result = await runFillBackfill(store, tradeClient, [ADDRESS_A], input, () => nowMs);

  assert.deepEqual(result, {
    tradesSeen: 2,
    matchedOrders: 2,
    fillsInserted: 1,
    duplicates: 1,
    unmatched: 0,
    ambiguousUnmatched: 0
  });
  assert.equal(store.ingestCalls.length, 0);
});

test("fills:backfill apply is idempotent across reruns", async () => {
  const store = new FakeFillStore();
  store.defaultOrder = DEFAULT_ORDER;
  const tradeClient = new FakeTradeHistoryClient({
    [ADDRESS_A]: {
      "": {
        trades: [
          makeHistoryTrade({ id: "trade-1", makerOrderIds: ["order-1"], matchTimeMs: 1_000 }),
          makeHistoryTrade({ id: "trade-2", makerOrderIds: ["order-2"], matchTimeMs: 2_000 })
        ]
      }
    }
  });

  const input: FillBackfillRunInput = {
    apply: true,
    lookbackDays: 3,
    maxPagesPerAddress: 5
  };

  const firstRun = await runFillBackfill(store, tradeClient, [ADDRESS_A], input, () => 1_700_100_000_000);
  const secondRun = await runFillBackfill(store, tradeClient, [ADDRESS_A], input, () => 1_700_100_000_000);

  assert.equal(firstRun.fillsInserted, 2);
  assert.equal(firstRun.duplicates, 0);
  assert.equal(secondRun.fillsInserted, 0);
  assert.equal(secondRun.duplicates, 2);
  assert.equal(store.persistedFillIds.size, 2);
});

test("Parse starvation degrades health once and clears on recovery", async () => {
  const store = new FakeFillStore();
  let nowMs = 1_000_000;
  const service = new FillAttributionService({
    store,
    config: {
      enabled: true,
      url: "wss://ws.example",
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "pass",
      parseStarvationWindowMs: 5_000,
      parseStarvationMinMessages: 3,
      parseStarvationCheckIntervalMs: 1_000
    },
    now: () => nowMs
  });

  const wsMetrics = {
    connected: true,
    receivedMessages: 0,
    tradeMessages: 0,
    orderMessages: 0,
    unknownMessages: 0,
    parseErrors: 0,
    recognizedEventMessages: 0,
    reconnectCount: 0,
    lastMessageAtMs: nowMs,
    lastUnknownSampleType: "mystery"
  };

  const serviceInternals = service as unknown as {
    wsClient?: { getMetrics: () => typeof wsMetrics };
    evaluateParseHealth: () => Promise<void>;
  };
  serviceInternals.wsClient = {
    getMetrics: () => wsMetrics
  };

  await serviceInternals.evaluateParseHealth();
  nowMs += 1_000;
  wsMetrics.receivedMessages = 4;
  await serviceInternals.evaluateParseHealth();

  const degraded = service.getStatus();
  assert.equal(degraded.degraded, true);
  assert.equal(store.reportedIssues.length, 1);
  assert.equal(store.reportedIssues[0]?.code, "USER_CHANNEL_PARSE_STARVATION");

  nowMs += 1_000;
  wsMetrics.receivedMessages = 5;
  await serviceInternals.evaluateParseHealth();
  assert.equal(store.reportedIssues.length, 1);

  nowMs += 1_000;
  wsMetrics.recognizedEventMessages = 1;
  await serviceInternals.evaluateParseHealth();
  const recovered = service.getStatus();
  assert.equal(recovered.degraded, false);
  assert.equal(recovered.degradedReason, undefined);
});

test("fill attribution runtime enable toggle delegates to start/stop", () => {
  const store = new FakeFillStore();
  const service = new FillAttributionService({
    store,
    config: {
      enabled: false,
      url: "wss://ws.example",
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "pass",
      parseStarvationWindowMs: 5_000,
      parseStarvationMinMessages: 3,
      parseStarvationCheckIntervalMs: 1_000
    },
    now: () => 1_000
  });

  let starts = 0;
  let stops = 0;
  const mutable = service as unknown as { start: () => void; stop: () => void };
  mutable.start = () => {
    starts += 1;
  };
  mutable.stop = () => {
    stops += 1;
  };

  service.setEnabled(true);
  service.setEnabled(true);
  service.setEnabled(false);
  service.setEnabled(false);

  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(service.getStatus().enabled, false);
});

test("fill attribution parse starvation config can be updated at runtime", () => {
  const store = new FakeFillStore();
  const service = new FillAttributionService({
    store,
    config: {
      enabled: true,
      url: "wss://ws.example",
      apiKey: "key",
      apiSecret: "secret",
      passphrase: "pass",
      parseStarvationWindowMs: 5_000,
      parseStarvationMinMessages: 3,
      parseStarvationCheckIntervalMs: 1_000
    },
    now: () => 1_000
  });

  service.setParseStarvationConfig({
    windowSeconds: 120,
    minMessages: 17
  });

  const internals = service as unknown as {
    config: {
      parseStarvationWindowMs: number;
      parseStarvationMinMessages: number;
      parseStarvationCheckIntervalMs: number;
    };
  };
  assert.equal(internals.config.parseStarvationWindowMs, 120_000);
  assert.equal(internals.config.parseStarvationMinMessages, 17);
  assert.equal(internals.config.parseStarvationCheckIntervalMs, 24_000);
});

test("fill reconcile runtime enable and interval updates apply", () => {
  const store = new FakeFillStore();
  const reconcile = new FillReconcileService({
    store,
    tradeClient: new FakeTradeHistoryClient({}),
    config: {
      enabled: false,
      intervalMs: 30_000,
      defaultLookbackDays: 30,
      maxPagesPerAddress: 2
    },
    preferredMakerAddresses: []
  });

  reconcile.setEnabled(true);
  reconcile.setEnabled(true);
  reconcile.setIntervalMs(4_500);
  reconcile.setEnabled(false);

  const internals = reconcile as unknown as {
    config: { enabled: boolean; intervalMs: number };
    status: { enabled: boolean };
  };
  assert.equal(internals.config.enabled, false);
  assert.equal(internals.status.enabled, false);
  assert.equal(internals.config.intervalMs, 4_500);
});

function makeTradeEvent(overrides: Partial<UserTradeFillEvent>): UserTradeFillEvent {
  return {
    externalTradeId: overrides.externalTradeId ?? "trade-1",
    externalOrderIds: overrides.externalOrderIds ?? ["order-1"],
    tokenId: overrides.tokenId ?? "token-1",
    marketId: overrides.marketId ?? "market-1",
    side: overrides.side ?? "BUY",
    filledShares: overrides.filledShares ?? 2,
    price: overrides.price ?? 0.5,
    filledUsdcGross: overrides.filledUsdcGross ?? 1,
    feeUsdc: overrides.feeUsdc ?? 0,
    filledAt: overrides.filledAt ?? new Date("2026-03-01T12:01:00.000Z"),
    payload: overrides.payload ?? {}
  };
}

function makeCopyOrderRow(overrides: Partial<{
  id: string;
  copyProfileId: string;
  tokenId: string;
  marketId: string | null;
  side: "BUY" | "SELL";
  externalOrderId: string | null;
  leaderWeights: Record<string, unknown>;
  unattributedWeight: null;
  attemptedAt: Date | null;
}> = {}) {
  return {
    id: overrides.id ?? "copy-order-1",
    copyProfileId: overrides.copyProfileId ?? "profile-1",
    tokenId: overrides.tokenId ?? "token-1",
    marketId: overrides.marketId ?? "market-1",
    side: overrides.side ?? "BUY",
    externalOrderId: overrides.externalOrderId ?? "order-1",
    leaderWeights: overrides.leaderWeights ?? { leaderA: 1 },
    unattributedWeight: overrides.unattributedWeight ?? null,
    attemptedAt: overrides.attemptedAt ?? new Date("2026-03-01T12:00:00.000Z")
  };
}

function makeHistoryTrade(overrides: Partial<FillHistoryTrade>): FillHistoryTrade {
  return {
    id: overrides.id ?? "trade-1",
    takerOrderId: overrides.takerOrderId ?? "taker-order-1",
    makerOrderIds: overrides.makerOrderIds ?? ["order-1"],
    tokenId: overrides.tokenId ?? "token-1",
    marketId: overrides.marketId ?? "market-1",
    side: overrides.side ?? "BUY",
    size: overrides.size ?? 2,
    price: overrides.price ?? 0.5,
    feeRateBps: overrides.feeRateBps ?? 0,
    matchTimeMs: overrides.matchTimeMs ?? 1_000,
    lastUpdateMs: overrides.lastUpdateMs ?? overrides.matchTimeMs ?? 1_000,
    makerAddresses: overrides.makerAddresses ?? [ADDRESS_A],
    payload: overrides.payload ?? {}
  };
}

class FakeFillStore implements FillAttributionStore {
  defaultOrder: FillAttributionCopyOrder = DEFAULT_ORDER;
  followerAddresses: string[] = [];
  matchOverrides = new Map<string, TradeOrderMatchResult>();
  persistedFillIds = new Set<string>();
  existingFillIds = new Set<string>();
  checkpoints = new Map<string, FillReconcileCheckpoint>();
  reportedIssues: FillIssueInput[] = [];
  ingestCalls: string[] = [];

  async matchCopyOrderForTrade(event: UserTradeFillEvent): Promise<TradeOrderMatchResult> {
    return this.matchOverrides.get(event.externalTradeId) ?? { order: this.defaultOrder, strategy: "EXTERNAL_ORDER_ID" };
  }

  async ingestTradeFill(args: { order: FillAttributionCopyOrder; event: UserTradeFillEvent }): Promise<IngestTradeFillResult> {
    this.ingestCalls.push(args.event.externalTradeId);
    if (this.persistedFillIds.has(args.event.externalTradeId) || this.existingFillIds.has(args.event.externalTradeId)) {
      return {
        matchedOrder: true,
        duplicate: true,
        copyFillId: `fill-${args.event.externalTradeId}`,
        copyOrderId: args.order.id,
        allocationsInserted: 0,
        ledgerUpdates: 0,
        realizedPnlDeltaByLeader: {}
      };
    }

    this.persistedFillIds.add(args.event.externalTradeId);
    return {
      matchedOrder: true,
      duplicate: false,
      copyFillId: `fill-${args.event.externalTradeId}`,
      copyOrderId: args.order.id,
      allocationsInserted: 1,
      ledgerUpdates: 1,
      realizedPnlDeltaByLeader: { leaderA: 0.01 }
    };
  }

  async applyOrderUpdate(_event: UserOrderUpdateEvent): Promise<boolean> {
    return false;
  }

  async hasCopyFillByExternalTradeId(externalTradeId: string): Promise<boolean> {
    return this.persistedFillIds.has(externalTradeId) || this.existingFillIds.has(externalTradeId);
  }

  async listFollowerAddresses(): Promise<string[]> {
    return [...this.followerAddresses];
  }

  async readFillReconcileCheckpoint(key: string): Promise<FillReconcileCheckpoint | null> {
    return this.checkpoints.get(key) ?? null;
  }

  async writeFillReconcileCheckpoint(key: string, checkpoint: FillReconcileCheckpoint): Promise<void> {
    this.checkpoints.set(key, checkpoint);
  }

  async reportFillIssue(input: FillIssueInput): Promise<void> {
    this.reportedIssues.push(input);
  }
}

class FakeTradeHistoryClient implements FillTradeHistoryClient {
  calls: Array<{
    makerAddress: string;
    afterMs?: number;
    beforeMs?: number;
    nextCursor?: string;
  }> = [];

  constructor(
    private readonly pagesByAddressAndCursor: Record<
      string,
      Record<string, FillTradeHistoryPage | undefined>
    >
  ) {}

  async fetchTradesPage(args: {
    makerAddress: string;
    afterMs?: number;
    beforeMs?: number;
    nextCursor?: string;
  }): Promise<FillTradeHistoryPage> {
    this.calls.push(args);
    const byCursor = this.pagesByAddressAndCursor[args.makerAddress] ?? {};
    const key = args.nextCursor ?? "";
    const page = byCursor[key];
    if (!page) {
      return { trades: [] };
    }
    return {
      trades: [...page.trades],
      nextCursor: page.nextCursor
    };
  }
}
