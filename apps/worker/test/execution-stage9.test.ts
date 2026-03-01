import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEngine } from "../src/execution/engine.js";
import type {
  CopyOrderDraft,
  CopyOrderRecord,
  ExecutionAttemptContext,
  ExecutionAttemptRecord,
  ExecutionOrderRequest,
  ExecutionOrderResult,
  ExecutionStore,
  ExecutionTransitionInput,
  ExecutionVenueClient
} from "../src/execution/types.js";

class FakeExecutionStore implements ExecutionStore {
  attempts = new Map<string, ExecutionAttemptRecord>();
  contexts = new Map<string, ExecutionAttemptContext>();
  orders = new Map<string, {
    id: string;
    idempotencyKey: string;
    copyProfileId: string;
    tokenId: string;
    intendedNotionalUsd: number;
    status: CopyOrderRecord["status"];
    externalOrderId?: string;
    attemptedAt: Date;
  }>();
  orderByIdempotency = new Map<string, string>();
  placed: Array<{ copyOrderId: string; status: string }> = [];
  failures: Array<{ copyOrderId: string; transition: ExecutionTransitionInput }> = [];
  deferred: ExecutionTransitionInput[] = [];
  private orderSeq = 0;
  private readonly lastOrderAtByKey = new Map<string, Date>();

  async listOpenAttempts(limit: number): Promise<ExecutionAttemptRecord[]> {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.status === "PENDING" || attempt.status === "RETRYING")
      .slice(0, limit);
  }

  async getAttemptContext(attemptId: string): Promise<ExecutionAttemptContext | null> {
    return this.contexts.get(attemptId) ?? null;
  }

  async getNotionalTurnoverUsd(copyProfileId: string, since: Date): Promise<number> {
    let total = 0;
    for (const order of this.orders.values()) {
      if (order.copyProfileId !== copyProfileId) {
        continue;
      }
      if (order.attemptedAt < since) {
        continue;
      }
      if (order.status === "PLACED" || order.status === "PARTIALLY_FILLED" || order.status === "FILLED") {
        total += order.intendedNotionalUsd;
      }
    }
    return total;
  }

  async getLastOrderAttemptAt(copyProfileId: string, tokenId: string): Promise<Date | null> {
    return this.lastOrderAtByKey.get(`${copyProfileId}|${tokenId}`) ?? null;
  }

  async createCopyOrderDraft(input: CopyOrderDraft): Promise<CopyOrderRecord> {
    const existingId = this.orderByIdempotency.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.orders.get(existingId);
      if (!existing) {
        throw new Error("order id mapping corrupted");
      }
      return {
        id: existing.id,
        status: existing.status,
        externalOrderId: existing.externalOrderId
      };
    }

    const id = `order-${++this.orderSeq}`;
    this.orders.set(id, {
      id,
      idempotencyKey: input.idempotencyKey,
      copyProfileId: input.copyProfileId,
      tokenId: input.tokenId,
      intendedNotionalUsd: input.intendedNotionalUsd,
      status: "RETRYING",
      attemptedAt: input.attemptedAt
    });
    this.orderByIdempotency.set(input.idempotencyKey, id);
    return {
      id,
      status: "RETRYING"
    };
  }

  async markCopyOrderPlaced(input: {
    copyOrderId: string;
    attemptId: string;
    pendingDeltaId?: string;
    status: "PLACED" | "PARTIALLY_FILLED" | "FILLED";
    externalOrderId?: string;
    responsePayload?: Record<string, unknown>;
    attemptedAt: Date;
  }): Promise<void> {
    const order = this.orders.get(input.copyOrderId);
    if (!order) {
      throw new Error("missing order");
    }
    order.status = input.status;
    order.externalOrderId = input.externalOrderId;
    order.attemptedAt = input.attemptedAt;
    this.placed.push({ copyOrderId: input.copyOrderId, status: input.status });

    const attempt = this.attempts.get(input.attemptId);
    if (attempt) {
      this.attempts.delete(input.attemptId);
    }
    this.lastOrderAtByKey.set(`${order.copyProfileId}|${order.tokenId}`, input.attemptedAt);
  }

  async markCopyOrderFailure(input: {
    copyOrderId: string;
    attemptTransition: ExecutionTransitionInput;
    orderStatus?: "FAILED" | "CANCELLED" | "RETRYING";
  }): Promise<void> {
    const order = this.orders.get(input.copyOrderId);
    if (!order) {
      throw new Error("missing order");
    }
    order.status = input.orderStatus ?? "FAILED";
    order.attemptedAt = input.attemptTransition.attemptedAt;
    this.failures.push({ copyOrderId: input.copyOrderId, transition: input.attemptTransition });
    this.applyTransition(input.attemptTransition);
  }

  async deferAttempt(input: ExecutionTransitionInput): Promise<void> {
    this.deferred.push(input);
    this.applyTransition(input);
  }

  private applyTransition(input: ExecutionTransitionInput): void {
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) {
      return;
    }
    attempt.retries = input.nextRetries;
    attempt.attemptedAt = input.attemptedAt;
    if (input.terminalStatus) {
      attempt.status = "RETRYING";
      attempt.retries = attempt.maxRetries + 1;
      return;
    }
    attempt.status = "RETRYING";
  }
}

