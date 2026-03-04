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
  invariantRepairCalls = 0;
  pendingDeltasConvertedByInvariantRepair = 0;
  attemptsClosedByInvariantRepair = 0;
  leaderRecentNotionalTurnover = new Map<string, number>();
  leaderLedgerPositions: Array<{ copyProfileId: string; leaderId: string; tokenId: string; shares: number }> = [];
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

  async getLeaderRecentNotionalTurnoverUsd(args: {
    copyProfileId: string;
    leaderIds: string[];
    since: Date;
  }): Promise<Record<string, number>> {
    void args.since;
    const output: Record<string, number> = {};
    for (const leaderId of args.leaderIds) {
      output[leaderId] = this.leaderRecentNotionalTurnover.get(`${args.copyProfileId}|${leaderId}`) ?? 0;
    }
    return output;
  }

  async listLeaderLedgerPositions(args: {
    copyProfileId: string;
    leaderIds: string[];
  }): Promise<Array<{ leaderId: string; tokenId: string; shares: number }>> {
    const leaderIdSet = new Set(args.leaderIds);
    return this.leaderLedgerPositions
      .filter((row) => row.copyProfileId === args.copyProfileId && leaderIdSet.has(row.leaderId))
      .map((row) => ({
        leaderId: row.leaderId,
        tokenId: row.tokenId,
        shares: row.shares
      }));
  }

  async countOpenOrders(copyProfileId: string): Promise<number> {
    let count = 0;
    for (const order of this.orders.values()) {
      if (order.copyProfileId !== copyProfileId) {
        continue;
      }
      if (!order.externalOrderId) {
        continue;
      }
      if (order.status === "PLACED" || order.status === "PARTIALLY_FILLED" || order.status === "RETRYING") {
        count += 1;
      }
    }
    return count;
  }

  async getLastOrderAttemptAt(copyProfileId: string, tokenId: string): Promise<Date | null> {
    return this.lastOrderAtByKey.get(`${copyProfileId}|${tokenId}`) ?? null;
  }

  setLastOrderAttemptAt(copyProfileId: string, tokenId: string, attemptedAt: Date): void {
    this.lastOrderAtByKey.set(`${copyProfileId}|${tokenId}`, attemptedAt);
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

  async repairExecutionInvariants(): Promise<{ pendingDeltasConverted: number; attemptsClosed: number }> {
    this.invariantRepairCalls += 1;
    return {
      pendingDeltasConverted: this.pendingDeltasConvertedByInvariantRepair,
      attemptsClosed: this.attemptsClosedByInvariantRepair
    };
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
  assert.equal(store.invariantRepairCalls, 1);
});

