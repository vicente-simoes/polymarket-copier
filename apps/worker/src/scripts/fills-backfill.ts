import { PrismaClient } from "@copybot/db";
import { parseWorkerEnv } from "@copybot/shared";
import { Wallet } from "ethers";
import { resolvePolymarketSigningConfig } from "../execution/index.js";
import { ClobFillTradeHistoryClient, PrismaFillAttributionStore, runFillBackfill } from "../fills/index.js";

interface CliOptions {
  apply: boolean;
  lookbackDays: number;
  fromMs?: number;
  toMs?: number;
  copyProfileId?: string;
}

async function main(): Promise<void> {
  const env = parseWorkerEnv();
  const options = parseCliOptions(env.FILL_BACKFILL_DEFAULT_LOOKBACK_DAYS);

  const prisma = new PrismaClient();
  await prisma.$connect();

  try {
    const store = new PrismaFillAttributionStore(prisma);
    const signingConfig = resolvePolymarketSigningConfig(env, {
      required: false
    });
    const signerAddress = deriveSignerAddress(signingConfig?.privateKey);
    const result = await runFillBackfill(
      store,
      new ClobFillTradeHistoryClient({
        baseUrl: env.CLOB_REST_BASE_URL,
        chainId: env.POLYMARKET_CHAIN_ID === 80002 ? 80002 : 137,
        creds: {
          key: env.POLYMARKET_API_KEY,
          secret: env.POLYMARKET_API_SECRET,
          passphrase: env.POLYMARKET_PASSPHRASE
        },
        privateKey: signingConfig?.privateKey,
        signatureType: signingConfig?.signatureType,
        funderAddress: signingConfig?.funderAddress
      }),
      [env.POLYMARKET_FUNDER_ADDRESS ?? "", signerAddress ?? ""],
      {
        apply: options.apply,
        lookbackDays: options.lookbackDays,
        fromMs: options.fromMs,
        toMs: options.toMs,
        copyProfileId: options.copyProfileId,
        maxPagesPerAddress: env.LEADER_POLL_MAX_PAGES_PER_LEADER
      }
    );

    const unmatchedRate = result.tradesSeen > 0 ? result.unmatched / result.tradesSeen : 0;
    const matchRate = result.tradesSeen > 0 ? result.matchedOrders / result.tradesSeen : 0;

    process.stdout.write(
      JSON.stringify(
        {
          mode: options.apply ? "apply" : "dry-run",
          lookbackDays: options.lookbackDays,
          fromMs: options.fromMs ?? null,
          toMs: options.toMs ?? null,
          copyProfileId: options.copyProfileId ?? null,
          summary: {
            trades_seen: result.tradesSeen,
            matched_orders: result.matchedOrders,
            fills_inserted: result.fillsInserted,
            duplicates: result.duplicates,
            ambiguous_unmatched: result.ambiguousUnmatched,
            unmatched: result.unmatched,
            match_rate: roundTo(matchRate, 6),
            unmatched_rate: roundTo(unmatchedRate, 6)
          }
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    await prisma.$disconnect();
  }
}

function parseCliOptions(defaultLookbackDays: number): CliOptions {
  let apply = false;
  let lookbackDays = defaultLookbackDays;
  let fromMs: number | undefined;
  let toMs: number | undefined;
  let copyProfileId: string | undefined;

  const args = process.argv.slice(2);
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
    if (value === "--lookback-days") {
      const raw = args[index + 1];
      if (!raw) {
        throw new Error("--lookback-days requires a numeric value");
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --lookback-days value: ${raw}`);
      }
      lookbackDays = Math.trunc(parsed);
      index += 1;
      continue;
    }
    if (value === "--from") {
      const raw = args[index + 1];
      if (!raw) {
        throw new Error("--from requires an ISO timestamp");
      }
      fromMs = parseIsoToMs(raw, "--from");
      index += 1;
      continue;
    }
    if (value === "--to") {
      const raw = args[index + 1];
      if (!raw) {
        throw new Error("--to requires an ISO timestamp");
      }
      toMs = parseIsoToMs(raw, "--to");
      index += 1;
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

  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    throw new Error("--from must be less than or equal to --to");
  }

  return {
    apply,
    lookbackDays,
    fromMs,
    toMs,
    copyProfileId
  };
}

function parseIsoToMs(value: string, optionName: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${optionName} value: ${value}`);
  }
  return Math.trunc(parsed);
}

function deriveSignerAddress(privateKey: string | undefined): string | null {
  if (!privateKey) {
    return null;
  }
  try {
    return new Wallet(privateKey).address;
  } catch {
    return null;
  }
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
