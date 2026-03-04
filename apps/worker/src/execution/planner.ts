import {
  computeBuyPriceCap,
  computeSellPriceFloor,
  evaluateGuardrails,
  sizeFAKOrder,
  type GuardrailFailureReason
} from "@copybot/shared";
import type {
  ExecutionBookLevel,
  ExecutionOrderAmountKind,
  ExecutionOrderBookSnapshot,
  ExecutionSide,
  ExecutionSkipReason
} from "./types.js";

export interface PlannedExecutionInput {
  side: ExecutionSide;
  deltaShares: number;
  minOrderSize: number;
  minNotionalUsd: number;
  leaderPrice?: number;
  midPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  tickSize: number;
  maxWorseningBuyUsd: number;
  maxWorseningSellUsd: number;
  maxSlippageBps: number;
  maxSpreadUsd: number;
  maxPricePerShare?: number;
  enforceMinBookDepth: boolean;
  book: ExecutionOrderBookSnapshot;
}

export interface PlannedExecution {
  executable: boolean;
  side: ExecutionSide;
  amountKind: ExecutionOrderAmountKind;
  amount: number;
  priceLimit: number;
  estimatedShares: number;
  estimatedNotionalUsd: number;
  expectedPrice?: number;
  guardrailReasons: GuardrailFailureReason[];
  blockReason?: ExecutionSkipReason;
  blockMessage?: string;
}

interface BookFillEstimate {
  expectedPrice?: number;
  estimatedShares: number;
  estimatedNotionalUsd: number;
  depthSufficient: boolean;
}

export function planExecution(input: PlannedExecutionInput): PlannedExecution {
  if (!input.leaderPrice || input.leaderPrice <= 0) {
    return blocked(input.side, "PRICE_GUARD", "leader price unavailable");
  }

  if (!input.midPrice || input.midPrice <= 0) {
    return blocked(input.side, "STALE_PRICE", "mid price unavailable");
  }

  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    return blocked(input.side, "BOOK_UNAVAILABLE", "tick size unavailable");
  }

  const priceLimit =
    input.side === "BUY"
      ? computeBuyPriceCap({
          leaderPrice: input.leaderPrice,
          midPrice: input.midPrice,
          maxWorseningBuyUsd: input.maxWorseningBuyUsd,
          maxSlippageBps: input.maxSlippageBps,
          tickSize: input.tickSize,
          maxPricePerShare: input.maxPricePerShare
        })
      : computeSellPriceFloor({
          leaderPrice: input.leaderPrice,
          midPrice: input.midPrice,
          maxWorseningSellUsd: input.maxWorseningSellUsd,
          maxSlippageBps: input.maxSlippageBps,
          tickSize: input.tickSize
        });

  const signedDelta = input.side === "BUY" ? Math.abs(input.deltaShares) : -Math.abs(input.deltaShares);
  const sizing = sizeFAKOrder({
    side: input.side,
    deltaShares: signedDelta,
    midPrice: input.midPrice,
    priceLimit,
    // FAK sizing is not gated by venue min-order-size; enforce notional instead.
    minOrderSizeShares: 0,
    minNotionalUsd: input.minNotionalUsd
  });

  if (!sizing.executable) {
    return blocked(
      input.side,
      mapSizingReason(sizing.reason),
      `order sizing blocked: ${sizing.reason ?? "UNKNOWN"}`
    );
  }

  const fillEstimate = estimateBookFill({
    side: input.side,
    amountKind: sizing.amountKind,
    amount: sizing.amount,
    priceLimit,
    asks: input.book.asks,
    bids: input.book.bids
  });

  const guardrail = evaluateGuardrails({
    side: input.side,
    config: {
      maxWorseningBuyUsd: input.maxWorseningBuyUsd,
      maxWorseningSellUsd: input.maxWorseningSellUsd,
      maxSlippageBps: input.maxSlippageBps,
      maxSpreadUsd: input.maxSpreadUsd,
      maxPricePerShare: input.maxPricePerShare
    },
    prices: {
      leaderPrice: input.leaderPrice,
      midPrice: input.midPrice,
      bestBid: input.bestBid,
      bestAsk: input.bestAsk,
      expectedPrice: fillEstimate.expectedPrice,
      tickSize: input.tickSize,
      depthSufficient: input.enforceMinBookDepth ? fillEstimate.depthSufficient : undefined
    }
  });

  if (!guardrail.ok) {
    return {
      executable: false,
      side: input.side,
      amountKind: sizing.amountKind,
      amount: sizing.amount,
      priceLimit,
      estimatedShares: fillEstimate.estimatedShares,
      estimatedNotionalUsd: fillEstimate.estimatedNotionalUsd,
      expectedPrice: fillEstimate.expectedPrice,
      guardrailReasons: guardrail.reasons,
      blockReason: mapGuardrailReason(guardrail.reasons[0]),
      blockMessage: `guardrail blocked: ${guardrail.reasons.join(",")}`
    };
  }

  return {
    executable: true,
    side: input.side,
    amountKind: sizing.amountKind,
    amount: roundTo(sizing.amount, 8),
    priceLimit: roundTo(priceLimit, 8),
    estimatedShares: roundTo(fillEstimate.estimatedShares, 8),
    estimatedNotionalUsd: roundTo(fillEstimate.estimatedNotionalUsd, 8),
    expectedPrice: fillEstimate.expectedPrice !== undefined ? roundTo(fillEstimate.expectedPrice, 8) : undefined,
    guardrailReasons: []
  };
}

