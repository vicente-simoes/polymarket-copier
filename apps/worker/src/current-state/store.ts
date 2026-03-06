import { Prisma, PrismaClient } from "@copybot/db";
import type { DataApiPosition } from "@copybot/shared";
import type { NormalizedTradeEvent } from "../leader/types.js";

const INSERT_CHUNK_SIZE = 200;

type DecimalLike = Prisma.Decimal | bigint | number | string | null;

export type CurrentPositionSource = "DATA_API" | "RECONCILE_FILLS";

export interface LeaderCurrentPositionInput {
  tokenId: string;
  marketId?: string;
  shares: number;
  avgPrice?: number;
  currentPrice?: number;
  currentValueUsd?: number;
}

export interface FollowerCurrentPositionInput {
  tokenId: string;
  marketId?: string;
  outcome?: string;
  shares: number;
  costBasisUsd?: number;
  currentPrice?: number;
  currentValueUsd?: number;
}

export interface LeaderLatestTradePriceInput {
  leaderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  leaderFillAtMs: number;
  source: "CHAIN" | "DATA_API";
}

interface ReplaceResult {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

interface UpsertLatestTradePriceResult {
  created: number;
  updated: number;
  unchanged: number;
}

interface LeaderCurrentPositionRow {
  leaderId: string;
  tokenId: string;
  marketId: string | null;
  shares: DecimalLike;
  avgPrice: DecimalLike;
  currentPrice: DecimalLike;
  currentValueUsd: DecimalLike;
  snapshotAt: Date;
}

interface FollowerCurrentPositionRow {
  copyProfileId: string;
  tokenId: string;
  marketId: string | null;
  outcome: string | null;
  shares: DecimalLike;
  costBasisUsd: DecimalLike;
  currentPrice: DecimalLike;
  currentValueUsd: DecimalLike;
  source: string;
  snapshotAt: Date;
}

interface LeaderLatestTradePriceRow {
  leaderId: string;
  tokenId: string;
  side: string;
  price: DecimalLike;
  leaderFillAtMs: bigint | number | string;
}

export class PrismaCurrentStateStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async replaceLeaderCurrentPositions(
    leaderId: string,
    snapshotAt: Date,
    positions: LeaderCurrentPositionInput[]
  ): Promise<ReplaceResult> {
    const normalized = buildLeaderCurrentPositionMap(positions);
    const existingRows = await this.prisma.$queryRaw<LeaderCurrentPositionRow[]>(Prisma.sql`
      SELECT "leaderId", "tokenId", "marketId", "shares", "avgPrice", "currentPrice", "currentValueUsd", "snapshotAt"
      FROM "LeaderCurrentPosition"
      WHERE "leaderId" = ${leaderId}
    `);

    const existingByToken = new Map(existingRows.map((row) => [row.tokenId, row]));
    const creates: LeaderCurrentPositionInput[] = [];
    const updates: LeaderCurrentPositionInput[] = [];
    let unchanged = 0;

    for (const [tokenId, row] of normalized.entries()) {
      const existing = existingByToken.get(tokenId);
      if (!existing) {
        creates.push(row);
        continue;
      }

      if (leaderCurrentPositionEquals(existing, snapshotAt, row)) {
        unchanged += 1;
        continue;
      }

      updates.push(row);
    }

    const staleTokenIds = existingRows
      .map((row) => row.tokenId)
      .filter((tokenId) => !normalized.has(tokenId));

    if (creates.length > 0) {
      await insertLeaderCurrentPositions(this.prisma, leaderId, snapshotAt, creates);
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((row) =>
          this.prisma.$executeRaw(Prisma.sql`
            UPDATE "LeaderCurrentPosition"
            SET
              "marketId" = ${row.marketId ?? null},
              "shares" = ${toDbNumber(row.shares)},
              "avgPrice" = ${toDbNullableNumber(row.avgPrice)},
              "currentPrice" = ${toDbNullableNumber(row.currentPrice)},
              "currentValueUsd" = ${toDbNullableNumber(row.currentValueUsd)},
              "snapshotAt" = ${snapshotAt},
              "updatedAt" = ${snapshotAt}
            WHERE "leaderId" = ${leaderId} AND "tokenId" = ${row.tokenId}
          `)
        )
      );
    }

