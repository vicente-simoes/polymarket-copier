import {
  computeBuyPriceCap,
  computeSellPriceFloor,
  evaluateGuardrails,
  type GuardrailFailureReason,
  type TradeSide
} from "./guardrails.js";
import { sizeFAKOrder } from "./order.js";

export interface ExecutionBookLevel {
  price: number;
  size: number;
}

export interface LiveExecutionDiagnosticsInput {
  side: TradeSide;
  deltaShares: number;
  minNotionalUsd: number;
  leaderPrice?: number;
  midPrice?: number;
  bestBid?: number;
  bestAsk?: number;
  tickSize: number;
  maxWorseningBuyUsd: number;
  maxWorseningSellUsd: number;
  buyImprovementGuardEnabled?: boolean;
  maxBuyImprovementBps?: number;
  maxSlippageBps: number;
  maxSpreadUsd: number;
  maxPricePerShare?: number;
  bids: ExecutionBookLevel[];
  asks: ExecutionBookLevel[];
}

export interface LiveExecutionDiagnostics {
  amountKind: "USD" | "SHARES";
  intendedAmount: number;
  intendedShares: number;
  intendedNotionalUsd: number;
  leaderPriceUsd: number;
  midPriceUsd: number;
  priceLimitUsd: number;
  priceLimitKind: "CAP" | "FLOOR";
  usableDepthShares: number;
  usableDepthNotionalUsd: number;
  remainingShares: number;
  remainingNotionalUsd: number;
  depthSufficient: boolean;
  expectedPriceUsd: number | null;
  guardrailReasons: GuardrailFailureReason[];
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function isFiniteLevel(level: ExecutionBookLevel): boolean {
  return Number.isFinite(level.price) && Number.isFinite(level.size) && level.price > 0 && level.size > 0;
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

export function computeLiveExecutionDiagnostics(
  input: LiveExecutionDiagnosticsInput
): LiveExecutionDiagnostics | null {
  if (!input.leaderPrice || input.leaderPrice <= 0) {
    return null;
  }

  if (!input.midPrice || input.midPrice <= 0) {
    return null;
  }

  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    return null;
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
    minOrderSizeShares: 0,
    minNotionalUsd: input.minNotionalUsd
  });

  if (!sizing.executable) {
    return null;
  }

  const amountKind = sizing.amountKind;
  const amount = sizing.amount;

  if (input.side === "BUY") {
    const levels = sortAsks(input.asks);
    let remainingUsd = amount;
    let consumedShares = 0;
    let consumedUsd = 0;
    let usableDepthShares = 0;
    let usableDepthNotionalUsd = 0;

    for (const level of levels) {
      if (level.price > priceLimit) {
        break;
      }

      const maxUsdAtLevel = level.price * level.size;
      usableDepthShares += level.size;
      usableDepthNotionalUsd += maxUsdAtLevel;

      const takeUsd = Math.min(remainingUsd, maxUsdAtLevel);
      const takeShares = takeUsd / level.price;
      consumedUsd += takeUsd;
      consumedShares += takeShares;
      remainingUsd -= takeUsd;

      if (remainingUsd <= 1e-9) {
        break;
      }
    }

    const remainingShares = remainingUsd > 1e-9 && priceLimit > 0 ? remainingUsd / priceLimit : 0;
    const expectedPriceUsd = consumedShares > 0 ? consumedUsd / consumedShares : null;
    const guardrail = evaluateGuardrails({
      side: input.side,
      config: {
        maxWorseningBuyUsd: input.maxWorseningBuyUsd,
        maxWorseningSellUsd: input.maxWorseningSellUsd,
        buyImprovementGuardEnabled: input.buyImprovementGuardEnabled,
        maxBuyImprovementBps: input.maxBuyImprovementBps,
        maxSlippageBps: input.maxSlippageBps,
        maxSpreadUsd: input.maxSpreadUsd,
        maxPricePerShare: input.maxPricePerShare
      },
      prices: {
        leaderPrice: input.leaderPrice,
        midPrice: input.midPrice,
        bestBid: input.bestBid,
        bestAsk: input.bestAsk,
        expectedPrice: expectedPriceUsd ?? undefined,
        tickSize: input.tickSize,
        depthSufficient: remainingUsd <= 1e-9
      }
    });

    return {
      amountKind,
      intendedAmount: roundTo(amount, 8),
      intendedShares: roundTo(consumedShares + remainingShares, 8),
      intendedNotionalUsd: roundTo(amount, 8),
      leaderPriceUsd: roundTo(input.leaderPrice, 8),
      midPriceUsd: roundTo(input.midPrice, 8),
      priceLimitUsd: roundTo(priceLimit, 8),
      priceLimitKind: "CAP",
      usableDepthShares: roundTo(usableDepthShares, 8),
      usableDepthNotionalUsd: roundTo(usableDepthNotionalUsd, 8),
      remainingShares: roundTo(Math.max(0, remainingShares), 8),
      remainingNotionalUsd: roundTo(Math.max(0, remainingUsd), 8),
      depthSufficient: remainingUsd <= 1e-9,
      expectedPriceUsd: expectedPriceUsd !== null ? roundTo(expectedPriceUsd, 8) : null,
      guardrailReasons: guardrail.reasons
    };
  }