test("Stage 9 runs invariant repair before processing open attempts", async () => {
  const store = new FakeExecutionStore();
  let nowMs = 1_050_000;

  store.attempts.set("attempt-invariant", makeAttempt({
    id: "attempt-invariant",
    tokenId: "token-invariant",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-invariant", makeContext("attempt-invariant", {
    tokenPrice: 0.5
  }));
  store.pendingDeltasConvertedByInvariantRepair = 2;

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-invariant" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-invariant",
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
      marketId: "market-invariant",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(store.invariantRepairCalls, 1);
  assert.equal(store.placed.length, 1);

  nowMs += 10_000;
  await engine.run();
  assert.equal(store.invariantRepairCalls, 2);
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

test("Stage 9 max-worsening override can tighten price cap and defer on thin books", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_050_000;
  store.attempts.set("attempt-override-worsening", makeAttempt({
    id: "attempt-override-worsening",
    tokenId: "token-override-worsening",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-override-worsening", {
    ...makeContext("attempt-override-worsening", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      maxWorseningBuyUsd: 0.005
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-override-worsening",
      bestBid: 0.5,
      bestAsk: 0.51,
      midPrice: 0.505,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-override-worsening",
      bids: [{ price: 0.5, size: 100 }],
      asks: [{ price: 0.51, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "THIN_BOOK");
});

test("Stage 9 spread override blocks execution even when env spread would allow", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_075_000;
  store.attempts.set("attempt-override-spread", makeAttempt({
    id: "attempt-override-spread",
    tokenId: "token-override-spread",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-override-spread", {
    ...makeContext("attempt-override-spread", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      maxSpreadUsd: 0.005
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-override-spread",
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
      marketId: "market-override-spread",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "SPREAD");
});

test("Stage 9 min-notional override can defer BUY attempts on thin books", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_100_000;
  store.attempts.set("attempt-override-min-notional", makeAttempt({
    id: "attempt-override-min-notional",
    tokenId: "token-override-min-notional",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-override-min-notional", {
    ...makeContext("attempt-override-min-notional", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      minNotionalUsd: 2
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-override-min-notional",
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
      marketId: "market-override-min-notional",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 2 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "THIN_BOOK");
});

test("Stage 9 cooldown override rate-limits attempts without changing env defaults", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_125_000;
  store.attempts.set("attempt-override-cooldown", makeAttempt({
    id: "attempt-override-cooldown",
    tokenId: "token-override-cooldown",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-override-cooldown", {
    ...makeContext("attempt-override-cooldown", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      cooldownPerMarketSeconds: 10
    }
  });
  store.setLastOrderAttemptAt("copy-profile-1", "token-override-cooldown", new Date(nowMs - 5_000));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      cooldownPerMarketSeconds: 0
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-override-cooldown",
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
      marketId: "market-override-cooldown",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
});

test("Stage 9 falls back to env guardrails when profile overrides are absent", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_150_000;
  store.attempts.set("attempt-no-overrides", makeAttempt({
    id: "attempt-no-overrides",
    tokenId: "token-no-overrides",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-no-overrides", makeContext("attempt-no-overrides", {
    tokenPrice: 0.5
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-no-overrides" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-no-overrides",
      bestBid: 0.5,
      bestAsk: 0.51,
      midPrice: 0.505,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-no-overrides",
      bids: [{ price: 0.5, size: 100 }],
      asks: [{ price: 0.51, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
  assert.equal(store.deferred.length, 0);
});

test("Stage 9 min-book-depth guard can be disabled via profile override", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_180_000;
  store.attempts.set("attempt-min-depth-disabled", makeAttempt({
    id: "attempt-min-depth-disabled",
    tokenId: "token-min-depth-disabled",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-min-depth-disabled", {
    ...makeContext("attempt-min-depth-disabled", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      minBookDepthForSizeEnabled: false
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-min-depth-disabled" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-min-depth-disabled",
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
      marketId: "market-min-depth-disabled",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 1 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
  assert.equal(store.deferred.length, 0);
});

test("Stage 9 min-book-depth guard stays active when explicitly enabled by override", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_190_000;
  store.attempts.set("attempt-min-depth-enabled", makeAttempt({
    id: "attempt-min-depth-enabled",
    tokenId: "token-min-depth-enabled",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-min-depth-enabled", {
    ...makeContext("attempt-min-depth-enabled", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      minBookDepthForSizeEnabled: true
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      minBookDepthForSizeEnabled: false
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-min-depth-enabled",
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
      marketId: "market-min-depth-enabled",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 1 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "THIN_BOOK");
});

test("Stage 9 max-open-orders override blocks new submission when limit is reached", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_195_000;
  store.attempts.set("attempt-open-orders-block", makeAttempt({
    id: "attempt-open-orders-block",
    tokenId: "token-open-orders-block",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-open-orders-block", {
    ...makeContext("attempt-open-orders-block", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      maxOpenOrders: 1
    }
  });
  store.orders.set("existing-open", {
    id: "existing-open",
    idempotencyKey: "existing-open",
    copyProfileId: "copy-profile-1",
    tokenId: "token-existing-open",
    intendedNotionalUsd: 3,
    status: "PLACED",
    externalOrderId: "ext-existing-open",
    attemptedAt: new Date(nowMs - 1_000)
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-open-orders-block",
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
      marketId: "market-open-orders-block",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
  assert.equal(store.deferred[0]?.context?.maxOpenOrders, 1);
});

test("Stage 9 max-open-orders null override disables open-order blocking", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_198_000;
  store.attempts.set("attempt-open-orders-null", makeAttempt({
    id: "attempt-open-orders-null",
    tokenId: "token-open-orders-null",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-open-orders-null", {
    ...makeContext("attempt-open-orders-null", {
      tokenPrice: 0.5
    }),
    guardrailOverrides: {
      maxOpenOrders: null
    }
  });
  store.orders.set("existing-open-null", {
    id: "existing-open-null",
    idempotencyKey: "existing-open-null",
    copyProfileId: "copy-profile-1",
    tokenId: "token-existing-open-null",
    intendedNotionalUsd: 3,
    status: "PLACED",
    externalOrderId: "ext-existing-open-null",
    attemptedAt: new Date(nowMs - 1_000)
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-open-orders-null" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxOpenOrders: 1
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-open-orders-null",
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
      marketId: "market-open-orders-null",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
  assert.equal(store.deferred.length, 0);
});

test("Stage 9 profile sizing hourly turnover override is enforced at runtime", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_205_000;
  store.attempts.set("attempt-hourly-override", makeAttempt({
    id: "attempt-hourly-override",
    tokenId: "token-hourly-override",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-hourly-override", {
    ...makeContext("attempt-hourly-override", {
      tokenPrice: 0.5
    }),
    profileSizingOverrides: {
      maxHourlyNotionalTurnoverUsd: 3
    }
  });
  store.orders.set("existing-hourly-turnover", {
    id: "existing-hourly-turnover",
    idempotencyKey: "existing-hourly-turnover",
    copyProfileId: "copy-profile-1",
    tokenId: "token-hourly-existing",
    intendedNotionalUsd: 2.5,
    status: "PLACED",
    externalOrderId: "ext-hourly-existing",
    attemptedAt: new Date(nowMs - 10_000)
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxHourlyNotionalTurnoverUsd: 100,
      maxDailyNotionalTurnoverUsd: 100
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-hourly-override",
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
      marketId: "market-hourly-override",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
  assert.equal(store.deferred[0]?.context?.maxHourlyNotionalTurnoverUsd, 3);
});

test("Stage 9 profile sizing daily turnover override is enforced at runtime", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_210_000;
  store.attempts.set("attempt-daily-override", makeAttempt({
    id: "attempt-daily-override",
    tokenId: "token-daily-override",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-daily-override", {
    ...makeContext("attempt-daily-override", {
      tokenPrice: 0.5
    }),
    profileSizingOverrides: {
      maxDailyNotionalTurnoverUsd: 3,
      maxHourlyNotionalTurnoverUsd: 100
    }
  });
  store.orders.set("existing-daily-turnover", {
    id: "existing-daily-turnover",
    idempotencyKey: "existing-daily-turnover",
    copyProfileId: "copy-profile-1",
    tokenId: "token-daily-existing",
    intendedNotionalUsd: 2.5,
    status: "PLACED",
    externalOrderId: "ext-daily-existing",
    attemptedAt: new Date(nowMs - 4_000_000)
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxHourlyNotionalTurnoverUsd: 100,
      maxDailyNotionalTurnoverUsd: 100
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-daily-override",
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
      marketId: "market-daily-override",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
  assert.equal(store.deferred[0]?.context?.maxDailyNotionalTurnoverUsd, 3);
});

test("Stage 9 falls back to env sizing caps when profile sizing overrides are absent", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_212_000;
  store.attempts.set("attempt-sizing-fallback", makeAttempt({
    id: "attempt-sizing-fallback",
    tokenId: "token-sizing-fallback",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-sizing-fallback", makeContext("attempt-sizing-fallback", {
    tokenPrice: 0.5
  }));
  store.orders.set("existing-hourly-fallback", {
    id: "existing-hourly-fallback",
    idempotencyKey: "existing-hourly-fallback",
    copyProfileId: "copy-profile-1",
    tokenId: "token-hourly-fallback-existing",
    intendedNotionalUsd: 2.5,
    status: "PLACED",
    externalOrderId: "ext-hourly-fallback-existing",
    attemptedAt: new Date(nowMs - 10_000)
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxHourlyNotionalTurnoverUsd: 3
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-sizing-fallback",
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
      marketId: "market-sizing-fallback",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
  assert.equal(store.deferred[0]?.context?.maxHourlyNotionalTurnoverUsd, 3);
});

test("Stage 9 profile sizing exposure caps apply when leader-specific caps are unset", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_215_000;
  store.attempts.set("attempt-profile-exposure-defaults", makeAttempt({
    id: "attempt-profile-exposure-defaults",
    tokenId: "token-profile-exposure-defaults",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-profile-exposure-defaults", {
    ...makeContext("attempt-profile-exposure-defaults", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 2
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {}
    },
    profileSizingOverrides: {
      maxExposurePerMarketOutcomeUsd: 5.2,
      maxExposurePerLeaderUsd: 6
    }
  });
  store.leaderLedgerPositions = [
    {
      copyProfileId: "copy-profile-1",
      leaderId: "leader-1",
      tokenId: "token-profile-exposure-defaults",
      shares: 10
    },
    {
      copyProfileId: "copy-profile-1",
      leaderId: "leader-1",
      tokenId: "token-profile-other-held",
      shares: 10
    }
  ];

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxExposurePerMarketOutcomeUsd: 1_000,
      maxExposurePerLeaderUsd: 1_000
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: tokenId === "token-profile-other-held" ? "market-profile-other-held" : "market-profile-exposure-defaults",
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
      marketId: "market-profile-exposure-defaults",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
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

test("Stage 9 per-attempt max-price override takes precedence over env max-price", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_550_000;
  store.attempts.set("attempt-price-precedence", makeAttempt({
    id: "attempt-price-precedence",
    tokenId: "token-price-precedence",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1.2
  }));
  store.contexts.set("attempt-price-precedence", {
    ...makeContext("attempt-price-precedence", {
      tokenPrice: 0.6
    }),
    maxPricePerShareOverride: 0.61
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-price-precedence" }]);
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
      marketId: "market-price-precedence",
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
      marketId: "market-price-precedence",
      bids: [{ price: 0.59, size: 100 }],
      asks: [{ price: 0.6, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
  assert.equal(store.deferred.length, 0);
});

test("Stage 9 per-leader maxSlippageBps strictest override blocks attempts that env would allow", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_700_000;
  store.attempts.set("attempt-leader-slippage", makeAttempt({
    id: "attempt-leader-slippage",
    tokenId: "token-leader-slippage",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-leader-slippage", {
    ...makeContext("attempt-leader-slippage", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 2
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        maxSlippageBps: 10
      }
    },
    guardrailOverrides: {
      maxSlippageBps: 10
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxSlippageBps: 500
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-leader-slippage",
      bestBid: 0.5,
      bestAsk: 0.52,
      midPrice: 0.51,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-leader-slippage",
      bids: [{ price: 0.5, size: 100 }],
      asks: [{ price: 0.52, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.ok(store.deferred[0]?.reason === "SLIPPAGE" || store.deferred[0]?.reason === "THIN_BOOK");
});

test("Stage 9 BUY worsening baseline uses weighted leader entry metadata before legacy tokenPrice", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_710_000;
  store.attempts.set("attempt-buy-baseline-weighted", makeAttempt({
    id: "attempt-buy-baseline-weighted",
    tokenId: "token-buy-baseline-weighted",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1.4
  }));
  store.contexts.set("attempt-buy-baseline-weighted", makeContext("attempt-buy-baseline-weighted", {
    tokenPrice: 0.7,
    baseline: {
      version: 1,
      buy: {
        weighted: 0.5
      },
      sell: {},
      perLeader: {}
    },
    leaderTargetShares: {
      "leader-1": 2
    }
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-buy-baseline-weighted",
      bestBid: 0.7,
      bestAsk: 0.71,
      midPrice: 0.705,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-buy-baseline-weighted",
      bids: [{ price: 0.7, size: 100 }],
      asks: [{ price: 0.71, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "THIN_BOOK");
  assert.equal(
    (store.deferred[0]?.context?.leaderBaseline as { source?: string } | undefined)?.source,
    "baseline.v1.buy.weighted"
  );
});

test("Stage 9 SELL worsening baseline uses weighted last-sell metadata before legacy tokenPrice", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_720_000;
  store.attempts.set("attempt-sell-baseline-weighted", makeAttempt({
    id: "attempt-sell-baseline-weighted",
    tokenId: "token-sell-baseline-weighted",
    side: "SELL",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-sell-baseline-weighted", makeContext("attempt-sell-baseline-weighted", {
    tokenPrice: 0.5,
    baseline: {
      version: 1,
      buy: {},
      sell: {
        weighted: 0.62
      },
      perLeader: {}
    },
    leaderTargetShares: {
      "leader-1": 2
    }
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-sell-baseline-weighted",
      bestBid: 0.54,
      bestAsk: 0.55,
      midPrice: 0.545,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-sell-baseline-weighted",
      bids: [{ price: 0.54, size: 100 }],
      asks: [{ price: 0.55, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "THIN_BOOK");
  assert.equal(
    (store.deferred[0]?.context?.leaderBaseline as { source?: string } | undefined)?.source,
    "baseline.v1.sell.weighted"
  );
});

test("Stage 9 multi-leader strictest max-price override wins", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_725_000;
  store.attempts.set("attempt-multi-leader-max-price", makeAttempt({
    id: "attempt-multi-leader-max-price",
    tokenId: "token-multi-leader-max-price",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1.2
  }));
  store.contexts.set("attempt-multi-leader-max-price", {
    ...makeContext("attempt-multi-leader-max-price", {
      tokenPrice: 0.6,
      leaderTargetShares: {
        "leader-1": 1,
        "leader-2": 1
      },
      contributorLeaderIds: ["leader-1", "leader-2"]
    }),
    maxPricePerShareOverride: 0.59,
    contributorLeaderIds: ["leader-1", "leader-2"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        maxPricePerShareUsd: 0.61
      },
      "leader-2": {
        maxPricePerShareUsd: 0.59
      }
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      maxPricePerShare: 0.65
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-multi-leader-max-price",
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
      marketId: "market-multi-leader-max-price",
      bids: [{ price: 0.59, size: 100 }],
      asks: [{ price: 0.6, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.ok(store.deferred[0]?.reason === "PRICE_GUARD" || store.deferred[0]?.reason === "THIN_BOOK");
});

test("Stage 9 per-leader min-notional override can defer attempts", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_740_000;
  store.attempts.set("attempt-leader-min-notional", makeAttempt({
    id: "attempt-leader-min-notional",
    tokenId: "token-leader-min-notional",
    side: "BUY",
    accumulatedDeltaShares: 3,
    accumulatedDeltaNotionalUsd: 1.5
  }));
  store.contexts.set("attempt-leader-min-notional", {
    ...makeContext("attempt-leader-min-notional", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 3
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        minNotionalPerOrderUsd: 2
      }
    },
    guardrailOverrides: {
      minNotionalUsd: 2
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-leader-min-notional",
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
      marketId: "market-leader-min-notional",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 1 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "THIN_BOOK");
});

test("Stage 9 per-leader daily turnover cap blocks BUY but does not block SELL", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_780_000;

  store.attempts.set("attempt-cap-buy", makeAttempt({
    id: "attempt-cap-buy",
    tokenId: "token-cap-buy",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-cap-buy", {
    ...makeContext("attempt-cap-buy", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 2
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        maxDailyNotionalTurnoverUsd: 5
      }
    }
  });
  store.leaderRecentNotionalTurnover.set("copy-profile-1|leader-1", 4.8);

  store.attempts.set("attempt-cap-sell", makeAttempt({
    id: "attempt-cap-sell",
    tokenId: "token-cap-sell",
    side: "SELL",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-cap-sell", {
    ...makeContext("attempt-cap-sell", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 2
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        maxDailyNotionalTurnoverUsd: 5
      }
    }
  });

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "ext-cap-sell" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: `market-${tokenId}`,
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
      marketId: `market-${tokenId}`,
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();

  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
  assert.equal(venue.requests.length, 1);
  assert.equal(store.placed.length, 1);
});

test("Stage 9 per-leader market-outcome and total exposure caps block BUY", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_820_000;
  store.attempts.set("attempt-exposure-caps", makeAttempt({
    id: "attempt-exposure-caps",
    tokenId: "token-exposure-caps",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-exposure-caps", {
    ...makeContext("attempt-exposure-caps", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 2
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        maxExposurePerMarketOutcomeUsd: 5.2,
        maxExposurePerLeaderUsd: 6
      }
    }
  });
  store.leaderLedgerPositions = [
    {
      copyProfileId: "copy-profile-1",
      leaderId: "leader-1",
      tokenId: "token-exposure-caps",
      shares: 10
    },
    {
      copyProfileId: "copy-profile-1",
      leaderId: "leader-1",
      tokenId: "token-other-held",
      shares: 10
    }
  ];

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => {
      if (tokenId === "token-other-held") {
        return {
          tokenId,
          marketId: "market-other-held",
          bestBid: 0.09,
          bestAsk: 0.11,
          midPrice: 0.1,
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          isStale: false,
          priceSource: "WS" as const
        };
      }
      return {
        tokenId,
        marketId: "market-exposure-caps",
        bestBid: 0.49,
        bestAsk: 0.5,
        midPrice: 0.495,
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        isStale: false,
        priceSource: "WS" as const
      };
    },
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-exposure-caps",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "RATE_LIMIT");
});

test("Stage 9 fails closed on BUY cap checks when mark prices are unavailable", async () => {
  const store = new FakeExecutionStore();
  const nowMs = 2_860_000;
  store.attempts.set("attempt-cap-price-missing", makeAttempt({
    id: "attempt-cap-price-missing",
    tokenId: "token-cap-price-missing",
    side: "BUY",
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1
  }));
  store.contexts.set("attempt-cap-price-missing", {
    ...makeContext("attempt-cap-price-missing", {
      tokenPrice: 0.5,
      leaderTargetShares: {
        "leader-1": 2
      }
    }),
    contributorLeaderIds: ["leader-1"],
    contributorSettingsByLeaderId: {
      "leader-1": {
        maxExposurePerLeaderUsd: 100
      }
    }
  });
  store.leaderLedgerPositions = [
    {
      copyProfileId: "copy-profile-1",
      leaderId: "leader-1",
      tokenId: "token-unpriced",
      shares: 5
    }
  ];

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => {
      if (tokenId === "token-unpriced") {
        return {
          tokenId,
          marketId: "market-token-unpriced",
          bestBid: undefined,
          bestAsk: undefined,
          midPrice: undefined,
          tickSize: 0.01,
          minOrderSize: 1,
          negRisk: false,
          isStale: true,
          priceSource: "REST" as const
        };
      }
      return {
        tokenId,
        marketId: "market-cap-price-missing",
        bestBid: 0.49,
        bestAsk: 0.5,
        midPrice: 0.495,
        tickSize: 0.01,
        minOrderSize: 1,
        negRisk: false,
        isStale: false,
        priceSource: "WS" as const
      };
    },
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-cap-price-missing",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  await engine.run();
  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 1);
  assert.equal(store.deferred[0]?.reason, "STALE_PRICE");
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

test("Stage 9 guardrail failures retry until max retries then become terminal failed", async () => {
  const store = new FakeExecutionStore();
  let nowMs = 3_100_000;
  store.attempts.set("attempt-guardrail-retry", makeAttempt({
    id: "attempt-guardrail-retry",
    tokenId: "token-guardrail-retry",
    side: "BUY",
    maxRetries: 2,
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1.4
  }));
  store.contexts.set("attempt-guardrail-retry", makeContext("attempt-guardrail-retry", {
    baseline: {
      version: 1,
      buy: {
        weighted: 0.5
      },
      sell: {},
      perLeader: {}
    },
    tokenPrice: 0.7
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-guardrail-retry",
      bestBid: 0.7,
      bestAsk: 0.71,
      midPrice: 0.705,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-guardrail-retry",
      bids: [{ price: 0.7, size: 100 }],
      asks: [{ price: 0.71, size: 100 }]
    })
  });

  await engine.run();
  nowMs += 5_000;
  await engine.run();
  nowMs += 10_000;
  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 3);
  assert.equal(store.deferred[0]?.terminalStatus, undefined);
  assert.equal(store.deferred[1]?.terminalStatus, undefined);
  assert.equal(store.deferred[2]?.terminalStatus, "FAILED");
});

test("Stage 9 guardrail retries terminate as expired when expiry is reached before retry cap", async () => {
  const store = new FakeExecutionStore();
  let nowMs = 3_200_000;
  store.attempts.set("attempt-guardrail-expiry", makeAttempt({
    id: "attempt-guardrail-expiry",
    tokenId: "token-guardrail-expiry",
    side: "BUY",
    maxRetries: 20,
    expiresAt: new Date(nowMs + 2_000),
    accumulatedDeltaShares: 2,
    accumulatedDeltaNotionalUsd: 1.4
  }));
  store.contexts.set("attempt-guardrail-expiry", makeContext("attempt-guardrail-expiry", {
    baseline: {
      version: 1,
      buy: {
        weighted: 0.5
      },
      sell: {},
      perLeader: {}
    },
    tokenPrice: 0.7
  }));

  const venue = new FakeVenueClient([{ status: "PLACED", externalOrderId: "should-not-place" }]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: {
      ...baseConfig(),
      retryBackoffBaseMs: 1,
      retryBackoffMaxMs: 1
    },
    now: () => nowMs,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-guardrail-expiry",
      bestBid: 0.7,
      bestAsk: 0.71,
      midPrice: 0.705,
      tickSize: 0.01,
      minOrderSize: 1,
      negRisk: false,
      isStale: false,
      priceSource: "WS" as const
    }),
    fetchOrderBook: async (tokenId) => ({
      tokenId,
      marketId: "market-guardrail-expiry",
      bids: [{ price: 0.7, size: 100 }],
      asks: [{ price: 0.71, size: 100 }]
    })
  });

  await engine.run();
  nowMs += 3_000;
  await engine.run();

  assert.equal(venue.requests.length, 0);
  assert.equal(store.deferred.length, 2);
  assert.equal(store.deferred[0]?.terminalStatus, undefined);
  assert.equal(store.deferred[1]?.reason, "EXPIRED");
  assert.equal(store.deferred[1]?.terminalStatus, "EXPIRED");
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

test("Stage 9 runtime setters update execution enable and panic mode", () => {
  const store = new FakeExecutionStore();
  const venue = new FakeVenueClient([]);
  const engine = new ExecutionEngine({
    store,
    venueClient: venue,
    config: baseConfig(),
    now: () => 1_700_000_000_000,
    getMarketSnapshot: async (tokenId) => ({
      tokenId,
      marketId: "market-1",
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
      marketId: "market-1",
      bids: [{ price: 0.49, size: 100 }],
      asks: [{ price: 0.5, size: 100 }]
    })
  });

  engine.setEnabled(false);
  engine.setPanicMode(true);

  const internals = engine as unknown as {
    config: { enabled: boolean; panicMode: boolean };
    status: { enabled: boolean };
  };
  assert.equal(internals.config.enabled, false);
  assert.equal(internals.status.enabled, false);
  assert.equal(internals.config.panicMode, true);
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
  const contributorLeaderIds = resolveContributorLeaderIdsForTest(metadata);
  const contributorSettingsByLeaderId = Object.fromEntries(contributorLeaderIds.map((leaderId) => [leaderId, {}]));
  return {
    attemptId,
    copyProfileStatus: "ACTIVE",
    leaderStatus: "ACTIVE",
    contributorLeaderIds,
    contributorSettingsByLeaderId,
    pendingDeltaId: `pending-${attemptId}`,
    pendingDeltaStatus: "ELIGIBLE",
    pendingDeltaMetadata: metadata
  };
}

function resolveContributorLeaderIdsForTest(metadata: Record<string, unknown>): string[] {
  const raw = metadata.contributorLeaderIds;
  if (Array.isArray(raw)) {
    const parsed = raw
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
    if (parsed.length > 0) {
      return [...new Set(parsed)];
    }
  }

  const leaderTargetShares = metadata.leaderTargetShares;
  if (leaderTargetShares && typeof leaderTargetShares === "object" && !Array.isArray(leaderTargetShares)) {
    const keys = Object.keys(leaderTargetShares);
    if (keys.length > 0) {
      return keys;
    }
  }

  return ["leader-1"];
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
    minBookDepthForSizeEnabled: true,
    maxOpenOrders: 20,
    maxExposurePerLeaderUsd: 1000,
    maxExposurePerMarketOutcomeUsd: 1000,
    maxDailyNotionalTurnoverUsd: 1000,
    maxHourlyNotionalTurnoverUsd: 1000,
    cooldownPerMarketSeconds: 0
  };
}
