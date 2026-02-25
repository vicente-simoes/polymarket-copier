import { Prisma, PrismaClient } from "@copybot/db";
import type { ChainTrigger, ChainTriggerStore, LeaderWalletLink, ReconcileTask } from "./types.js";

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

  async persistChainTrigger(trigger: ChainTrigger): Promise<void> {
    try {
      await this.prisma.leaderTradeEvent.create({
        data: {
          leaderId: trigger.leaderId,
          source: CHAIN_SOURCE,
          triggerId: trigger.triggerId,
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
    } catch (error) {
      if (isUniqueViolation(error)) {
        return;
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
    const existing = await this.prisma.leaderTradeEvent.findUnique({
      where: {
        triggerId: args.triggerId
      },
      select: {
        id: true,
        payload: true
      }
    });

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