    if (staleTokenIds.length > 0) {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "LeaderCurrentPosition"
        WHERE "leaderId" = ${leaderId}
          AND "tokenId" IN (${Prisma.join(staleTokenIds)})
      `);
    }

    return {
      created: creates.length,
      updated: updates.length,
      deleted: staleTokenIds.length,
      unchanged
    };
  }

  async replaceFollowerCurrentPositions(
    copyProfileId: string,
    snapshotAt: Date,
    source: CurrentPositionSource,
    positions: FollowerCurrentPositionInput[]
  ): Promise<ReplaceResult> {
    const normalized = buildFollowerCurrentPositionMap(positions);
    const existingRows = await this.prisma.$queryRaw<FollowerCurrentPositionRow[]>(Prisma.sql`
      SELECT
        "copyProfileId",
        "tokenId",
        "marketId",
        "outcome",
        "shares",
        "costBasisUsd",
        "currentPrice",
        "currentValueUsd",
        "source",
        "snapshotAt"
      FROM "FollowerCurrentPosition"
      WHERE "copyProfileId" = ${copyProfileId}
    `);

    const existingByToken = new Map(existingRows.map((row) => [row.tokenId, row]));
    const creates: FollowerCurrentPositionInput[] = [];
    const updates: FollowerCurrentPositionInput[] = [];
    let unchanged = 0;

    for (const [tokenId, row] of normalized.entries()) {
      const existing = existingByToken.get(tokenId);
      if (!existing) {
        creates.push(row);
        continue;
      }

      if (followerCurrentPositionEquals(existing, snapshotAt, source, row)) {
        unchanged += 1;
        continue;
      }

      updates.push(row);
    }

    const staleTokenIds = existingRows
      .map((row) => row.tokenId)
      .filter((tokenId) => !normalized.has(tokenId));

    if (creates.length > 0) {
      await insertFollowerCurrentPositions(this.prisma, copyProfileId, snapshotAt, source, creates);
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((row) =>
          this.prisma.$executeRaw(Prisma.sql`
            UPDATE "FollowerCurrentPosition"
            SET
              "marketId" = ${row.marketId ?? null},
              "outcome" = ${row.outcome ?? null},
              "shares" = ${toDbNumber(row.shares)},
              "costBasisUsd" = ${toDbNullableNumber(row.costBasisUsd)},
              "currentPrice" = ${toDbNullableNumber(row.currentPrice)},
              "currentValueUsd" = ${toDbNullableNumber(row.currentValueUsd)},
              "source" = ${source},
              "snapshotAt" = ${snapshotAt},
              "updatedAt" = ${snapshotAt}
            WHERE "copyProfileId" = ${copyProfileId} AND "tokenId" = ${row.tokenId}
          `)
        )
      );
    }

    if (staleTokenIds.length > 0) {
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "FollowerCurrentPosition"
        WHERE "copyProfileId" = ${copyProfileId}
          AND "tokenId" IN (${Prisma.join(staleTokenIds)})
      `);
    }

    return {
      created: creates.length,
      updated: updates.length,
      deleted: staleTokenIds.length,
      unchanged
    };
  }

  async upsertLeaderLatestTradePrices(points: LeaderLatestTradePriceInput[]): Promise<UpsertLatestTradePriceResult> {
    const normalized = mergeLeaderLatestTradePriceInputs(points);
    if (normalized.length === 0) {
      return {
        created: 0,
        updated: 0,
        unchanged: 0
      };
    }

    const keys = normalized.map((point) => Prisma.sql`(${point.leaderId}, ${point.tokenId}, ${point.side})`);
    const existingRows = await this.prisma.$queryRaw<LeaderLatestTradePriceRow[]>(Prisma.sql`
      SELECT "leaderId", "tokenId", "side", "price", "leaderFillAtMs"
      FROM "LeaderLatestTradePrice"
      WHERE ("leaderId", "tokenId", "side") IN (${Prisma.join(keys)})
    `);
    const existingByKey = new Map(existingRows.map((row) => [leaderLatestTradePriceKey(row.leaderId, row.tokenId, row.side), row]));
    const creates: LeaderLatestTradePriceInput[] = [];
    const updates: LeaderLatestTradePriceInput[] = [];
    let unchanged = 0;

    for (const point of normalized) {
      const key = leaderLatestTradePriceKey(point.leaderId, point.tokenId, point.side);
      const existing = existingByKey.get(key);
      if (!existing) {
        creates.push(point);
        continue;
      }

      const existingFillAtMs = normalizeBigIntLike(existing.leaderFillAtMs);
      const shouldUpdate =
        point.leaderFillAtMs > existingFillAtMs ||
        (point.leaderFillAtMs === existingFillAtMs && !isValidStoredTradePrice(existing.price));

      if (!shouldUpdate) {
        unchanged += 1;
        continue;
      }

      updates.push(point);
    }

    if (creates.length > 0) {
      await insertLeaderLatestTradePrices(this.prisma, creates);
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(
        updates.map((point) => {
          const eventAt = new Date(point.leaderFillAtMs);
          return this.prisma.$executeRaw(Prisma.sql`
            UPDATE "LeaderLatestTradePrice"
            SET
              "price" = ${toDbNumber(point.price)},
              "leaderFillAtMs" = ${BigInt(point.leaderFillAtMs)},
              "source" = ${point.source},
              "updatedAt" = ${eventAt}
            WHERE "leaderId" = ${point.leaderId}
              AND "tokenId" = ${point.tokenId}
              AND "side" = ${point.side}
          `);
        })
      );
    }

    return {
      created: creates.length,
      updated: updates.length,
      unchanged
    };
  }
}

