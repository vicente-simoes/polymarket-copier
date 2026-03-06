import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateFillByWeights,
  applyBuyAllocation,
  applySellAllocation,
  ClobBookSummarySchema,
  copyDecisionKey,
  computeAttributionWeights,
  computeBuyPriceCap,
  computeLiveExecutionDiagnostics,
  computeSellPriceFloor,
  directionalSlippageBps,
  evaluateGuardrails,
  makeIdempotencyKey,
  parseAlchemyLogNotification,
  parseDataApiPosition,
  parseDataApiTrade,
  roundDownToTick,
  roundUpToTick,
  sizeFAKOrder,
  triggerId,
  unrealizedPnlUsd,
  UNATTRIBUTED_BUCKET
} from "../src/index.js";

test("Step 4 tick rounding: BUY rounds down, SELL rounds up", () => {
  assert.equal(roundDownToTick(0.5916, 0.01), 0.59);
  assert.equal(roundUpToTick(0.5684, 0.01), 0.57);
});

test("Step 4 BUY cap uses min(candidate caps) then rounds down", () => {
  const cap = computeBuyPriceCap({
    leaderPrice: 0.57,
    midPrice: 0.58,
    maxWorseningBuyUsd: 0.03,
    maxSlippageBps: 200,
    maxPricePerShare: 0.59,
    tickSize: 0.01
  });

  assert.equal(cap, 0.59);
});

test("Step 4 SELL floor uses max(candidate floors) then rounds up", () => {
  const floor = computeSellPriceFloor({
    leaderPrice: 0.57,
    midPrice: 0.58,
    maxWorseningSellUsd: 0.06,
    maxSlippageBps: 200,
    tickSize: 0.01
  });

  assert.equal(floor, 0.57);
});

test("Step 5 BUY FAK sizing uses dollars and applies min share + min notional", () => {
  const result = sizeFAKOrder({
    side: "BUY",
    deltaShares: 2,
    midPrice: 0.58,
    priceLimit: 0.59,
    minOrderSizeShares: 2,
    minNotionalUsd: 1
  });

  assert.equal(result.executable, true);
  assert.equal(result.amountKind, "USD");
  assert.equal(result.amount, 1.18);
});

test("Step 1 delta below min_order_size is accumulated and not executable", () => {
  const result = sizeFAKOrder({
    side: "BUY",
    deltaShares: 0.5,
    midPrice: 0.58,
    priceLimit: 0.59,
    minOrderSizeShares: 1,
    minNotionalUsd: 1
  });

  assert.equal(result.executable, false);
  assert.equal(result.reason, "BELOW_MIN_ORDER_SIZE");
});

test("Step 5 SELL FAK sizing uses shares and enforces min_order_size", () => {
  const tooSmall = sizeFAKOrder({
    side: "SELL",
    deltaShares: -0.5,
    midPrice: 0.58,
    priceLimit: 0.57,
    minOrderSizeShares: 1,
    minNotionalUsd: 1
  });

  assert.equal(tooSmall.executable, false);
  assert.equal(tooSmall.reason, "BELOW_MIN_ORDER_SIZE");

  const valid = sizeFAKOrder({
    side: "SELL",
    deltaShares: -1.8,
    midPrice: 0.58,
    priceLimit: 0.57,
    minOrderSizeShares: 1,
    minNotionalUsd: 1
  });

  assert.equal(valid.executable, true);
  assert.equal(valid.amountKind, "SHARES");
  assert.equal(valid.amount, 1.8);
});

test("Step 4/6 guardrails block on spread, slippage, worsening, and thin book", () => {
  const evaluation = evaluateGuardrails({
    side: "BUY",
    config: {
      maxWorseningBuyUsd: 0.03,
      maxWorseningSellUsd: 0.06,
      maxSlippageBps: 200,
      maxSpreadUsd: 0.03,
      maxPricePerShare: 0.59
    },
    prices: {
      leaderPrice: 0.57,
      midPrice: 0.58,
      bestBid: 0.50,
      bestAsk: 0.57,
      expectedPrice: 0.62,
      tickSize: 0.01,
      depthSufficient: false
    }
  });

  assert.equal(evaluation.ok, false);
  assert.deepEqual(
    evaluation.reasons.sort(),
    ["SPREAD_TOO_WIDE", "WORSENING_EXCEEDED", "SLIPPAGE_EXCEEDED", "PRICE_CAP_EXCEEDED", "THIN_BOOK"].sort()
  );
});

