import { Prisma, PrismaClient } from "@copybot/db";
import { UNATTRIBUTED_BUCKET, allocateFillByWeights, applyBuyAllocation, applySellAllocation } from "@copybot/shared";
import type {
  FillAllocationResultRow,
  FillAttributionCopyOrder,
  FillAttributionStore,
  IngestTradeFillResult,
  UserOrderUpdateEvent,
  UserTradeFillEvent
} from "./types.js";

type TxClient = Prisma.TransactionClient;

export class PrismaFillAttributionStore implements FillAttributionStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async findCopyOrderForTrade(event: UserTradeFillEvent): Promise<FillAttributionCopyOrder | null> {
    const orderIds = [...new Set(event.externalOrderIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (orderIds.length > 0) {
      const direct = await this.prisma.copyOrder.findFirst({
        where: {
          externalOrderId: {
            in: orderIds
          }
        },
        orderBy: {
          attemptedAt: "desc"
        },
        select: copyOrderSelect
      });

      if (direct) {
        return mapCopyOrder(direct);
      }
    }

    const fallbackWindowStart = new Date(event.filledAt.getTime() - 6 * 60 * 60 * 1000);
    const fallback = await this.prisma.copyOrder.findFirst({
      where: {
        tokenId: event.tokenId,
        side: event.side,
        status: {
          in: ["PLACED", "PARTIALLY_FILLED", "RETRYING"]
        },
        attemptedAt: {
          gte: fallbackWindowStart,
          lte: event.filledAt
        }
      },
      orderBy: {
        attemptedAt: "desc"
      },
      select: copyOrderSelect
    });

    return fallback ? mapCopyOrder(fallback) : null;
  }

  async ingestTradeFill(args: { order: FillAttributionCopyOrder; event: UserTradeFillEvent }): Promise<IngestTradeFillResult> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.copyFill.findUnique({
        where: {
          externalTradeId: args.event.externalTradeId
        },
        select: {
          id: true,
          copyOrderId: true
        }
      });

      if (existing) {
        return {
          matchedOrder: true,
          duplicate: true,
          copyFillId: existing.id,
          copyOrderId: existing.copyOrderId,
          allocationsInserted: 0,
          ledgerUpdates: 0,
          realizedPnlDeltaByLeader: {}
        };
      }

      const order = await tx.copyOrder.findUnique({
        where: {
          id: args.order.id
        },
        select: copyOrderSelect
      });

      if (!order) {
        return {
          matchedOrder: false,
          duplicate: false,
          allocationsInserted: 0,
          ledgerUpdates: 0,
          realizedPnlDeltaByLeader: {}
        };
      }

      const filledUsdcGross = normalizeNonNegative(args.event.filledUsdcGross);
      const feeUsdc = normalizeNonNegative(args.event.feeUsdc);
      const filledShares = normalizeNonNegative(args.event.filledShares);
      if (filledShares <= 0 || args.event.price <= 0) {
        return {
          matchedOrder: true,
          duplicate: false,
          copyOrderId: order.id,
          allocationsInserted: 0,
          ledgerUpdates: 0,
          realizedPnlDeltaByLeader: {}
        };
      }

      const copyFill = await tx.copyFill.create({
        data: {
          copyOrderId: order.id,
          externalTradeId: args.event.externalTradeId,
          tokenId: args.event.tokenId,
          marketId: args.event.marketId ?? order.marketId ?? null,
          side: args.event.side,
          filledShares: String(filledShares),
          filledUsdc: String(filledUsdcGross),
          feeUsdc: String(feeUsdc),
          avgPrice: String(args.event.price),
          filledAt: args.event.filledAt,
          payload: toJsonValue({
            source: "USER_CHANNEL_WS",
            externalOrderIds: args.event.externalOrderIds,
            raw: args.event.payload
          })
        }
      });

      const weights = normalizeLeaderWeights(asObject(order.leaderWeights), order.unattributedWeight ? Number(order.unattributedWeight) : undefined);
      let allocations = allocateAndNormalizeFill({
        filledShares,
        filledUsdcGross,
        feeUsdc,
        weights
      });

      if (args.event.side === "SELL" && allocations.length > 0) {
        const availableByLeader = await this.loadLeaderSharesByToken(tx, args.event.tokenId, allocations);
        allocations = capSellAllocationsByAvailableShares(allocations, availableByLeader);
      }

      const persistedAllocations = allocations.filter((allocation) => {
        return allocation.shares > 0 || allocation.usdcNet !== 0 || allocation.feeUsdc !== 0;
      });

      if (persistedAllocations.length > 0) {
        await tx.copyFillAllocation.createMany({
          data: persistedAllocations.map((allocation) => ({
            copyFillId: copyFill.id,
            copyOrderId: order.id,
            leaderId: allocation.leaderId === UNATTRIBUTED_BUCKET ? null : allocation.leaderId,
            leaderBucket: allocation.leaderId === UNATTRIBUTED_BUCKET ? UNATTRIBUTED_BUCKET : null,
            tokenId: args.event.tokenId,
            sharesDelta: String(args.event.side === "BUY" ? allocation.shares : -allocation.shares),
            usdcDelta: String(args.event.side === "BUY" ? -allocation.usdcNet : allocation.usdcNet),
            feeUsdcDelta: String(-allocation.feeUsdc),
            avgPrice: String(args.event.price)
          }))
        });
      }

      const ledgerOutcome = await this.applyLeaderLedgerUpdates(tx, {
        side: args.event.side,
        tokenId: args.event.tokenId,
        marketId: args.event.marketId ?? order.marketId ?? undefined,
        allocations: persistedAllocations
      });

      await tx.copyOrder.update({
        where: {
          id: order.id
        },
        data: {
          status: inferOrderStatus(args.event.payload)
        }
      });

      return {
        matchedOrder: true,
        duplicate: false,
        copyFillId: copyFill.id,
        copyOrderId: order.id,
        allocationsInserted: persistedAllocations.length,
        ledgerUpdates: ledgerOutcome.ledgerUpdates,
        realizedPnlDeltaByLeader: ledgerOutcome.realizedPnlDeltaByLeader
      };
    });
  }

  async applyOrderUpdate(event: UserOrderUpdateEvent): Promise<boolean> {
    if (!event.orderStatus) {
      return false;
    }

    const result = await this.prisma.copyOrder.updateMany({
      where: {
        externalOrderId: event.externalOrderId
      },
      data: {
        status: event.orderStatus,
        errorPayload: toJsonValue({
          source: "USER_CHANNEL_WS",
          raw: event.payload
        })
      }
    });

    return result.count > 0;
  }

  private async loadLeaderSharesByToken(
    tx: TxClient,
    tokenId: string,
    allocations: FillAllocationResultRow[]
  ): Promise<Record<string, number>> {
    const leaderIds = allocations
      .map((allocation) => allocation.leaderId)
      .filter((leaderId) => leaderId !== UNATTRIBUTED_BUCKET);

    if (leaderIds.length === 0) {
      return {};
    }

    const ledgers = await tx.leaderTokenLedger.findMany({
      where: {
        tokenId,
        leaderId: {
          in: leaderIds
        }
      },
      select: {
        leaderId: true,
        shares: true
      }
    });

    const byLeader: Record<string, number> = {};
    for (const ledger of ledgers) {
      byLeader[ledger.leaderId] = Number(ledger.shares);
    }
    return byLeader;
  }

  private async applyLeaderLedgerUpdates(
    tx: TxClient,
    args: {
      side: "BUY" | "SELL";
      tokenId: string;
      marketId?: string;
      allocations: FillAllocationResultRow[];
    }
  ): Promise<{ ledgerUpdates: number; realizedPnlDeltaByLeader: Record<string, number> }> {
    let ledgerUpdates = 0;
    const realizedPnlDeltaByLeader: Record<string, number> = {};

    for (const allocation of args.allocations) {
      if (allocation.leaderId === UNATTRIBUTED_BUCKET) {
        continue;
      }
      if (allocation.shares <= 0) {
        continue;
      }

      const existing = await tx.leaderTokenLedger.findUnique({
        where: {
          leaderId_tokenId: {
            leaderId: allocation.leaderId,
            tokenId: args.tokenId
          }
        },
        select: {
          shares: true,
          costUsd: true
        }
      });

      const currentShares = existing ? Number(existing.shares) : 0;
      const currentCostUsd = existing ? Number(existing.costUsd) : 0;

      if (args.side === "BUY") {
        const next = applyBuyAllocation(
          {
            shares: currentShares,
            costUsd: currentCostUsd,
            realizedPnlUsd: 0
          },
          {
            shares: allocation.shares,
            usdc: allocation.usdcNet,
            feeUsdc: allocation.feeUsdc
          }
        );

        await tx.leaderTokenLedger.upsert({
          where: {
            leaderId_tokenId: {
              leaderId: allocation.leaderId,
              tokenId: args.tokenId
            }
          },
          create: {
            leaderId: allocation.leaderId,
            tokenId: args.tokenId,
            marketId: args.marketId ?? null,
            shares: String(next.shares),
            costUsd: String(next.costUsd)
          },
          update: {
            marketId: args.marketId ?? null,
            shares: String(next.shares),
            costUsd: String(next.costUsd)
          }
        });

        ledgerUpdates += 1;
        continue;
      }

      if (currentShares <= 0) {
        continue;
      }

      const next = applySellAllocation(
        {
          shares: currentShares,
          costUsd: currentCostUsd,
          realizedPnlUsd: 0
        },
        {
          shares: allocation.shares,
          usdc: allocation.usdcNet + allocation.feeUsdc,
          feeUsdc: allocation.feeUsdc
        }
      );

      await tx.leaderTokenLedger.upsert({
        where: {
          leaderId_tokenId: {
            leaderId: allocation.leaderId,
            tokenId: args.tokenId
          }
        },
        create: {
          leaderId: allocation.leaderId,
          tokenId: args.tokenId,
          marketId: args.marketId ?? null,
          shares: String(next.shares),
          costUsd: String(next.costUsd)
        },
        update: {
          marketId: args.marketId ?? null,
          shares: String(next.shares),
          costUsd: String(next.costUsd)
        }
      });

      const realizedIncrement = Number(next.realizedPnlUsd);
      if (realizedIncrement !== 0) {
        await tx.leaderPnlSummary.upsert({
          where: {
            leaderId: allocation.leaderId
          },
          create: {
            leaderId: allocation.leaderId,
            realizedPnlUsd: String(realizedIncrement)
          },
          update: {
            realizedPnlUsd: {
              increment: String(realizedIncrement)
            }
          }
        });
        realizedPnlDeltaByLeader[allocation.leaderId] =
          (realizedPnlDeltaByLeader[allocation.leaderId] ?? 0) + realizedIncrement;
      }

      ledgerUpdates += 1;
    }

    return {
      ledgerUpdates,
      realizedPnlDeltaByLeader
    };
  }
}

