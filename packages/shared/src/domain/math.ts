import { Decimal } from "decimal.js";

Decimal.set({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -30,
  toExpPos: 30
});

export type DecimalLike = Decimal.Value;

export function d(value: DecimalLike): Decimal {
  return new Decimal(value);
}

export function clamp(value: DecimalLike, min: DecimalLike, max: DecimalLike): Decimal {
  const parsed = d(value);
  const minParsed = d(min);
  const maxParsed = d(max);

  if (parsed.lessThan(minParsed)) {
    return minParsed;
  }

  if (parsed.greaterThan(maxParsed)) {
    return maxParsed;
  }

  return parsed;
}

export function safeDiv(numerator: DecimalLike, denominator: DecimalLike, fallback: DecimalLike = 0): Decimal {
  const parsedDenominator = d(denominator);
  if (parsedDenominator.isZero()) {
    return d(fallback);
  }

  return d(numerator).div(parsedDenominator);
}

export function decimalMax(...values: DecimalLike[]): Decimal {
  if (values.length === 0) {
    throw new Error("decimalMax requires at least one value");
  }

  return values.map(d).reduce((acc, current) => (current.greaterThan(acc) ? current : acc));
}

export function decimalMin(...values: DecimalLike[]): Decimal {
  if (values.length === 0) {
    throw new Error("decimalMin requires at least one value");
  }

  return values.map(d).reduce((acc, current) => (current.lessThan(acc) ? current : acc));
}

export function sum(values: DecimalLike[]): Decimal {
  let total = d(0);
  for (const value of values) {
    total = total.plus(d(value));
  }

  return total;
}

export function toFixed(value: DecimalLike, decimalPlaces: number): string {
  return d(value).toDecimalPlaces(decimalPlaces).toFixed(decimalPlaces);
}

export function isFiniteDecimal(value: DecimalLike): boolean {
  return d(value).isFinite();
}

export const DECIMAL_ZERO = d(0);