test("Live execution diagnostics compute BUY and SELL depth within cap/floor", () => {
  const buy = computeLiveExecutionDiagnostics({
    side: "BUY",
    deltaShares: 2,
    minNotionalUsd: 1,
    leaderPrice: 0.57,
    midPrice: 0.58,
    bestBid: 0.57,
    bestAsk: 0.59,
    tickSize: 0.01,
    maxWorseningBuyUsd: 0.04,
    maxWorseningSellUsd: 0.06,
    maxSlippageBps: 400,
    maxSpreadUsd: 0.03,
    maxPricePerShare: 0.61,
    bids: [{ price: 0.57, size: 10 }],
    asks: [
      { price: 0.59, size: 1 },
      { price: 0.6, size: 1 },
      { price: 0.62, size: 10 }
    ]
  });

  assert.ok(buy);
  assert.equal(buy?.priceLimitKind, "CAP");
  assert.equal(buy?.depthSufficient, true);
  assert.equal(buy?.usableDepthShares, 2);
  assert.equal(buy?.remainingNotionalUsd, 0);
  assert.equal(buy?.expectedPriceUsd, 0.59487179);

  const sell = computeLiveExecutionDiagnostics({
    side: "SELL",
    deltaShares: 3,
    minNotionalUsd: 1,
    leaderPrice: 0.57,
    midPrice: 0.58,
    bestBid: 0.57,
    bestAsk: 0.59,
    tickSize: 0.01,
    maxWorseningBuyUsd: 0.03,
    maxWorseningSellUsd: 0.03,
    maxSlippageBps: 400,
    maxSpreadUsd: 0.03,
    bids: [
      { price: 0.57, size: 1 },
      { price: 0.56, size: 1 },
      { price: 0.54, size: 10 }
    ],
    asks: [{ price: 0.59, size: 10 }]
  });

  assert.ok(sell);
  assert.equal(sell?.priceLimitKind, "FLOOR");
  assert.equal(sell?.depthSufficient, false);
  assert.equal(sell?.usableDepthShares, 2);
  assert.equal(sell?.remainingShares, 1);
  assert.equal(sell?.remainingNotionalUsd, 0.56);
});

test("Live execution diagnostics return null when leader or mid price is missing", () => {
  assert.equal(
    computeLiveExecutionDiagnostics({
      side: "BUY",
      deltaShares: 2,
      minNotionalUsd: 1,
      leaderPrice: undefined,
      midPrice: 0.58,
      bestBid: 0.57,
      bestAsk: 0.59,
      tickSize: 0.01,
      maxWorseningBuyUsd: 0.03,
      maxWorseningSellUsd: 0.06,
      maxSlippageBps: 200,
      maxSpreadUsd: 0.03,
      bids: [{ price: 0.57, size: 10 }],
      asks: [{ price: 0.59, size: 10 }]
    }),
    null
  );
});

test("Directional slippage bps is side-aware", () => {
  assert.equal(directionalSlippageBps({ side: "BUY", expectedPrice: 0.59, midPrice: 0.58 }), 172.41379310344828);
  assert.equal(directionalSlippageBps({ side: "SELL", expectedPrice: 0.57, midPrice: 0.58 }), 172.41379310344828);
});