const copyOrderSelect = {
  id: true,
  copyProfileId: true,
  tokenId: true,
  marketId: true,
  side: true,
  externalOrderId: true,
  leaderWeights: true,
  unattributedWeight: true
} satisfies Prisma.CopyOrderSelect;

function mapCopyOrder(order: {
  id: string;
  copyProfileId: string;
  tokenId: string;
  marketId: string | null;
  side: string;
  externalOrderId: string | null;
  leaderWeights: Prisma.JsonValue;
  unattributedWeight: Prisma.Decimal | null;
}): FillAttributionCopyOrder {
  return {
    id: order.id,
    copyProfileId: order.copyProfileId,
    tokenId: order.tokenId,
    marketId: order.marketId ?? undefined,
    side: order.side as "BUY" | "SELL",
    externalOrderId: order.externalOrderId ?? undefined,
    leaderWeights: normalizeLeaderWeights(asObject(order.leaderWeights), order.unattributedWeight ? Number(order.unattributedWeight) : undefined),
    unattributedWeight: order.unattributedWeight ? Number(order.unattributedWeight) : undefined
  };
}

export function normalizeLeaderWeights(
  leaderWeights: Record<string, unknown>,
  explicitUnattributedWeight?: number
): Record<string, number> {
  const normalized: Record<string, number> = {};
  let total = 0;

  for (const [leaderId, rawWeight] of Object.entries(leaderWeights)) {
    if (leaderId === UNATTRIBUTED_BUCKET) {
      continue;
    }
    const weight = readNumber(rawWeight);
    if (!weight || weight <= 0) {
      continue;
    }
    normalized[leaderId] = weight;
    total += weight;
  }

  if (total <= 0) {
    return {};
  }

  for (const leaderId of Object.keys(normalized)) {
    const value = normalized[leaderId] ?? 0;
    normalized[leaderId] = roundTo(value / total, 8);
  }

  const unattributed = explicitUnattributedWeight ?? Math.max(1 - total, 0);
  if (unattributed > 0) {
    normalized[UNATTRIBUTED_BUCKET] = roundTo(unattributed, 8);
  }

  return normalized;
}