export function buildLeaderCurrentPositionsFromDataApiPositions(
  positions: DataApiPosition[]
): LeaderCurrentPositionInput[] {
  return [...buildLeaderCurrentPositionMap(
    positions
      .map((position) => {
        const tokenId = position.asset?.trim();
        const shares = finiteOrZero(position.size);
        if (!tokenId || Math.abs(shares) < 1e-12) {
          return null;
        }

        return {
          tokenId,
          marketId: readNonEmptyString(position.conditionId) ?? undefined,
          shares,
          avgPrice: finiteOrUndefined(position.avgPrice),
          currentPrice: finiteOrUndefined(position.curPrice) ?? finiteOrUndefined(position.avgPrice),
          currentValueUsd:
            finiteOrUndefined(position.currentValue) ??
            (finiteOrUndefined(position.curPrice) !== undefined ? shares * (position.curPrice as number) : undefined)
        } satisfies LeaderCurrentPositionInput;
      })
      .filter(isDefined)
  ).values()];
}

export function mapFollowerSnapshotRowsToCurrentPositions(
  rows: Array<{
    tokenId: string;
    marketId?: string | null;
    outcome?: string | null;
    shares: number;
    costBasisUsd?: number;
    currentPrice?: number;
    currentValueUsd?: number;
  }>
): FollowerCurrentPositionInput[] {
  return [...buildFollowerCurrentPositionMap(
    rows
      .map((row) => {
        const tokenId = row.tokenId?.trim();
        const shares = finiteOrZero(row.shares);
        if (!tokenId || Math.abs(shares) < 1e-12) {
          return null;
        }
        return {
          tokenId,
          marketId: readNonEmptyString(row.marketId) ?? undefined,
          outcome: readNonEmptyString(row.outcome) ?? undefined,
          shares,
          costBasisUsd: finiteOrUndefined(row.costBasisUsd),
          currentPrice: finiteOrUndefined(row.currentPrice),
          currentValueUsd: finiteOrUndefined(row.currentValueUsd)
        } satisfies FollowerCurrentPositionInput;
      })
      .filter(isDefined)
  ).values()];
}

export function buildLeaderLatestTradePriceInputs(
  leaderId: string,
  events: NormalizedTradeEvent[]
): LeaderLatestTradePriceInput[] {
  return mergeLeaderLatestTradePriceInputs(
    events
      .map((event) => {
        const tokenId = event.tokenId?.trim();
        if (!tokenId || !Number.isFinite(event.price) || event.price <= 0) {
          return null;
        }

        return {
          leaderId,
          tokenId,
          side: event.side,
          price: event.price,
          leaderFillAtMs: event.leaderFillAtMs,
          source: "DATA_API"
        } satisfies LeaderLatestTradePriceInput;
      })
      .filter(isDefined)
  );
}

export function mergeLeaderLatestTradePriceInputs(
  points: LeaderLatestTradePriceInput[]
): LeaderLatestTradePriceInput[] {
  const byKey = new Map<string, LeaderLatestTradePriceInput>();

  for (const point of points) {
    const key = leaderLatestTradePriceKey(point.leaderId, point.tokenId, point.side);
    const existing = byKey.get(key);
    if (!existing || point.leaderFillAtMs > existing.leaderFillAtMs) {
      byKey.set(key, point);
    }
  }

  return [...byKey.values()];
}

