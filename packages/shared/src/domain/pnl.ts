import { d, safeDiv, type DecimalLike } from "./math.js";

export interface LeaderLedgerState {
  shares: DecimalLike;
  costUsd: DecimalLike;
  realizedPnlUsd: DecimalLike;
}

export interface FillForLedger {
  shares: DecimalLike;
  usdc: DecimalLike;
  feeUsdc: DecimalLike;
}

export function applyBuyAllocation(state: LeaderLedgerState, fill: FillForLedger): LeaderLedgerState {
  const shares = d(state.shares).plus(d(fill.shares));
  const costUsd = d(state.costUsd).plus(d(fill.usdc)).plus(d(fill.feeUsdc));

  return {
    shares: shares.toNumber(),
    costUsd: costUsd.toNumber(),
    realizedPnlUsd: d(state.realizedPnlUsd).toNumber()
  };
}

export function applySellAllocation(state: LeaderLedgerState, fill: FillForLedger): LeaderLedgerState {
  const currentShares = d(state.shares);
  const currentCost = d(state.costUsd);
  const sellShares = d(fill.shares);

  if (sellShares.lte(0)) {
    throw new Error("Sell shares must be greater than 0");
  }

  if (currentShares.lte(0) || sellShares.greaterThan(currentShares)) {
    throw new Error("Cannot sell more shares than available in ledger");
  }

  const avgCost = safeDiv(currentCost, currentShares, 0);
  const costRemoved = avgCost.mul(sellShares);
  const realizedIncrement = d(fill.usdc).minus(d(fill.feeUsdc)).minus(costRemoved);

  const nextShares = currentShares.minus(sellShares);
  const nextCost = currentCost.minus(costRemoved);
  const nextRealized = d(state.realizedPnlUsd).plus(realizedIncrement);

  return {
    shares: nextShares.toNumber(),
    costUsd: nextCost.toNumber(),
    realizedPnlUsd: nextRealized.toNumber()
  };
}

export function unrealizedPnlUsd(state: LeaderLedgerState, markPrice: DecimalLike): number {
  return d(markPrice).mul(d(state.shares)).minus(d(state.costUsd)).toNumber();
}
