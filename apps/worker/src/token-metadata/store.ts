import { Prisma, PrismaClient } from "@copybot/db";
import type {
  DataApiPosition,
  TokenDisplayMetadataObservation,
  TokenDisplayMetadataRecord
} from "@copybot/shared";
import {
  extractTokenDisplayMetadataFromPayload,
  mergeTokenDisplayMetadata
} from "@copybot/shared";
import type { NormalizedTradeEvent } from "../leader/types.js";

export class PrismaTokenMetadataStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async upsertObservations(observations: TokenDisplayMetadataObservation[]): Promise<void> {
    const normalized = mergeObservationBatch(observations);
    if (normalized.length === 0) {
      return;
    }

    const tokenIds = normalized.map((observation) => observation.tokenId);
    const existingRows = await this.prisma.tokenMetadata.findMany({
      where: {
        tokenId: {
          in: tokenIds
        }
      }
    });

    const existingByToken = new Map<string, TokenDisplayMetadataRecord>(
      existingRows.map((row) => [
        row.tokenId,
        {
          tokenId: row.tokenId,
          marketId: row.marketId,
          title: row.title,
          slug: row.slug,
          eventSlug: row.eventSlug,
          outcome: row.outcome,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt
        }
      ])
    );

    const creates: Prisma.TokenMetadataCreateManyInput[] = [];
    const updates: Array<{ tokenId: string; data: Prisma.TokenMetadataUpdateInput }> = [];

    for (const observation of normalized) {
      const existing = existingByToken.get(observation.tokenId) ?? null;
      const merged = mergeTokenDisplayMetadata(existing, observation);

      if (!existing) {
        creates.push({
          tokenId: merged.tokenId,
          marketId: merged.marketId,
          title: merged.title,
          slug: merged.slug,
          eventSlug: merged.eventSlug,
          outcome: merged.outcome,
          firstSeenAt: merged.firstSeenAt,
          lastSeenAt: merged.lastSeenAt,
          updatedAt: merged.lastSeenAt
        });
        continue;
      }

      if (!recordsEqual(existing, merged)) {
        updates.push({
          tokenId: merged.tokenId,
          data: {
            marketId: merged.marketId,
            title: merged.title,
            slug: merged.slug,
            eventSlug: merged.eventSlug,
            outcome: merged.outcome,
            firstSeenAt: merged.firstSeenAt,
            lastSeenAt: merged.lastSeenAt
          }
        });
      }
    }

    if (creates.length > 0) {
      await this.prisma.tokenMetadata.createMany({
        data: creates,
        skipDuplicates: true
      });
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((update) =>
          this.prisma.tokenMetadata.update({
            where: {
              tokenId: update.tokenId
            },
            data: update.data
          })
        )
      );
    }
  }

  async upsertFromDataApiPositions(positions: DataApiPosition[], observedAt: Date): Promise<void> {
    await this.upsertObservations(buildTokenMetadataObservationsFromDataApiPositions(positions, observedAt));
  }

  async upsertFromTradeEvents(events: NormalizedTradeEvent[]): Promise<void> {
    await this.upsertObservations(buildTokenMetadataObservationsFromTradeEvents(events));
  }
}

export function buildTokenMetadataObservationsFromDataApiPositions(
  positions: DataApiPosition[],
  observedAt: Date
): TokenDisplayMetadataObservation[] {
  return mergeObservationBatch(
    positions
      .map((position) => {
        const tokenId = position.asset?.trim();
        if (!tokenId) {
          return null;
        }

        return {
          tokenId,
          marketId: position.conditionId,
          title: position.title,
          slug: position.slug,
          eventSlug: position.eventSlug,
          outcome: position.outcome,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt
        } satisfies TokenDisplayMetadataObservation;
      })
      .filter((value): value is TokenDisplayMetadataObservation => value !== null)
  );
}

export function buildTokenMetadataObservationsFromTradeEvents(
  events: NormalizedTradeEvent[]
): TokenDisplayMetadataObservation[] {
  return mergeObservationBatch(
    events
      .map((event) => {
        const tokenId = event.tokenId?.trim();
        if (!tokenId) {
          return null;
        }

        const payloadMetadata = extractTokenDisplayMetadataFromPayload(event.payload);
        const observedAt = new Date(event.leaderFillAtMs);
        return {
          tokenId,
          marketId: event.marketId ?? payloadMetadata.marketId ?? null,
          title: payloadMetadata.title ?? null,
          slug: payloadMetadata.slug ?? null,
          eventSlug: payloadMetadata.eventSlug ?? null,
          outcome: event.outcome ?? payloadMetadata.outcome ?? null,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt
        } satisfies TokenDisplayMetadataObservation;
      })
      .filter((value): value is TokenDisplayMetadataObservation => value !== null)
  );
}

export function buildTokenMetadataObservationFromRow(args: {
  tokenId: string;
  marketId?: string | null;
  outcome?: string | null;
  payload?: unknown;
  observedAt: Date;
}): TokenDisplayMetadataObservation | null {
  const tokenId = args.tokenId.trim();
  if (!tokenId) {
    return null;
  }

  const payloadMetadata = extractTokenDisplayMetadataFromPayload(args.payload);
  return {
    tokenId,
    marketId: args.marketId ?? payloadMetadata.marketId ?? null,
    title: payloadMetadata.title ?? null,
    slug: payloadMetadata.slug ?? null,
    eventSlug: payloadMetadata.eventSlug ?? null,
    outcome: args.outcome ?? payloadMetadata.outcome ?? null,
    firstSeenAt: args.observedAt,
    lastSeenAt: args.observedAt
  };
}

export function mergeObservationBatch(
  observations: TokenDisplayMetadataObservation[]
): TokenDisplayMetadataObservation[] {
  const mergedByToken = new Map<string, TokenDisplayMetadataRecord>();

  for (const observation of observations) {
    const tokenId = observation.tokenId.trim();
    if (!tokenId) {
      continue;
    }
    const normalizedObservation = {
      ...observation,
      tokenId
    };
    const current = mergedByToken.get(tokenId) ?? null;
    mergedByToken.set(tokenId, mergeTokenDisplayMetadata(current, normalizedObservation));
  }

  return [...mergedByToken.values()].map((record) => ({
    tokenId: record.tokenId,
    marketId: record.marketId,
    title: record.title,
    slug: record.slug,
    eventSlug: record.eventSlug,
    outcome: record.outcome,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt
  }));
}

function recordsEqual(left: TokenDisplayMetadataRecord, right: TokenDisplayMetadataRecord): boolean {
  return (
    left.marketId === right.marketId &&
    left.title === right.title &&
    left.slug === right.slug &&
    left.eventSlug === right.eventSlug &&
    left.outcome === right.outcome &&
    left.firstSeenAt.getTime() === right.firstSeenAt.getTime() &&
    left.lastSeenAt.getTime() === right.lastSeenAt.getTime()
  );
}