  const levels = sortBids(input.bids);
  let remainingShares = amount;
  let soldShares = 0;
  let soldUsd = 0;
  let usableDepthShares = 0;
  let usableDepthNotionalUsd = 0;

  for (const level of levels) {
    if (level.price < priceLimit) {
      break;
    }

    usableDepthShares += level.size;
    usableDepthNotionalUsd += level.size * level.price;

    const takeShares = Math.min(remainingShares, level.size);
    soldShares += takeShares;
    soldUsd += takeShares * level.price;
    remainingShares -= takeShares;

    if (remainingShares <= 1e-9) {
      break;
    }
  }

  const remainingNotionalUsd = remainingShares > 1e-9 ? remainingShares * priceLimit : 0;
  const expectedPriceUsd = soldShares > 0 ? soldUsd / soldShares : null;
  const guardrail = evaluateGuardrails({
    side: input.side,
    config: {
      maxWorseningBuyUsd: input.maxWorseningBuyUsd,
      maxWorseningSellUsd: input.maxWorseningSellUsd,
      buyImprovementGuardEnabled: input.buyImprovementGuardEnabled,
      maxBuyImprovementBps: input.maxBuyImprovementBps,
      maxSlippageBps: input.maxSlippageBps,
      maxSpreadUsd: input.maxSpreadUsd,
      maxPricePerShare: input.maxPricePerShare
    },
    prices: {
      leaderPrice: input.leaderPrice,
      midPrice: input.midPrice,
      bestBid: input.bestBid,
      bestAsk: input.bestAsk,
      expectedPrice: expectedPriceUsd ?? undefined,
      tickSize: input.tickSize,
      depthSufficient: remainingShares <= 1e-9
    }
  });

  return {
    amountKind,
    intendedAmount: roundTo(amount, 8),
    intendedShares: roundTo(amount, 8),
    intendedNotionalUsd: roundTo(soldUsd + remainingNotionalUsd, 8),
    leaderPriceUsd: roundTo(input.leaderPrice, 8),
    midPriceUsd: roundTo(input.midPrice, 8),
    priceLimitUsd: roundTo(priceLimit, 8),
    priceLimitKind: "FLOOR",
    usableDepthShares: roundTo(usableDepthShares, 8),
    usableDepthNotionalUsd: roundTo(usableDepthNotionalUsd, 8),
    remainingShares: roundTo(Math.max(0, remainingShares), 8),
    remainingNotionalUsd: roundTo(Math.max(0, remainingNotionalUsd), 8),
    depthSufficient: remainingShares <= 1e-9,
    expectedPriceUsd: expectedPriceUsd !== null ? roundTo(expectedPriceUsd, 8) : null,
    guardrailReasons: guardrail.reasons
  };
}