function buildLeaderCurrentPositionMap(
  positions: LeaderCurrentPositionInput[]
): Map<string, LeaderCurrentPositionInput> {
  const byToken = new Map<string, LeaderCurrentPositionInput>();

  for (const position of positions) {
    const tokenId = position.tokenId.trim();
    if (!tokenId || Math.abs(position.shares) < 1e-12) {
      continue;
    }

    const existing = byToken.get(tokenId);
    if (!existing) {
      byToken.set(tokenId, {
        tokenId,
        marketId: position.marketId,
        shares: position.shares,
        avgPrice: position.avgPrice,
        currentPrice: position.currentPrice,
        currentValueUsd: position.currentValueUsd
      });
      continue;
    }

    existing.shares += position.shares;
    existing.currentValueUsd = sumDefined(existing.currentValueUsd, position.currentValueUsd);
    if (!existing.marketId && position.marketId) {
      existing.marketId = position.marketId;
    }
    if (existing.avgPrice === undefined && position.avgPrice !== undefined) {
      existing.avgPrice = position.avgPrice;
    }
    if (existing.currentPrice === undefined && position.currentPrice !== undefined) {
      existing.currentPrice = position.currentPrice;
    }
  }

  for (const row of byToken.values()) {
    if (row.currentPrice === undefined && row.currentValueUsd !== undefined && Math.abs(row.shares) >= 1e-12) {
      row.currentPrice = row.currentValueUsd / row.shares;
    }
    if (row.avgPrice === undefined) {
      row.avgPrice = row.currentPrice;
    }
  }

  for (const [tokenId, row] of [...byToken.entries()]) {
    if (Math.abs(row.shares) < 1e-12) {
      byToken.delete(tokenId);
    }
  }

  return byToken;
}

function buildFollowerCurrentPositionMap(
  positions: FollowerCurrentPositionInput[]
): Map<string, FollowerCurrentPositionInput> {
  const byToken = new Map<string, FollowerCurrentPositionInput>();

  for (const position of positions) {
    const tokenId = position.tokenId.trim();
    if (!tokenId || Math.abs(position.shares) < 1e-12) {
      continue;
    }

    const existing = byToken.get(tokenId);
    if (!existing) {
      byToken.set(tokenId, {
        tokenId,
        marketId: position.marketId,
        outcome: position.outcome,
        shares: position.shares,
        costBasisUsd: position.costBasisUsd,
        currentPrice: position.currentPrice,
        currentValueUsd: position.currentValueUsd
      });
      continue;
    }

    existing.shares += position.shares;
    existing.costBasisUsd = sumDefined(existing.costBasisUsd, position.costBasisUsd);
    existing.currentValueUsd = sumDefined(existing.currentValueUsd, position.currentValueUsd);
    if (!existing.marketId && position.marketId) {
      existing.marketId = position.marketId;
    }
    if (!existing.outcome && position.outcome) {
      existing.outcome = position.outcome;
    }
    if (existing.currentPrice === undefined && position.currentPrice !== undefined) {
      existing.currentPrice = position.currentPrice;
    }
  }

  for (const row of byToken.values()) {
    if (row.currentPrice === undefined && row.currentValueUsd !== undefined && Math.abs(row.shares) >= 1e-12) {
      row.currentPrice = row.currentValueUsd / row.shares;
    }
  }

  for (const [tokenId, row] of [...byToken.entries()]) {
    if (Math.abs(row.shares) < 1e-12) {
      byToken.delete(tokenId);
    }
  }

  return byToken;
}

