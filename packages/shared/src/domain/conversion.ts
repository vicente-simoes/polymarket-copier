import { d, safeDiv, type DecimalLike } from "./math.js";

export function targetNotionalUsd(leaderCurrentValueUsd: DecimalLike, ratio: DecimalLike): number {
  return d(leaderCurrentValueUsd).mul(d(ratio)).toNumber();
}

export function sharesFromNotional(notionalUsd: DecimalLike, pricePerShare: DecimalLike): number {
  return safeDiv(notionalUsd, pricePerShare, 0).toNumber();
}

export function notionalFromShares(shares: DecimalLike, pricePerShare: DecimalLike): number {
  return d(shares).mul(d(pricePerShare)).toNumber();
}

export function deltaShares(targetShares: DecimalLike, followerShares: DecimalLike): number {
  return d(targetShares).minus(d(followerShares)).toNumber();
}

export function midPrice(bestBid: DecimalLike, bestAsk: DecimalLike): number {
  return d(bestBid).plus(d(bestAsk)).div(2).toNumber();
}