function estimateBookFill(args: {
  side: ExecutionSide;
  amountKind: ExecutionOrderAmountKind;
  amount: number;
  priceLimit: number;
  bids: ExecutionBookLevel[];
  asks: ExecutionBookLevel[];
}): BookFillEstimate {
  if (args.amount <= 0) {
    return {
      expectedPrice: undefined,
      estimatedShares: 0,
      estimatedNotionalUsd: 0,
      depthSufficient: false
    };
  }

  if (args.side === "BUY") {
    const levels = sortAsks(args.asks);
    let remainingUsd = args.amount;
    let consumedShares = 0;
    let consumedUsd = 0;

    for (const level of levels) {
      if (level.price > args.priceLimit) {
        break;
      }

      const maxUsdAtLevel = level.price * level.size;
      const takeUsd = Math.min(remainingUsd, maxUsdAtLevel);
      const takeShares = takeUsd / level.price;
      consumedUsd += takeUsd;
      consumedShares += takeShares;
      remainingUsd -= takeUsd;

      if (remainingUsd <= 1e-9) {
        break;
      }
    }

    return {
      expectedPrice: consumedShares > 0 ? consumedUsd / consumedShares : undefined,
      estimatedShares: consumedShares,
      estimatedNotionalUsd: consumedUsd,
      depthSufficient: remainingUsd <= 1e-9
    };
  }

  const levels = sortBids(args.bids);
  let remainingShares = args.amount;
  let soldShares = 0;
  let soldUsd = 0;

  for (const level of levels) {
    if (level.price < args.priceLimit) {
      break;
    }

    const takeShares = Math.min(remainingShares, level.size);
    soldShares += takeShares;
    soldUsd += takeShares * level.price;
    remainingShares -= takeShares;

    if (remainingShares <= 1e-9) {
      break;
    }
  }

  return {
    expectedPrice: soldShares > 0 ? soldUsd / soldShares : undefined,
    estimatedShares: soldShares,
    estimatedNotionalUsd: soldUsd,
    depthSufficient: remainingShares <= 1e-9
  };
}

function blocked(side: ExecutionSide, reason: ExecutionSkipReason, blockMessage: string): PlannedExecution {
  return {
    executable: false,
    side,
    amountKind: side === "BUY" ? "USD" : "SHARES",
    amount: 0,
    priceLimit: 0,
    estimatedShares: 0,
    estimatedNotionalUsd: 0,
    guardrailReasons: [],
    blockReason: reason,
    blockMessage
  };
}

function mapSizingReason(reason: "BELOW_MIN_ORDER_SIZE" | "INSUFFICIENT_BALANCE" | "NON_POSITIVE_DELTA" | undefined): ExecutionSkipReason {
  if (reason === "BELOW_MIN_ORDER_SIZE") {
    return "MIN_ORDER_SIZE";
  }

  if (reason === "INSUFFICIENT_BALANCE") {
    return "RATE_LIMIT";
  }

  return "UNKNOWN";
}

function mapGuardrailReason(reason: GuardrailFailureReason | undefined): ExecutionSkipReason {
  if (!reason) {
    return "UNKNOWN";
  }

  if (reason === "SPREAD_TOO_WIDE") {
    return "SPREAD";
  }

  if (reason === "SLIPPAGE_EXCEEDED") {
    return "SLIPPAGE";
  }

  if (reason === "WORSENING_EXCEEDED" || reason === "PRICE_CAP_EXCEEDED") {
    return "PRICE_GUARD";
  }

  if (reason === "THIN_BOOK") {
    return "THIN_BOOK";
  }

  if (reason === "MISSING_MID_PRICE") {
    return "STALE_PRICE";
  }

  if (reason === "MISSING_LEADER_PRICE") {
    return "PRICE_GUARD";
  }

  return "UNKNOWN";
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sortBids(levels: ExecutionBookLevel[]): ExecutionBookLevel[] {
  return levels
    .filter(isFiniteLevel)
    .sort((left, right) => right.price - left.price);
}

function sortAsks(levels: ExecutionBookLevel[]): ExecutionBookLevel[] {
  return levels
    .filter(isFiniteLevel)
    .sort((left, right) => left.price - right.price);
}

function isFiniteLevel(level: ExecutionBookLevel): boolean {
  return Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0;
}
