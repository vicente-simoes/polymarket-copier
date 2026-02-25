import { d, sum, type DecimalLike } from "./math.js";
import { roundShares, roundUsd } from "./rounding.js";

export const UNATTRIBUTED_BUCKET = "UNATTRIBUTED";

export type LeaderId = string;

export interface AttributionWeights {
  weights: Record<LeaderId, number>;
  unattributedWeight: number;
}

export interface FillAllocation {
  leaderId: LeaderId;
  shares: number;
  usdc: number;
  feeUsdc: number;
}

export function computeAttributionWeights(params: {
  targetSharesByLeader: Record<LeaderId, DecimalLike>;
  ledgerSharesByLeader: Record<LeaderId, DecimalLike>;
  netDeltaShares: DecimalLike;
}): AttributionWeights {
  const netDeltaShares = d(params.netDeltaShares);
  const weights: Record<string, number> = {};

  if (netDeltaShares.isZero()) {
    return {
      weights,
      unattributedWeight: 1
    };
  }

  const needs = Object.keys(params.targetSharesByLeader).map((leaderId) => {
    const target = d(params.targetSharesByLeader[leaderId] ?? 0);
    const ledger = d(params.ledgerSharesByLeader[leaderId] ?? 0);
    return {
      leaderId,
      need: target.minus(ledger)
    };
  });

  const eligible = netDeltaShares.greaterThan(0)
    ? needs.filter((entry) => entry.need.greaterThan(0))
    : needs.filter((entry) => entry.need.lessThan(0));

  if (eligible.length === 0) {
    return {
      weights,
      unattributedWeight: 1
    };
  }

  const denominator = netDeltaShares.greaterThan(0)
    ? sum(eligible.map((entry) => entry.need))
    : sum(eligible.map((entry) => entry.need.abs()));

  if (denominator.lte(0)) {
    return {
      weights,
      unattributedWeight: 1
    };
  }

  for (const entry of eligible) {
    const numerator = netDeltaShares.greaterThan(0) ? entry.need : entry.need.abs();
    weights[entry.leaderId] = numerator.div(denominator).toNumber();
  }

  const assignedWeight = sum(Object.values(weights)).toNumber();
  const unattributedWeight = d(1).minus(d(assignedWeight)).toNumber();

  return {
    weights,
    unattributedWeight: unattributedWeight > 0 ? unattributedWeight : 0
  };
}

export function allocateFillByWeights(params: {
  filledShares: DecimalLike;
  filledUsdc: DecimalLike;
  feeUsdc: DecimalLike;
  weights: Record<LeaderId, DecimalLike>;
  precisionShares?: number;
  precisionUsd?: number;
}): FillAllocation[] {
  const precisionShares = params.precisionShares ?? 18;
  const precisionUsd = params.precisionUsd ?? 8;
  const result: FillAllocation[] = [];

  const shareBase = d(params.filledShares);
  const usdcNetBase = d(params.filledUsdc).minus(d(params.feeUsdc));
  const feeBase = d(params.feeUsdc);

  let allocatedShares = d(0);
  let allocatedUsdc = d(0);
  let allocatedFee = d(0);

  for (const [leaderId, rawWeight] of Object.entries(params.weights)) {
    const weight = d(rawWeight);
    if (weight.lte(0)) {
      continue;
    }

    const shares = d(roundShares(shareBase.mul(weight), precisionShares));
    const usdc = d(roundUsd(usdcNetBase.mul(weight), precisionUsd));
    const fee = d(roundUsd(feeBase.mul(weight), precisionUsd));

    allocatedShares = allocatedShares.plus(shares);
    allocatedUsdc = allocatedUsdc.plus(usdc);
    allocatedFee = allocatedFee.plus(fee);

    result.push({
      leaderId,
      shares: shares.toNumber(),
      usdc: usdc.toNumber(),
      feeUsdc: fee.toNumber()
    });
  }

  const remainingShares = shareBase.minus(allocatedShares);
  const remainingUsdc = usdcNetBase.minus(allocatedUsdc);
  const remainingFee = feeBase.minus(allocatedFee);

  if (!remainingShares.isZero() || !remainingUsdc.isZero() || !remainingFee.isZero()) {
    result.push({
      leaderId: UNATTRIBUTED_BUCKET,
      shares: roundShares(remainingShares, precisionShares),
      usdc: roundUsd(remainingUsdc, precisionUsd),
      feeUsdc: roundUsd(remainingFee, precisionUsd)
    });
  }

  return result;
}
