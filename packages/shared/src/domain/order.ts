import { d, decimalMax, type DecimalLike } from "./math.js";

export type ExecutionSide = "BUY" | "SELL";

export interface FAKOrderSizingInput {
  side: ExecutionSide;
  deltaShares: DecimalLike;
  midPrice: DecimalLike;
  priceLimit: DecimalLike;
  minOrderSizeShares: DecimalLike;
  minNotionalUsd: DecimalLike;
  availableUsdc?: DecimalLike;
}

export interface FAKOrderSizingResult {
  executable: boolean;
  amountKind: "USD" | "SHARES";
  amount: number;
  reason?: "BELOW_MIN_ORDER_SIZE" | "INSUFFICIENT_BALANCE" | "NON_POSITIVE_DELTA";
}

export function sizeFAKOrder(input: FAKOrderSizingInput): FAKOrderSizingResult {
  const deltaShares = d(input.deltaShares);
  const minOrderSizeShares = d(input.minOrderSizeShares);
  const absDeltaShares = deltaShares.abs();

  if (deltaShares.isZero()) {
    return {
      executable: false,
      amountKind: input.side === "BUY" ? "USD" : "SHARES",
      amount: 0,
      reason: "NON_POSITIVE_DELTA"
    };
  }

  if (absDeltaShares.lessThan(minOrderSizeShares)) {
    return {
      executable: false,
      amountKind: input.side === "BUY" ? "USD" : "SHARES",
      amount: absDeltaShares.toNumber(),
      reason: "BELOW_MIN_ORDER_SIZE"
    };
  }

  if (input.side === "BUY") {
    const desiredShares = deltaShares;
    if (desiredShares.lte(0)) {
      return {
        executable: false,
        amountKind: "USD",
        amount: 0,
        reason: "NON_POSITIVE_DELTA"
      };
    }

    const idealSpend = desiredShares.mul(d(input.midPrice));
    const minSpendForMinShares = minOrderSizeShares.mul(d(input.priceLimit));
    const spend = decimalMax(idealSpend, minSpendForMinShares, d(input.minNotionalUsd));

    if (input.availableUsdc !== undefined && spend.greaterThan(d(input.availableUsdc))) {
      return {
        executable: false,
        amountKind: "USD",
        amount: spend.toNumber(),
        reason: "INSUFFICIENT_BALANCE"
      };
    }

    return {
      executable: true,
      amountKind: "USD",
      amount: spend.toNumber()
    };
  }

  const sharesToSell = deltaShares.abs();
  return {
    executable: true,
    amountKind: "SHARES",
    amount: sharesToSell.toNumber()
  };
}