class FakeVenueClient implements ExecutionVenueClient {
  requests: ExecutionOrderRequest[] = [];
  private readonly queue: Array<ExecutionOrderResult | Error>;

  constructor(queue: Array<ExecutionOrderResult | Error>) {
    this.queue = [...queue];
  }

  async createAndSubmitOrder(input: ExecutionOrderRequest): Promise<ExecutionOrderResult> {
    this.requests.push(input);
    const next = this.queue.shift();
    if (!next) {
      return {
        status: "PLACED",
        externalOrderId: "ext-default"
      };
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

test("Stage 9 execution engine places valid BUY and SELL FAK orders", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 1_000_000;

  store.attempts.set("attempt-buy", makeAttempt({
    id: "attempt-buy",
    tokenId: "token-buy",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-buy", makeContext("attempt-buy", {
    tokenPrice: 0.5,
    leaderTargetShares: {
      leaderA: 2
    }
  }));

  store.attempts.set("attempt-sell", makeAttempt({
    id: "attempt-sell",
    tokenId: "token-sell",
    side: "SELL",
    accumulatedDeltaShares: 3,
    accumulatedDeltaNotionalUsd: 1.65
  }));
  store.contexts.set("attempt-sell", makeContext("attempt-sell", {
    tokenPrice: 0.55,
    leaderTargetShares: {
      leaderA: 1,
      leaderB: 2
    }
  }));

  const venue = new FakeVenueClient([
    { status: "PLACED", externalOrderId: "ext-buy" },
    { status: "PLACED", externalOrderId: "ext-sell" }
  ]);

  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) =>
      tokenId === "token-buy"
        ? {
            tokenId,
            marketId: "market-buy",
            bestBid: 0.49,
            bestAsk: 0.5,
            midPrice: 0.495,
            tickSize: 0.01,
            minOrderSize: 1,
            negRisk: false,
            isStale: false,
            priceSource: "WS" as const
          }
        : {
            tokenId,
            marketId: "market-sell",
            bestBid: 0.55,
            bestAsk: 0.56,
            midPrice: 0.555,
            tickSize: 0.01,
            minOrderSize: 1,
            negRisk: false,
            isStale: false,
            priceSource: "WS" as const
          },
    fetchOrderBook: async (tokenId) =>
      tokenId === "token-buy"
        ? {
            tokenId,
            marketId: "market-buy",
            bids: [{ price: 0.49, size: 100 }],
            asks: [{ price: 0.5, size: 100 }]
          }
        : {
            tokenId,
            marketId: "market-sell",
            bids: [{ price: 0.55, size: 100 }],
            asks: [{ price: 0.56, size: 100 }]
          }
  });

  await engine.run();

  assert.equal(venue.requests.length, 2);
  const buyRequest = venue.requests.find((request) => request.copyAttemptId === "attempt-buy");
  const sellRequest = venue.requests.find((request) => request.copyAttemptId === "attempt-sell");
  assert.ok(buyRequest);
  assert.ok(sellRequest);
  assert.equal(buyRequest?.amountKind, "USD");
  assert.equal(sellRequest?.amountKind, "SHARES");
  assert.equal(store.placed.length, 2);
});

