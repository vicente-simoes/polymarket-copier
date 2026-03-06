import { Prisma, PrismaClient } from "@copybot/db";
import type {
  LeaderIngestionStore,
  LeaderPollerStatus,
  LeaderRecord,
  NormalizedTradeEvent
} from "./types.js";
import type { DataApiPosition } from "@copybot/shared";
import {
  buildLeaderCurrentPositionsFromDataApiPositions,
  buildLeaderLatestTradePriceInputs,
  PrismaCurrentStateStore
} from "../current-state/store.js";
import { PrismaTokenMetadataStore } from "../token-metadata/store.js";

const DATA_API_SOURCE = "DATA_API";

export class PrismaLeaderIngestionStore implements LeaderIngestionStore {
  private readonly prisma: PrismaClient;
  private readonly tokenMetadataStore: PrismaTokenMetadataStore;
  private readonly currentStateStore: PrismaCurrentStateStore;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.tokenMetadataStore = new PrismaTokenMetadataStore(prisma);
    this.currentStateStore = new PrismaCurrentStateStore(prisma);
  }

  async listActiveLeaders(): Promise<LeaderRecord[]> {
    const leaders = await this.prisma.leader.findMany({
      where: {
        status: "ACTIVE"
      },
      select: {
        id: true,
        name: true,
        profileAddress: true
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    return leaders;
  }

  async getLatestDataApiTradeCursorMs(leaderId: string): Promise<number | null> {
    const leader = await this.prisma.leader.findUnique({
      where: { id: leaderId },
      select: { metadata: true }
    });
    const metadataCursor = readMetadataTradesCursorMs(leader?.metadata);
    if (metadataCursor !== null) {
      return metadataCursor;
    }

    const aggregate = await this.prisma.leaderTradeEvent.aggregate({
      where: {
        leaderId,
        source: DATA_API_SOURCE
      },
      _max: {
        leaderFillAtMs: true
      }
    });

    return aggregate._max.leaderFillAtMs ? Number(aggregate._max.leaderFillAtMs) : null;
  }

  async upsertLeaderWallets(leaderId: string, wallets: string[], seenAt: Date): Promise<void> {
    const normalized = [...new Set(wallets.map((wallet) => wallet.toLowerCase()))];
    if (normalized.length === 0) {
      return;
    }

    const existing = await this.prisma.leaderWallet.findMany({
      where: {
        leaderId
      },
      select: {
        walletAddress: true,
        isPrimary: true
      }
    });

    const hasPrimary = existing.some((wallet) => wallet.isPrimary);
    const primaryCandidate = normalized[0];

    for (const walletAddress of normalized) {
      await this.prisma.leaderWallet.upsert({
        where: {
          leaderId_walletAddress: {
            leaderId,
            walletAddress
          }
        },
        create: {
          leaderId,
          walletAddress,
          source: DATA_API_SOURCE,
          isActive: true,
          isPrimary: !hasPrimary && walletAddress === primaryCandidate,
          firstSeenAt: seenAt,
          lastSeenAt: seenAt
        },
        update: {
          source: DATA_API_SOURCE,
          isActive: true,
          lastSeenAt: seenAt
        }
      });
    }
  }

  async saveLeaderPositionSnapshots(args: {
    leaderId: string;
    snapshotAt: Date;
    snapshotAtMs: number;
    positions: DataApiPosition[];
  }): Promise<number> {
    const currentPositions = buildLeaderCurrentPositionsFromDataApiPositions(args.positions);
    let inserted = 0;

    if (args.positions.length > 0) {
      const result = await this.prisma.leaderPositionSnapshot.createMany({
        data: args.positions.map((position) => this.toLeaderPositionRow(args.leaderId, args.snapshotAt, args.snapshotAtMs, position))
      });
      inserted = result.count;
      await this.tokenMetadataStore.upsertFromDataApiPositions(args.positions, args.snapshotAt);
    }

    await this.currentStateStore.replaceLeaderCurrentPositions(args.leaderId, args.snapshotAt, currentPositions);

    return inserted;
  }

  async saveLeaderTradeEvents(args: { leaderId: string; events: NormalizedTradeEvent[] }): Promise<number> {
    if (args.events.length === 0) {
      return 0;
    }

    const result = await this.prisma.leaderTradeEvent.createMany({
      data: args.events.map((event) => ({
        leaderId: args.leaderId,
        source: DATA_API_SOURCE,
        triggerId: event.triggerId,
        canonicalKey: event.canonicalKey,
        transactionHash: event.transactionHash,
        logIndex: null,
        leaderFillAtMs: BigInt(event.leaderFillAtMs),
        wsReceivedAtMs: null,
        detectedAtMs: BigInt(event.detectedAtMs),
        marketId: event.marketId ?? null,
        tokenId: event.tokenId,
        outcome: event.outcome ?? null,
        side: event.side,
        shares: String(event.shares),
        price: String(event.price),
        notionalUsd: String(event.notionalUsd),
        payload: event.payload as Prisma.InputJsonValue
      })),
      skipDuplicates: true
    });

    if (result.count < args.events.length) {
      for (const event of args.events) {
        await this.mergeDataApiObservation(args.leaderId, event);
      }
    }
    await this.tokenMetadataStore.upsertFromTradeEvents(args.events);
    await this.currentStateStore.upsertLeaderLatestTradePrices(
      buildLeaderLatestTradePriceInputs(args.leaderId, args.events)
    );

    return result.count;
  }

  async saveLeaderPollMeta(args: {
    leaderId: string;
    pollKind: "positions" | "trades";
    meta: Record<string, unknown>;
  }): Promise<void> {
    const leader = await this.prisma.leader.findUnique({
      where: { id: args.leaderId },
      select: { metadata: true }
    });

    const baseMetadata = ensureObject(leader?.metadata);
    const ingestion = ensureObject(baseMetadata.ingestion);
    const currentPoll = ensureObject(ingestion[args.pollKind]);
    ingestion[args.pollKind] = {
      ...currentPoll,
      ...args.meta
    };
    ingestion.lastUpdatedAtMs = Date.now();

    await this.prisma.leader.update({
      where: { id: args.leaderId },
      data: {
        metadata: {
          ...baseMetadata,
          ingestion
        } as Prisma.InputJsonValue
      }
    });
  }

  async savePollFailure(args: {
    leaderId: string;
    pollKind: "positions" | "trades";
    message: string;
    retryable: boolean;
    attemptCount: number;
    context?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.errorEvent.create({
      data: {
        component: "WORKER",
        severity: args.retryable ? "WARN" : "ERROR",
        code: args.pollKind === "positions" ? "LEADER_POSITIONS_POLL_FAILED" : "LEADER_TRADES_POLL_FAILED",
        message: args.message,
        relatedLeaderId: args.leaderId,
        context: {
          pollKind: args.pollKind,
          retryable: args.retryable,
          attemptCount: args.attemptCount,
          ...(args.context ?? {})
        }
      }
    });
  }

  async saveWorkerPollStatus(status: LeaderPollerStatus): Promise<void> {
    const degraded =
      status.positions.consecutiveFailures > 0 ||
      status.trades.consecutiveFailures > 0 ||
      status.positions.lastError !== undefined ||
      status.trades.lastError !== undefined;

    await this.prisma.systemStatus.upsert({
      where: {
        component: "WORKER"
      },
      create: {
        component: "WORKER",
        status: degraded ? "DEGRADED" : "OK",
        details: toInputJsonValue({
          leaderIngestion: status
        })
      },
      update: {
        status: degraded ? "DEGRADED" : "OK",
        details: toInputJsonValue({
          leaderIngestion: status
        })
      }
    });
  }

  private toLeaderPositionRow(
    leaderId: string,
    snapshotAt: Date,
    snapshotAtMs: number,
    position: DataApiPosition
  ): Prisma.LeaderPositionSnapshotCreateManyInput {
    return {
      leaderId,
      snapshotAt,
      snapshotAtMs: BigInt(snapshotAtMs),
      tokenId: position.asset,
      marketId: position.conditionId,
      outcome: position.outcome ?? null,
      shares: String(position.size),
      avgPrice: position.avgPrice !== undefined ? String(position.avgPrice) : null,
      currentPrice: position.curPrice !== undefined ? String(position.curPrice) : null,
      initialValueUsd: position.initialValue !== undefined ? String(position.initialValue) : null,
      currentValueUsd: position.currentValue !== undefined ? String(position.currentValue) : null,
      cashPnlUsd: position.cashPnl !== undefined ? String(position.cashPnl) : null,
      realizedPnlUsd: position.realizedPnl !== undefined ? String(position.realizedPnl) : null,
      negativeRisk: position.negativeRisk ?? false,
      payload: {
        source: DATA_API_SOURCE,
        raw: position
      } as Prisma.InputJsonValue
    };
  }

  private async mergeDataApiObservation(leaderId: string, event: NormalizedTradeEvent): Promise<void> {
    const existing = await this.prisma.leaderTradeEvent.findUnique({
      where: {
        leaderId_canonicalKey: {
          leaderId,
          canonicalKey: event.canonicalKey
        }
      },
      select: {
        id: true,
        source: true,
        payload: true,
        marketId: true,
        outcome: true,
        transactionHash: true
      }
    });

    if (!existing) {
      return;
    }

    if (existing.source === DATA_API_SOURCE) {
      return;
    }

    const payload = mergePayloadSource(existing.payload, DATA_API_SOURCE, event.detectedAtMs, {
      dataApi: {
        triggerId: event.triggerId,
        transactionHash: event.transactionHash ?? null
      }
    });

    await this.prisma.leaderTradeEvent.update({
      where: { id: existing.id },
      data: {
        transactionHash: existing.transactionHash ?? event.transactionHash ?? null,
        marketId: existing.marketId ?? event.marketId ?? null,
        outcome: existing.outcome ?? event.outcome ?? null,
        payload: toInputJsonValue(payload)
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

function readMetadataTradesCursorMs(value: unknown): number | null {
  const metadata = ensureObject(value);
  const ingestion = ensureObject(metadata.ingestion);
  const trades = ensureObject(ingestion.trades);
  const cursor = trades.cursorMs;
  if (typeof cursor === "number" && Number.isFinite(cursor) && cursor > 0) {
    return Math.floor(cursor);
  }
  if (typeof cursor === "string") {
    const parsed = Number(cursor);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
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