async function insertLeaderCurrentPositions(
  prisma: PrismaClient,
  leaderId: string,
  snapshotAt: Date,
  rows: LeaderCurrentPositionInput[]
): Promise<void> {
  for (const chunk of chunkArray(rows, INSERT_CHUNK_SIZE)) {
    const values = chunk.map((row) =>
      Prisma.sql`(
        ${leaderId},
        ${row.tokenId},
        ${row.marketId ?? null},
        ${toDbNumber(row.shares)},
        ${toDbNullableNumber(row.avgPrice)},
        ${toDbNullableNumber(row.currentPrice)},
        ${toDbNullableNumber(row.currentValueUsd)},
        ${snapshotAt},
        ${snapshotAt}
      )`
    );

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "LeaderCurrentPosition" (
        "leaderId",
        "tokenId",
        "marketId",
        "shares",
        "avgPrice",
        "currentPrice",
        "currentValueUsd",
        "snapshotAt",
        "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("leaderId", "tokenId") DO NOTHING
    `);
  }
}

async function insertFollowerCurrentPositions(
  prisma: PrismaClient,
  copyProfileId: string,
  snapshotAt: Date,
  source: CurrentPositionSource,
  rows: FollowerCurrentPositionInput[]
): Promise<void> {
  for (const chunk of chunkArray(rows, INSERT_CHUNK_SIZE)) {
    const values = chunk.map((row) =>
      Prisma.sql`(
        ${copyProfileId},
        ${row.tokenId},
        ${row.marketId ?? null},
        ${row.outcome ?? null},
        ${toDbNumber(row.shares)},
        ${toDbNullableNumber(row.costBasisUsd)},
        ${toDbNullableNumber(row.currentPrice)},
        ${toDbNullableNumber(row.currentValueUsd)},
        ${source},
        ${snapshotAt},
        ${snapshotAt}
      )`
    );

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "FollowerCurrentPosition" (
        "copyProfileId",
        "tokenId",
        "marketId",
        "outcome",
        "shares",
        "costBasisUsd",
        "currentPrice",
        "currentValueUsd",
        "source",
        "snapshotAt",
        "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("copyProfileId", "tokenId") DO NOTHING
    `);
  }
}

async function insertLeaderLatestTradePrices(
  prisma: PrismaClient,
  rows: LeaderLatestTradePriceInput[]
): Promise<void> {
  for (const chunk of chunkArray(rows, INSERT_CHUNK_SIZE)) {
    const values = chunk.map((point) => {
      const eventAt = new Date(point.leaderFillAtMs);
      return Prisma.sql`(
        ${point.leaderId},
        ${point.tokenId},
        ${point.side},
        ${toDbNumber(point.price)},
        ${BigInt(point.leaderFillAtMs)},
        ${point.source},
        ${eventAt},
        ${eventAt}
      )`;
    });

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "LeaderLatestTradePrice" (
        "leaderId",
        "tokenId",
        "side",
        "price",
        "leaderFillAtMs",
        "source",
        "createdAt",
        "updatedAt"
      )
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("leaderId", "tokenId", "side") DO NOTHING
    `);
  }
}

function leaderCurrentPositionEquals(
  existing: LeaderCurrentPositionRow,
  snapshotAt: Date,
  row: LeaderCurrentPositionInput
): boolean {
  return (
    existing.marketId === (row.marketId ?? null) &&
    normalizeDecimalLike(existing.shares) === row.shares &&
    normalizeDecimalLike(existing.avgPrice) === normalizeOptionalNumber(row.avgPrice) &&
    normalizeDecimalLike(existing.currentPrice) === normalizeOptionalNumber(row.currentPrice) &&
    normalizeDecimalLike(existing.currentValueUsd) === normalizeOptionalNumber(row.currentValueUsd) &&
    existing.snapshotAt.getTime() === snapshotAt.getTime()
  );
}

function followerCurrentPositionEquals(
  existing: FollowerCurrentPositionRow,
  snapshotAt: Date,
  source: CurrentPositionSource,
  row: FollowerCurrentPositionInput
): boolean {
  return (
    existing.marketId === (row.marketId ?? null) &&
    existing.outcome === (row.outcome ?? null) &&
    normalizeDecimalLike(existing.shares) === row.shares &&
    normalizeDecimalLike(existing.costBasisUsd) === normalizeOptionalNumber(row.costBasisUsd) &&
    normalizeDecimalLike(existing.currentPrice) === normalizeOptionalNumber(row.currentPrice) &&
    normalizeDecimalLike(existing.currentValueUsd) === normalizeOptionalNumber(row.currentValueUsd) &&
    existing.source === source &&
    existing.snapshotAt.getTime() === snapshotAt.getTime()
  );
}

function isValidStoredTradePrice(value: DecimalLike): boolean {
  const numeric = normalizeDecimalLike(value);
  return numeric !== null && Number.isFinite(numeric) && numeric > 0;
}

function leaderLatestTradePriceKey(leaderId: string, tokenId: string, side: string): string {
  return `${leaderId}|${tokenId}|${side}`;
}

function finiteOrZero(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function sumDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left + right;
}

function normalizeDecimalLike(value: DecimalLike): number | null {
  if (value === null) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeOptionalNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function normalizeBigIntLike(value: bigint | number | string): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toDbNumber(value: number): string {
  return String(value);
}

function toDbNullableNumber(value: number | undefined): string | null {
  return value !== undefined && Number.isFinite(value) ? String(value) : null;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (values.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
