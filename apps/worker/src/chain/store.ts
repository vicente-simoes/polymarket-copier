import { Prisma, PrismaClient } from "@copybot/db";
import type { ChainTrigger, ChainTriggerStore, LeaderWalletLink, ReconcileTask } from "./types.js";
import { buildCanonicalTradeKey } from "../ingestion/canonical-trade-key.js";

const CHAIN_SOURCE = "CHAIN";

export class PrismaChainTriggerStore implements ChainTriggerStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listActiveLeaderWallets(): Promise<LeaderWalletLink[]> {
    const wallets = await this.prisma.leaderWallet.findMany({
      where: {
        isActive: true,
        leader: {
          status: "ACTIVE"
        }
      },
      select: {
        leaderId: true,
        walletAddress: true
      }
    });

    return wallets.map((wallet) => ({
      leaderId: wallet.leaderId,
      walletAddress: wallet.walletAddress.toLowerCase()
    }));
  }

  async persistChainTrigger(trigger: ChainTrigger): Promise<{
    inserted: boolean;
    dedupedByCanonicalKey: boolean;
  }> {
    const canonicalKey = buildCanonicalTradeKey({
      leaderId: trigger.leaderId,
      walletAddress: trigger.leaderWallet,
      tokenId: trigger.tokenId,
      side: trigger.side,
      shares: trigger.shares,
      price: trigger.price,
      leaderFillAtMs: trigger.leaderFillAtMs
    });

    try {
      await this.prisma.leaderTradeEvent.create({
        data: {
          leaderId: trigger.leaderId,
          source: CHAIN_SOURCE,
          triggerId: trigger.triggerId,
          canonicalKey,
          transactionHash: trigger.transactionHash,
          logIndex: trigger.logIndex,
          leaderFillAtMs: BigInt(trigger.leaderFillAtMs),
          wsReceivedAtMs: BigInt(trigger.wsReceivedAtMs),
          detectedAtMs: BigInt(trigger.detectedAtMs),
          marketId: null,
          tokenId: trigger.tokenId,
          outcome: null,
          side: trigger.side,
          shares: trigger.shares,
          price: trigger.price,
          notionalUsd: trigger.notionalUsd,
          payload: toInputJsonValue({
            source: CHAIN_SOURCE,
            event: trigger.event,
            leaderWallet: trigger.leaderWallet,
            leaderRole: trigger.leaderRole,
            tokenAmountBaseUnits: trigger.tokenAmountBaseUnits,
            usdcAmountBaseUnits: trigger.usdcAmountBaseUnits,
            feeBaseUnits: trigger.feeBaseUnits,
            rawLog: trigger.rawLog
          })
        }
      });
      return {
        inserted: true,
        dedupedByCanonicalKey: false
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        if (isCanonicalKeyViolation(error)) {
          await this.mergeChainObservationIntoCanonicalTrade(trigger, canonicalKey);
          return {
            inserted: false,
            dedupedByCanonicalKey: true
          };
        }
        return {
          inserted: false,
          dedupedByCanonicalKey: false
        };
      }
      throw error;
    }
  }

  async markTriggerRollback(args: {
    triggerId: string;
    leaderId: string;
    tokenId: string;
    removedAtMs: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const transactionHash =
      typeof args.payload.transactionHash === "string" ? args.payload.transactionHash.toLowerCase() : undefined;
    const logIndex =
      typeof args.payload.logIndex === "number" && Number.isInteger(args.payload.logIndex) ? args.payload.logIndex : undefined;
    const canonicalKey = typeof args.payload.canonicalKey === "string" ? args.payload.canonicalKey : undefined;

    let existing = await this.prisma.leaderTradeEvent.findUnique({
      where: {
        triggerId: args.triggerId
      },
      select: {
        id: true,
        payload: true
      }
    });

    if (!existing && transactionHash !== undefined && logIndex !== undefined) {
      existing = await this.prisma.leaderTradeEvent.findUnique({
        where: {
          transactionHash_logIndex: {
            transactionHash,
            logIndex
          }
        },
        select: {
          id: true,
          payload: true
        }
      });
    }

    if (!existing && canonicalKey) {
      existing = await this.prisma.leaderTradeEvent.findUnique({
        where: {
          leaderId_canonicalKey: {
            leaderId: args.leaderId,
            canonicalKey
          }
        },
        select: {
          id: true,
          payload: true
        }
      });
    }

    if (existing) {
      const payload = ensureObject(existing.payload);
      await this.prisma.leaderTradeEvent.update({
        where: { id: existing.id },
        data: {
          payload: toInputJsonValue({
            ...payload,
            rollback: {
              removedAtMs: args.removedAtMs,
              ...args.payload
            }
          })
        }
      });
    }

    await this.prisma.errorEvent.create({
      data: {
        component: "ALCHEMY_WS",
        severity: "WARN",
        code: existing ? "CHAIN_TRIGGER_ROLLBACK" : "CHAIN_TRIGGER_ROLLBACK_MISSING",
        message: existing
          ? `Reorg rollback received for trigger ${args.triggerId}`
          : `Reorg rollback received for unknown trigger ${args.triggerId}`,
        relatedLeaderId: args.leaderId,
        relatedTokenId: args.tokenId,
        context: toInputJsonValue({
          triggerId: args.triggerId,
          removedAtMs: args.removedAtMs,
          payload: args.payload
        })
      }
    });
  }

  private async mergeChainObservationIntoCanonicalTrade(trigger: ChainTrigger, canonicalKey: string): Promise<void> {
    const existing = await this.prisma.leaderTradeEvent.findUnique({
      where: {
        leaderId_canonicalKey: {
          leaderId: trigger.leaderId,
          canonicalKey
        }
      },
      select: {
        id: true,
        payload: true,
        transactionHash: true,
        logIndex: true,
        wsReceivedAtMs: true
      }
    });

    if (!existing) {
      return;
    }

    const payload = mergePayloadSource(existing.payload, CHAIN_SOURCE, trigger.detectedAtMs, {
      chain: {
        triggerId: trigger.triggerId,
        event: trigger.event,
        leaderWallet: trigger.leaderWallet,
        transactionHash: trigger.transactionHash,
        logIndex: trigger.logIndex,
        wsReceivedAtMs: trigger.wsReceivedAtMs
      }
    });

    await this.prisma.leaderTradeEvent.update({
      where: { id: existing.id },
      data: {
        transactionHash: existing.transactionHash ?? trigger.transactionHash,
        logIndex: existing.logIndex ?? trigger.logIndex,
        wsReceivedAtMs: existing.wsReceivedAtMs ?? BigInt(trigger.wsReceivedAtMs),
        payload: toInputJsonValue(payload)
      }
    });
  }

  async recordReconcileTask(task: ReconcileTask): Promise<void> {
    await this.prisma.errorEvent.create({
      data: {
        component: "WORKER",
        severity: "INFO",
        code: "CHAIN_RECONCILE_ENQUEUED",
        message: `Immediate reconcile queued from chain reorg for token ${task.tokenId}`,
        relatedLeaderId: task.leaderId,
        relatedTokenId: task.tokenId,
        context: toInputJsonValue({
          triggerId: task.triggerId,
          reason: task.reason,
          enqueuedAtMs: task.enqueuedAtMs
        })
      }
    });
  }

  async recordPipelineError(message: string, context: Record<string, unknown> = {}): Promise<void> {
    await this.prisma.errorEvent.create({
      data: {
        component: "ALCHEMY_WS",
        severity: "ERROR",
        code: "CHAIN_TRIGGER_PIPELINE_ERROR",
        message,
        context: toInputJsonValue(context)
      }
    });
  }
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function isCanonicalKeyViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  const target = (error.meta?.target ?? []) as unknown;
  if (Array.isArray(target)) {
    return target.includes("leaderId") && target.includes("canonicalKey");
  }

  if (typeof target === "string") {
    return target.includes("canonicalKey");
  }

  return false;
}

function mergePayloadSource(
  value: unknown,
  source: "CHAIN" | "DATA_API",
  observedAtMs: number,
  extras: Record<string, unknown> = {}
): Record<string, unknown> {
  const payload = ensureObject(value);
  const seenSourcesRaw = Array.isArray(payload.seenSources) ? payload.seenSources : [];
  const seenSources = [...new Set(seenSourcesRaw.filter((entry): entry is string => typeof entry === "string"))];
  if (!seenSources.includes(source)) {
    seenSources.push(source);
  }

  const sourceObservedAtMs = ensureObject(payload.sourceObservedAtMs);
  sourceObservedAtMs[source] = observedAtMs;

  return {
    ...payload,
    ...extras,
    seenSources,
    sourceObservedAtMs
  };
}