test("Stage 9 guardrail failures stay pending and do not place orders", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_000_000;
  store.attempts.set("attempt-guard", makeAttempt({
    id: "attempt-guard",
    tokenId: "token-guard",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-guard", makeContext("attempt-guard", {
    tokenPrice: 0.5
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-happen" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-guard",
      bestBid: 0.4,
      bestAsk: 0.6,
      midPrice: 0.5,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-guard",
      bids: [{ price: 0.4, size: 100 }],
      asks: [{ price: 0.6, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "SPREAD");
  assert.equal(store.failures.length, 0);
});

test("Stage 9 handles reverse-ordered CLOB book levels without false spread/thin-book blocks", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_250_000;
  store.attempts.set(
    "attempt-reversed-book",
    makeAttempt({
      id: "attempt-reversed-book",
      tokenId: "token-reversed-book",
      side: "BUY",
      accumulatedDeltaShares: 2,
      accumulatedDeltaNotionalUsd: 1.83
    })
  );
  store.contexts.set(
    "attempt-reversed-book",
    makeContext("attempt-reversed-book", {
      tokenPrice: 0.915
    })
  );

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-reversed-book" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-reversed-book",
      bestBid: 0.91,
      bestAsk: 0.92,
      midPrice: 0.915,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "REST" as const,
      wsConnected: false
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-reversed-book",
      // Reverse-ordered, matching live CLOB ordering observed in production.
      bids: [
        { price: 0.01, size: 100 },
        { price: 0.4, size: 50 },
        { price: 0.91, size: 200 }
      ],
      asks: [
        { price: 0.99, size: 100 },
        { price: 0.95, size: 50 },
        { price: 0.92, size: 200 }
      ]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
  assert.equal(store.deferred.length, 0);
});

test("Stage 9 max price per share can be disabled per-attempt via override", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_500_000;
  store.attempts.set("attempt-price-override", makeAttempt({
    id: "attempt-price-override",
    tokenId: "token-price-override",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1.2
  }));
  store.contexts.set("attempt-price-override", {
    ...makeContext("attempt-price-override", {
      tokenPrice: 0.6
    }),
    maxPricePerShareOverride: null
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-price-override" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxPricePerShare: 0.5
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-price-override",
      bestBid: 0.59,
      bestAsk: 0.6,
      midPrice: 0.595,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-price-override",
      bids: [{ price: 0.59, size: 100 }],
      asks: [{ price: 0.6, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
  assert.equal(store.deferred.length, 0);
});

test("Stage 9 failed attempts retry with backoff until they can be placed", async () => {
  const store = new FakeExecutionStore();
  let nowMs = 3_000_000;

  store.attempts.set("attempt-retry", makeAttempt({
    id: "attempt-retry",
    tokenId: "token-retry",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-retry", makeContext("attempt-retry", {
    tokenPrice: 0.5
  }));

  const venue = new FakeVenueClient([new Error("temporary exchange failure"), { status: "PLACED", externalOrderId: "ext-retry" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-retry",
      bestBid: 0.49,
      bestAsk: 0.5,
      midPrice: 0.495,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-retry",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 1);
  assert.equal(store.failures.length, 1);

  nowMs += 1_000;
  await engine.run();
  assert.equal(venue.requests.length, 1);

  nowMs += 5_000;
  await engine.run();
  assert.equal(venue.requests.length, 2);
  assert.equal(store.placed.length, 1);
});

test("Stage 15 dry-run mode keeps decision pipeline active without submitting orders", async () => {
  const store = new FakeExecutionStore();
  let nowMs = 4_000_000;

  store.attempts.set("attempt-dry-run", makeAttempt({
    id: "attempt-dry-run",
    tokenId: "token-dry-run",
    side: "BUY",
    maxRetries: 1,
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-dry-run", makeContext("attempt-dry-run", {
    tokenPrice: 0.5
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-submit" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      dryRunMode: true
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-dry-run",
      bestBid: 0.49,
      bestAsk: 0.5,
      midPrice: 0.495,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-dry-run",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.placed.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "KILL_SWITCH");
  assert.equal(store.deferred[0]?.terminalStatus, undefined);
  assert.match(store.deferred[0]?.message ?? "", /dry-run mode/i);
  assert.equal(store.attempts.get("attempt-dry-run")?.retries, 1);

  nowMs += 1_000;
  await engine.run();
  assert.equal(store.deferred.length, 1);
  assert.equal(venue.requests.length, 0);

  nowMs += 5_000;
  await engine.run();
  assert.equal(store.deferred.length, 2);
  assert.equal(store.deferred[1]?.terminalStatus, undefined);
  assert.equal(store.attempts.get("attempt-dry-run")?.retries, 2);
  assert.equal(venue.requests.length, 0);
});

test("Stage 9 retries use latest pending delta sizing instead of stale attempt snapshot", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 5_000_000;

  store.attempts.set("attempt-live-delta", makeAttempt({
    id: "attempt-live-delta",
    tokenId: "token-live-delta",
    side: "BUY",
    accumulatedDeltaShares: 88,
    accumulatedDeltaNotionalUsd: 85.888301
  }));
  store.contexts.set("attempt-live-delta", {
    ...makeContext("attempt-live-delta", {
      tokenPrice: 0.6
    }),
    pendingDeltaStatus: "ELIGIBLE",
    pendingDeltaShares: 5,
    pendingDeltaNotionalUsd: 3
  });

  store.orders.set("preexisting-1", {
    id: "preexisting-1",
    idempotencyKey: "preexisting-1",
    copyProfileId: "copy-profile-1",
    tokenId: "token-other",
    intendedNotionalUsd: 15,
    status: "PLACED",
    attemptedAt: new Date(nowMs - 1000)
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-live-delta" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxHourlyNotionalTurnoverUsd: 18,
      maxDailyNotionalTurnoverUsd: 100
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-live-delta",
      bestBid: 0.59,
      bestAsk: 0.6,
      midPrice: 0.595,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-live-delta",
      bids: [{ price: 0.59, size: 100 }],
      asks: [{ price: 0.6, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(store.deferred.length, 0);
  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
});

test("Stage 9 expires attempt when linked pending delta is no longer active", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 6_000_000;

  store.attempts.set("attempt-converted", makeAttempt({
    id: "attempt-converted",
    tokenId: "token-converted",
    side: "BUY",
    accumulatedDeltaShares: 20,
    accumulatedDeltaNotionalUsd: 10
  }));
  store.contexts.set("attempt-converted", {
    ...makeContext("attempt-converted", {
      tokenPrice: 0.5
    }),
    pendingDeltaStatus: "CONVERTED",
    pendingDeltaShares: 0,
    pendingDeltaNotionalUsd: 0
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-submit" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-converted",
      bestBid: 0.49,
      bestAsk: 0.5,
      midPrice: 0.495,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-converted",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "EXPIRED");
  assert.equal(store.deferred[0]?.terminalStatus, "EXPIRED");
});

function makeAttempt(overrides: Partial<ExecutionAttemptRecord> & Pick<ExecutionAttemptRecord, "id" | "tokenId" | "side">): ExecutionAttemptRecord {
  return {
    id: overrides.id,
    copyProfileId: "copy-profile-1",
    leaderId: "leader-1",
    pendingDeltaId: `pending-${overrides.id}`,
    tokenId: overrides.tokenId,
    marketId: `market-${overrides.tokenId}`,
    side: overrides.side,
    retries: 0,
    maxRetries: 20,
    expiresAt: new Date(Date.now() + 60_000),
    attemptedAt: undefined,
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1,
    status: "PENDING",
    ...overrides
  };
}

function makeContext(attemptId: string, metadata: Record<string, unknown>): ExecutionAttemptContext {
  return {
    attemptId,
    copyProfileStatus: "ACTIVE",
    leaderStatus: "ACTIVE",
    pendingDeltaId: `pending-${attemptId}`,
    pendingDeltaStatus: "ELIGIBLE",
    pendingDeltaMetadata: metadata
  };
}

function baseConfig() {
  return {
    enabled: true,
    intervalMs: 3000,
    maxAttemptsPerRun: 20,
    retryBackoffBaseMs: 5000,
    retryBackoffMaxMs: 300000,
    dryRunMode: false,
    copySystemEnabled: true,
    panicMode: false,
    minNotionalUsd: 1,
    maxWorseningBuyUsd: 0.03,
    maxWorseningSellUsd: 0.06,
    maxSlippageBps: 200,
    maxSpreadUsd: 0.03,
    maxDailyNotionalTurnoverUsd: 1000,
    maxHourlyNotionalTurnoverUsd: 1000,
    cooldownPerMarketSeconds: 0
  };
}
