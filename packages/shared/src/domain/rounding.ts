import { d, type DecimalLike } from "./math.js";

export function roundDownToTick(value: DecimalLike, tickSize: DecimalLike): number {
  const tick = d(tickSize);
  if (tick.lte(0)) {
    throw new Error("tickSize must be greater than 0");
  }

  return d(value).div(tick).floor().mul(tick).toNumber();
}

export function roundUpToTick(value: DecimalLike, tickSize: DecimalLike): number {
  const tick = d(tickSize);
  if (tick.lte(0)) {
    throw new Error("tickSize must be greater than 0");
  }

  return d(value).div(tick).ceil().mul(tick).toNumber();
}

export function roundShares(value: DecimalLike, decimals = 18): number {
  return d(value).toDecimalPlaces(decimals).toNumber();
}

export function roundUsd(value: DecimalLike, decimals = 8): number {
  return d(value).toDecimalPlaces(decimals).toNumber();
}
