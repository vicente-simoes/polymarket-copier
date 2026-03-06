import { d, decimalMax, decimalMin, safeDiv, type DecimalLike } from "./math.js";
import { roundDownToTick, roundUpToTick } from "./rounding.js";

export type TradeSide = "BUY" | "SELL";

export type GuardrailFailureReason =
  | "MISSING_LEADER_PRICE"
  | "MISSING_MID_PRICE"
  | "SPREAD_TOO_WIDE"
  | "WORSENING_EXCEEDED"
  | "SLIPPAGE_EXCEEDED"
  | "PRICE_CAP_EXCEEDED"
  | "THIN_BOOK";

export interface GuardrailConfig {
  maxWorseningBuyUsd: DecimalLike;
  maxWorseningSellUsd: DecimalLike;
  maxSlippageBps: DecimalLike;
  maxSpreadUsd: DecimalLike;
  maxPricePerShare?: DecimalLike;
}

export interface PriceInputs {
  leaderPrice?: DecimalLike;
  midPrice?: DecimalLike;
  bestBid?: DecimalLike;
  bestAsk?: DecimalLike;
  tickSize: DecimalLike;
  expectedPrice?: DecimalLike;
  depthSufficient?: boolean;
}

export interface GuardrailEvaluation {
  ok: boolean;
  reasons: GuardrailFailureReason[];
}

export function computeBuyPriceCap(params: {
  leaderPrice: DecimalLike;
  midPrice: DecimalLike;
  maxWorseningBuyUsd: DecimalLike;
  maxSlippageBps: DecimalLike;
  tickSize: DecimalLike;
  maxPricePerShare?: DecimalLike;
}): number {
  const worseningCap = d(params.leaderPrice).plus(d(params.maxWorseningBuyUsd));
  const slippageCap = d(params.midPrice).mul(d(1).plus(d(params.maxSlippageBps).div(10_000)));
  const candidates = [worseningCap, slippageCap];

  if (params.maxPricePerShare !== undefined) {
    candidates.push(d(params.maxPricePerShare));
  }

  return roundDownToTick(decimalMin(...candidates), params.tickSize);
}

export function computeSellPriceFloor(params: {
  leaderPrice: DecimalLike;
  midPrice: DecimalLike;
  maxWorseningSellUsd: DecimalLike;
  maxSlippageBps: DecimalLike;
  tickSize: DecimalLike;
}): number {
  const worseningFloor = d(params.leaderPrice).minus(d(params.maxWorseningSellUsd));
  const slippageFloor = d(params.midPrice).mul(d(1).minus(d(params.maxSlippageBps).div(10_000)));

  return roundUpToTick(decimalMax(worseningFloor, slippageFloor), params.tickSize);
}

export function directionalSlippageBps(params: {
  side: TradeSide;
  expectedPrice: DecimalLike;
  midPrice: DecimalLike;
}): number {
  const expected = d(params.expectedPrice);
  const mid = d(params.midPrice);

  if (params.side === "BUY") {
    return safeDiv(expected.minus(mid), mid, 0).mul(10_000).toNumber();
  }

  return safeDiv(mid.minus(expected), mid, 0).mul(10_000).toNumber();
}

export function evaluateGuardrails(params: {
  side: TradeSide;
  config: GuardrailConfig;
  prices: PriceInputs;
}): GuardrailEvaluation {
  const reasons: GuardrailFailureReason[] = [];
  const { config, prices, side } = params;

  if (prices.leaderPrice === undefined) {
    reasons.push("MISSING_LEADER_PRICE");
  }

  if (prices.midPrice === undefined) {
    reasons.push("MISSING_MID_PRICE");
  }

  if (prices.bestBid !== undefined && prices.bestAsk !== undefined) {
    const spread = d(prices.bestAsk).minus(d(prices.bestBid));
    if (spread.greaterThan(d(config.maxSpreadUsd))) {
      reasons.push("SPREAD_TOO_WIDE");
    }
  }

  if (prices.leaderPrice !== undefined) {
    if (side === "BUY" && prices.bestAsk !== undefined) {
      const worsening = d(prices.bestAsk).minus(d(prices.leaderPrice));
      if (worsening.greaterThan(d(config.maxWorseningBuyUsd))) {
        reasons.push("WORSENING_EXCEEDED");
      }

      if (
        config.maxPricePerShare !== undefined &&
        d(prices.bestAsk).greaterThan(d(config.maxPricePerShare))
      ) {
        reasons.push("PRICE_CAP_EXCEEDED");
      }
    }

    if (side === "SELL" && prices.bestBid !== undefined) {
      const worsening = d(prices.leaderPrice).minus(d(prices.bestBid));
      if (worsening.greaterThan(d(config.maxWorseningSellUsd))) {
        reasons.push("WORSENING_EXCEEDED");
      }
    }
  }

  if (prices.expectedPrice !== undefined && prices.leaderPrice !== undefined) {
    if (side === "BUY") {
      const worsening = d(prices.expectedPrice).minus(d(prices.leaderPrice));
      if (worsening.greaterThan(d(config.maxWorseningBuyUsd))) {
        reasons.push("WORSENING_EXCEEDED");
      }

      if (
        config.maxPricePerShare !== undefined &&
        d(prices.expectedPrice).greaterThan(d(config.maxPricePerShare))
      ) {
        reasons.push("PRICE_CAP_EXCEEDED");
      }
    } else {
      const worsening = d(prices.leaderPrice).minus(d(prices.expectedPrice));
      if (worsening.greaterThan(d(config.maxWorseningSellUsd))) {
        reasons.push("WORSENING_EXCEEDED");
      }
    }
  }

  if (prices.expectedPrice !== undefined && prices.midPrice !== undefined) {
    const slippageBps = directionalSlippageBps({
      side,
      expectedPrice: prices.expectedPrice,
      midPrice: prices.midPrice
    });

    if (d(slippageBps).greaterThan(d(config.maxSlippageBps))) {
      reasons.push("SLIPPAGE_EXCEEDED");
    }
  }

  if (prices.depthSufficient === false) {
    reasons.push("THIN_BOOK");
  }

  const dedupedReasons = [...new Set(reasons)];

  return {
    ok: dedupedReasons.length === 0,
    reasons: dedupedReasons
  };
}