export function allocateAndNormalizeFill(args: {
  filledShares: number;
  filledUsdcGross: number;
  feeUsdc: number;
  weights: Record<string, number>;
}): FillAllocationResultRow[] {
  const allocation = allocateFillByWeights({
    filledShares: args.filledShares,
    filledUsdc: args.filledUsdcGross,
    feeUsdc: args.feeUsdc,
    weights: args.weights
  });

  return allocation
    .map((entry) => ({
      leaderId: entry.leaderId,
      shares: normalizeNonNegative(entry.shares),
      usdcNet: normalizeNonNegative(entry.usdc),
      feeUsdc: normalizeNonNegative(entry.feeUsdc)
    }))
    .filter((entry) => entry.shares > 0 || entry.usdcNet > 0 || entry.feeUsdc > 0);
}

export function capSellAllocationsByAvailableShares(
  allocations: FillAllocationResultRow[],
  availableSharesByLeader: Record<string, number>
): FillAllocationResultRow[] {
  if (allocations.length === 0) {
    return [];
  }

  const result: FillAllocationResultRow[] = [];
  let spillShares = 0;
  let spillUsdcNet = 0;
  let spillFeeUsdc = 0;

  for (const allocation of allocations) {
    if (allocation.leaderId === UNATTRIBUTED_BUCKET) {
      spillShares += allocation.shares;
      spillUsdcNet += allocation.usdcNet;
      spillFeeUsdc += allocation.feeUsdc;
      continue;
    }

    const availableShares = normalizeNonNegative(availableSharesByLeader[allocation.leaderId] ?? 0);
    if (availableShares <= 0 || allocation.shares <= 0) {
      spillShares += allocation.shares;
      spillUsdcNet += allocation.usdcNet;
      spillFeeUsdc += allocation.feeUsdc;
      continue;
    }

    const executableShares = Math.min(availableShares, allocation.shares);
    const executableRatio = executableShares / allocation.shares;
    const executableUsdc = roundTo(allocation.usdcNet * executableRatio, 8);
    const executableFee = roundTo(allocation.feeUsdc * executableRatio, 8);

    result.push({
      leaderId: allocation.leaderId,
      shares: roundTo(executableShares, 18),
      usdcNet: executableUsdc,
      feeUsdc: executableFee
    });

    const overflowRatio = 1 - executableRatio;
    if (overflowRatio > 0) {
      spillShares += roundTo(allocation.shares * overflowRatio, 18);
      spillUsdcNet += roundTo(allocation.usdcNet * overflowRatio, 8);
      spillFeeUsdc += roundTo(allocation.feeUsdc * overflowRatio, 8);
    }
  }

  if (spillShares > 0 || spillUsdcNet > 0 || spillFeeUsdc > 0) {
    result.push({
      leaderId: UNATTRIBUTED_BUCKET,
      shares: roundTo(spillShares, 18),
      usdcNet: roundTo(spillUsdcNet, 8),
      feeUsdc: roundTo(spillFeeUsdc, 8)
    });
  }

  return result;
}

function inferOrderStatus(payload: Record<string, unknown>): "PARTIALLY_FILLED" | "FILLED" {
  const rawStatus = readString(payload.status)?.toUpperCase();
  if (rawStatus === "FILLED") {
    return "FILLED";
  }

  const sizeMatched = readNumber(payload.size_matched);
  const originalSize = readNumber(payload.original_size);
  if (sizeMatched !== undefined && originalSize !== undefined && originalSize > 0 && sizeMatched >= originalSize) {
    return "FILLED";
  }

  return "PARTIALLY_FILLED";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toJsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