test("Step 1.5 attribution weights for BUY and SELL", () => {
  const buyWeights = computeAttributionWeights({
    targetSharesByLeader: { a: 10, b: 5 },
    ledgerSharesByLeader: { a: 7, b: 5 },
    netDeltaShares: 3
  });

  assert.equal(buyWeights.weights.a, 1);
  assert.equal(buyWeights.weights.b ?? 0, 0);

  const sellWeights = computeAttributionWeights({
    targetSharesByLeader: { a: 5, b: 3 },
    ledgerSharesByLeader: { a: 7, b: 4 },
    netDeltaShares: -3
  });

  assert.equal(Number((sellWeights.weights.a ?? 0).toFixed(4)), 0.6667);
  assert.equal(Number((sellWeights.weights.b ?? 0).toFixed(4)), 0.3333);
});

test("Fill allocation emits unattributed residual when rounding leaves remainder", () => {
  const allocations = allocateFillByWeights({
    filledShares: 1,
    filledUsdc: 1,
    feeUsdc: 0.03,
    weights: {
      a: 0.3333,
      b: 0.3333
    },
    precisionShares: 4,
    precisionUsd: 4
  });

  const unattributed = allocations.find((entry) => entry.leaderId === UNATTRIBUTED_BUCKET);
  assert.ok(unattributed);
  assert.notEqual(unattributed?.shares, 0);
});

test("PnL ledger updates follow average-cost method", () => {
  const afterBuy = applyBuyAllocation(
    {
      shares: 10,
      costUsd: 5,
      realizedPnlUsd: 0
    },
    {
      shares: 2,
      usdc: 1.2,
      feeUsdc: 0.01
    }
  );

  assert.equal(afterBuy.shares, 12);
  assert.equal(afterBuy.costUsd, 6.21);

  const afterSell = applySellAllocation(
    {
      shares: 10,
      costUsd: 5,
      realizedPnlUsd: 0
    },
    {
      shares: 2,
      usdc: 1.4,
      feeUsdc: 0.01
    }
  );

  assert.equal(afterSell.shares, 8);
  assert.equal(afterSell.costUsd, 4);
  assert.equal(afterSell.realizedPnlUsd, 0.39);

  assert.equal(unrealizedPnlUsd(afterSell, 0.55), 0.4);
});

test("Idempotency keys are deterministic and order-insensitive for objects", () => {
  const one = makeIdempotencyKey("rebalance", {
    b: 2,
    a: [1, 3]
  });

  const two = makeIdempotencyKey("rebalance", {
    a: [1, 3],
    b: 2
  });

  assert.equal(one, two);
  assert.equal(triggerId("0xABCDEF", 4), "0xabcdef:4");

  const decisionOne = copyDecisionKey({ token: "abc", side: "BUY", delta: "2.0" });
  const decisionTwo = copyDecisionKey({ side: "BUY", delta: "2.0", token: "abc" });
  assert.equal(decisionOne, decisionTwo);
});

test("External schemas parse canonical payload shapes", () => {
  const alchemy = parseAlchemyLogNotification({
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsub",
      result: {
        address: "0xabc",
        blockHash: "0xhash",
        blockNumber: "0x1",
        data: "0x",
        logIndex: "0x0",
        topics: ["0xtopic"],
        transactionHash: "0xtx",
        transactionIndex: "0x0",
        removed: false
      }
    }
  });
  assert.equal(alchemy.params.result.removed, false);

  const trade = parseDataApiTrade({
    proxyWallet: "0xwallet",
    side: "BUY",
    asset: "token",
    conditionId: "cond",
    size: "10",
    price: "0.57",
    timestamp: "1672290701"
  });
  assert.equal(trade.size, 10);

  const position = parseDataApiPosition({
    proxyWallet: "0xwallet",
    asset: "token",
    conditionId: "cond",
    size: "5",
    curPrice: "0.61"
  });
  assert.equal(position.curPrice, 0.61);

  const book = ClobBookSummarySchema.parse({
    market: "0xmarket",
    asset_id: "token",
    timestamp: "2023-10-01T12:00:00Z",
    bids: [{ price: "0.57", size: "10" }],
    asks: [{ price: "0.58", size: "8" }],
    min_order_size: "1",
    tick_size: "0.01",
    neg_risk: false
  });
  assert.equal(book.tick_size, 0.01);
});
