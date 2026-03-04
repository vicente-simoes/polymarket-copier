import { Prisma, PrismaClient } from "@copybot/db";
import { randomUUID } from "node:crypto";

interface CliOptions {
  apply: boolean;
  copyProfileId?: string;
}

interface AllocationRow {
  copyProfileId: string;
  leaderId: string;
  tokenId: string;
  marketId?: string;
  sharesDelta: number;
  usdcDelta: number;
  feeUsdcDelta: number;
}

interface LedgerState {
  copyProfileId: string;
  leaderId: string;
  tokenId: string;
  marketId?: string;
  shares: number;
  costUsd: number;
}

async function main(): Promise<void> {
  const options = parseCliOptions();
  const prisma = new PrismaClient();

  try {
    const profileIds = await resolveCopyProfileIds(prisma, options.copyProfileId);
    if (profileIds.length === 0) {
      process.stdout.write(
        JSON.stringify(
          {
            mode: options.apply ? "apply" : "dry-run",
            copyProfileId: options.copyProfileId ?? null,
            profiles: 0,
            allocationsProcessed: 0,
            ledgerRows: 0,
            pnlRows: 0
          },
          null,
          2
        ) + "\n"
      );
      return;
    }

    const allocations = await loadAllocations(prisma, profileIds);
    const rebuild = rebuildLedgerFromAllocations(allocations);

    if (options.apply) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`
            DELETE FROM "LeaderTokenLedger"
            WHERE "copyProfileId" IN (${Prisma.join(profileIds)})
          `
        );
        await tx.$executeRaw(
          Prisma.sql`
            DELETE FROM "LeaderPnlSummary"
            WHERE "copyProfileId" IN (${Prisma.join(profileIds)})
          `
        );

        if (rebuild.ledgerRows.length > 0) {
          for (const row of rebuild.ledgerRows) {
            await tx.$executeRaw(
              Prisma.sql`
                INSERT INTO "LeaderTokenLedger" (
                  "id",
                  "copyProfileId",
                  "leaderId",
                  "tokenId",
                  "marketId",
                  "shares",
                  "costUsd",
                  "createdAt",
                  "updatedAt"
                )
                VALUES (
                  ${randomUUID()},
                  ${row.copyProfileId},
                  ${row.leaderId},
                  ${row.tokenId},
                  ${row.marketId ?? null},
                  ${String(roundTo(row.shares, 18))},
                  ${String(roundTo(row.costUsd, 8))},
                  NOW(),
                  NOW()
                )
              `
            );
          }
        }

        if (rebuild.pnlRows.length > 0) {
          for (const row of rebuild.pnlRows) {
            await tx.$executeRaw(
              Prisma.sql`
                INSERT INTO "LeaderPnlSummary" (
                  "id",
                  "copyProfileId",
                  "leaderId",
                  "realizedPnlUsd",
                  "createdAt",
                  "updatedAt"
                )
                VALUES (
                  ${randomUUID()},
                  ${row.copyProfileId},
                  ${row.leaderId},
                  ${String(roundTo(row.realizedPnlUsd, 8))},
                  NOW(),
                  NOW()
                )
              `
            );
          }
        }
      });
    }

    process.stdout.write(
      JSON.stringify(
        {
          mode: options.apply ? "apply" : "dry-run",
          copyProfileId: options.copyProfileId ?? null,
          profiles: profileIds.length,
          allocationsProcessed: allocations.length,
          ledgerRows: rebuild.ledgerRows.length,
          pnlRows: rebuild.pnlRows.length
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function resolveCopyProfileIds(prisma: PrismaClient, copyProfileId: string | undefined): Promise<string[]> {
  if (copyProfileId) {
    const profile = await prisma.copyProfile.findUnique({
      where: {
        id: copyProfileId
      },
      select: {
        id: true
      }
    });
    return profile ? [profile.id] : [];
  }

  const profiles = await prisma.copyProfile.findMany({
    select: {
      id: true
    }
  });
  return profiles.map((profile) => profile.id);
}

async function loadAllocations(prisma: PrismaClient, copyProfileIds: string[]): Promise<AllocationRow[]> {
  const rows = await prisma.copyFillAllocation.findMany({
    where: {
      leaderId: {
        not: null
      },
      copyOrder: {
        copyProfileId: {
          in: copyProfileIds
        }
      }
    },
    orderBy: [{ allocatedAt: "asc" }, { id: "asc" }],
    select: {
      leaderId: true,
      tokenId: true,
      sharesDelta: true,
      usdcDelta: true,
      feeUsdcDelta: true,
      copyOrder: {
        select: {
          copyProfileId: true,
          marketId: true
        }
      }
    }
  });

  return rows
    .filter((row): row is typeof row & { leaderId: string } => Boolean(row.leaderId))
    .map((row) => ({
      copyProfileId: row.copyOrder.copyProfileId,
      leaderId: row.leaderId,
      tokenId: row.tokenId,
      marketId: row.copyOrder.marketId ?? undefined,
      sharesDelta: Number(row.sharesDelta),
      usdcDelta: Number(row.usdcDelta),
      feeUsdcDelta: Number(row.feeUsdcDelta)
    }));
}

function rebuildLedgerFromAllocations(allocations: AllocationRow[]): {
  ledgerRows: LedgerState[];
  pnlRows: Array<{ copyProfileId: string; leaderId: string; realizedPnlUsd: number }>;
} {
  const ledger = new Map<string, LedgerState>();
  const realizedByProfileLeader = new Map<string, number>();

  for (const row of allocations) {
    const ledgerKey = `${row.copyProfileId}|${row.leaderId}|${row.tokenId}`;
    const state =
      ledger.get(ledgerKey) ??
      ({
        copyProfileId: row.copyProfileId,
        leaderId: row.leaderId,
        tokenId: row.tokenId,
        marketId: row.marketId,
        shares: 0,
        costUsd: 0
      } satisfies LedgerState);

    if (row.marketId) {
      state.marketId = row.marketId;
    }

    if (row.sharesDelta > 0) {
      const buyShares = row.sharesDelta;
      const buyCostUsd = Math.max(-(row.usdcDelta + row.feeUsdcDelta), 0);
      state.shares = roundTo(state.shares + buyShares, 18);
      state.costUsd = roundTo(state.costUsd + buyCostUsd, 8);
      ledger.set(ledgerKey, state);
      continue;
    }

    if (row.sharesDelta < 0 && state.shares > 0) {
      const requestedSellShares = Math.abs(row.sharesDelta);
      const executedSellShares = Math.min(requestedSellShares, state.shares);
      if (executedSellShares <= 0) {
        ledger.set(ledgerKey, state);
        continue;
      }

      const executionRatio = requestedSellShares > 0 ? executedSellShares / requestedSellShares : 0;
      const proceedsUsd = (row.usdcDelta + row.feeUsdcDelta) * executionRatio;
      const avgCostPerShare = state.shares > 0 ? state.costUsd / state.shares : 0;
      const costReleased = avgCostPerShare * executedSellShares;
      const realizedPnlUsd = proceedsUsd - costReleased;

      state.shares = roundTo(Math.max(state.shares - executedSellShares, 0), 18);
      state.costUsd = roundTo(Math.max(state.costUsd - costReleased, 0), 8);
      ledger.set(ledgerKey, state);

      const pnlKey = `${row.copyProfileId}|${row.leaderId}`;
      realizedByProfileLeader.set(pnlKey, roundTo((realizedByProfileLeader.get(pnlKey) ?? 0) + realizedPnlUsd, 8));
    }
  }

  const ledgerRows = [...ledger.values()]
    .filter((row) => row.shares > 0 || row.costUsd > 0)
    .sort((a, b) => {
      if (a.copyProfileId !== b.copyProfileId) {
        return a.copyProfileId.localeCompare(b.copyProfileId);
      }
      if (a.leaderId !== b.leaderId) {
        return a.leaderId.localeCompare(b.leaderId);
      }
      return a.tokenId.localeCompare(b.tokenId);
    });

  const pnlRows = [...realizedByProfileLeader.entries()]
    .map(([key, realizedPnlUsd]): { copyProfileId: string; leaderId: string; realizedPnlUsd: number } | null => {
      const [copyProfileId, leaderId] = key.split("|");
      if (!copyProfileId || !leaderId) {
        return null;
      }
      return {
        copyProfileId,
        leaderId,
        realizedPnlUsd
      };
    })
    .filter((row): row is { copyProfileId: string; leaderId: string; realizedPnlUsd: number } => row !== null)
    .sort((a, b) => {
      if (a.copyProfileId !== b.copyProfileId) {
        return a.copyProfileId.localeCompare(b.copyProfileId);
      }
      return a.leaderId.localeCompare(b.leaderId);
    });

  return {
    ledgerRows,
    pnlRows
  };
}

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2);
  let apply = false;
  let copyProfileId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value) {
      continue;
    }

    if (value === "--apply") {
      apply = true;
      continue;
    }
    if (value === "--dry-run") {
      apply = false;
      continue;
    }
    if (value === "--copy-profile-id") {
      const raw = args[index + 1];
      if (!raw || raw.trim().length === 0) {
        throw new Error("--copy-profile-id requires a value");
      }
      copyProfileId = raw.trim();
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  return {
    apply,
    copyProfileId
  };
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
