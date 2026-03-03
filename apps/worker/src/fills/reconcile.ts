import { Chain as ClobChain, ClobClient as PolymarketClobClient, type ApiKeyCreds, type Trade, type TradeParams } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type {
  FillAttributionStore,
  FillBackfillRunInput,
  FillBackfillRunResult,
  FillHistoryTrade,
  FillReconcileServiceDeps,
  FillReconcileStatus,
  FillTradeHistoryClient,
  FillTradeHistoryPage,
  FillSide,
  UserTradeFillEvent
} from "./types.js";

const DEFAULT_MAX_PAGES_PER_ADDRESS = 25;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ClobFillTradeHistoryClientOptions {
  baseUrl: string;
  chainId: 137 | 80002;
  creds: ApiKeyCreds;
  privateKey?: string;
  signatureType?: number;
  funderAddress?: string;
}

export class ClobFillTradeHistoryClient implements FillTradeHistoryClient {
  private readonly client: PolymarketClobClient;

  constructor(options: ClobFillTradeHistoryClientOptions) {
    const signer = options.privateKey ? new Wallet(options.privateKey) : undefined;
    this.client = new PolymarketClobClient(
      options.baseUrl.replace(/\/+$/, ""),
      options.chainId === 137 ? ClobChain.POLYGON : ClobChain.AMOY,
      signer,
      options.creds,
      options.signatureType,
      options.funderAddress
    );
  }

  async fetchTradesPage(args: {
    makerAddress: string;
    afterMs?: number;
    beforeMs?: number;
    nextCursor?: string;
  }): Promise<FillTradeHistoryPage> {
    const params: TradeParams = {
      maker_address: args.makerAddress
    };
    if (args.afterMs !== undefined) {
      params.after = toUnixSecondsString(args.afterMs);
    }
    if (args.beforeMs !== undefined) {
      params.before = toUnixSecondsString(args.beforeMs);
    }

    const page = await this.client.getTradesPaginated(params, args.nextCursor);
    const makerAddress = normalizeAddress(args.makerAddress);
    const trades: FillHistoryTrade[] = [];
    for (const trade of page.trades) {
      const normalized = normalizeTrade(trade, makerAddress);
      if (normalized) {
        trades.push(normalized);
      }
    }

    return {
      trades,
      nextCursor: normalizeCursor(page.next_cursor)
    };
  }
}

export class FillReconcileService {
  private readonly store: FillAttributionStore;
  private readonly tradeClient: FillTradeHistoryClient;
  private readonly config: FillReconcileServiceDeps["config"];
  private readonly preferredMakerAddresses: string[];
  private readonly now: () => number;
  private readonly status: FillReconcileStatus;
  private interval?: NodeJS.Timeout;
  private inFlight = false;

  constructor(deps: FillReconcileServiceDeps) {
    this.store = deps.store;
    this.tradeClient = deps.tradeClient;
    this.config = deps.config;
    this.preferredMakerAddresses = deps.preferredMakerAddresses
      .map((value) => normalizeAddress(value))
      .filter((value): value is string => value !== null);
    this.now = deps.now ?? Date.now;
    this.status = {
      enabled: deps.config.enabled,
      running: false,
      totalRuns: 0,
      totalFailures: 0,
      totalTradesSeen: 0,
      totalMatchedOrders: 0,
      totalFillsInserted: 0,
      totalDuplicates: 0,
      totalUnmatched: 0,
      totalAmbiguousUnmatched: 0,
      lastTradesSeen: 0,
      lastMatchedOrders: 0,
      lastFillsInserted: 0,
      lastDuplicates: 0,
      lastUnmatched: 0,
      lastAmbiguousUnmatched: 0
    };
  }

  start(): void {
    if (!this.config.enabled) {
      return;
    }
    this.interval = setInterval(() => {
      void this.run();
    }, this.config.intervalMs);
    void this.run();
  }

  stop(): void {
    if (!this.interval) {
      return;
    }
    clearInterval(this.interval);
    this.interval = undefined;
  }

  getStatus(): FillReconcileStatus {
    return { ...this.status };
  }

  async run(): Promise<void> {
    if (!this.config.enabled || this.inFlight) {
      return;
    }
    this.inFlight = true;
    this.status.running = true;
    this.status.totalRuns += 1;
    this.status.lastRunAtMs = this.now();
    const startedAtMs = this.now();

    try {
      const result = await runFillIngestion({
        store: this.store,
        tradeClient: this.tradeClient,
        makerAddresses: await listMakerAddresses(this.store, this.preferredMakerAddresses),
        applyWrites: true,
        maxPagesPerAddress: this.config.maxPagesPerAddress,
        afterMsByAddress: await this.loadCheckpointMap()
      });

      const nowMs = this.now();
      for (const [address, cursorAtMs] of Object.entries(result.cursorAtMsByAddress)) {
        await this.store.writeFillReconcileCheckpoint(`maker:${address}`, {
          cursorAtMs,
          updatedAtMs: nowMs
        });
      }

      this.status.lastSuccessAtMs = nowMs;
      this.status.lastError = undefined;
      this.status.lastTradesSeen = result.summary.tradesSeen;
      this.status.lastMatchedOrders = result.summary.matchedOrders;
      this.status.lastFillsInserted = result.summary.fillsInserted;
      this.status.lastDuplicates = result.summary.duplicates;
      this.status.lastUnmatched = result.summary.unmatched;
      this.status.lastAmbiguousUnmatched = result.summary.ambiguousUnmatched;
      this.status.totalTradesSeen += result.summary.tradesSeen;
      this.status.totalMatchedOrders += result.summary.matchedOrders;
      this.status.totalFillsInserted += result.summary.fillsInserted;
      this.status.totalDuplicates += result.summary.duplicates;
      this.status.totalUnmatched += result.summary.unmatched;
      this.status.totalAmbiguousUnmatched += result.summary.ambiguousUnmatched;
    } catch (error) {
      this.status.totalFailures += 1;
      this.status.lastFailureAtMs = this.now();
      this.status.lastError = toErrorMessage(error);
    } finally {
      this.status.running = false;
      this.status.lastDurationMs = this.now() - startedAtMs;
      this.inFlight = false;
    }
  }

  private async loadCheckpointMap(): Promise<Record<string, number>> {
    const addresses = await listMakerAddresses(this.store, this.preferredMakerAddresses);
    const fallbackMs = this.now() - this.config.defaultLookbackDays * MILLIS_PER_DAY;
    const result: Record<string, number> = {};
    for (const address of addresses) {
      const checkpoint = await this.store.readFillReconcileCheckpoint(`maker:${address}`);
      result[address] = checkpoint?.cursorAtMs ?? fallbackMs;
    }
    return result;
  }
}

export async function runFillBackfill(
  store: FillAttributionStore,
  tradeClient: FillTradeHistoryClient,
  preferredMakerAddresses: string[],
  input: FillBackfillRunInput,
  now: () => number = Date.now
): Promise<FillBackfillRunResult> {
  const normalizedPreferred = preferredMakerAddresses
    .map((value) => normalizeAddress(value))
    .filter((value): value is string => value !== null);
  const makerAddresses = await listMakerAddresses(store, normalizedPreferred, input.copyProfileId);
  const lowerBoundMs =
    input.fromMs ??
    (input.toMs !== undefined
      ? input.toMs - input.lookbackDays * MILLIS_PER_DAY
      : now() - input.lookbackDays * MILLIS_PER_DAY);
  const upperBoundMs = input.toMs;

  const result = await runFillIngestion({
    store,
    tradeClient,
    makerAddresses,
    applyWrites: input.apply,
    maxPagesPerAddress: input.maxPagesPerAddress ?? DEFAULT_MAX_PAGES_PER_ADDRESS,
    globalAfterMs: lowerBoundMs,
    globalBeforeMs: upperBoundMs
  });

  return result.summary;
}

async function runFillIngestion(args: {
  store: FillAttributionStore;
  tradeClient: FillTradeHistoryClient;
  makerAddresses: string[];
  applyWrites: boolean;
  maxPagesPerAddress: number;
  afterMsByAddress?: Record<string, number>;
  globalAfterMs?: number;
  globalBeforeMs?: number;
}): Promise<{
  summary: FillBackfillRunResult;
  cursorAtMsByAddress: Record<string, number>;
}> {
  const seenTradeIds = new Set<string>();
  const cursorAtMsByAddress: Record<string, number> = {};
  const summary: FillBackfillRunResult = {
    tradesSeen: 0,
    matchedOrders: 0,
    fillsInserted: 0,
    duplicates: 0,
    unmatched: 0,
    ambiguousUnmatched: 0
  };

  for (const makerAddress of args.makerAddresses) {
    let nextCursor: string | undefined;
    let newestTimestampMs = args.globalAfterMs ?? args.afterMsByAddress?.[makerAddress] ?? 0;

    for (let pageIndex = 0; pageIndex < args.maxPagesPerAddress; pageIndex += 1) {
      const page = await args.tradeClient.fetchTradesPage({
        makerAddress,
        afterMs: args.globalAfterMs ?? args.afterMsByAddress?.[makerAddress],
        beforeMs: args.globalBeforeMs,
        nextCursor
      });
      if (page.trades.length === 0) {
        break;
      }

      for (const trade of page.trades) {
        if (!trade.id || seenTradeIds.has(trade.id)) {
          continue;
        }
        seenTradeIds.add(trade.id);
        summary.tradesSeen += 1;
        const eventTimestampMs = trade.lastUpdateMs ?? trade.matchTimeMs ?? 0;
        if (eventTimestampMs > newestTimestampMs) {
          newestTimestampMs = eventTimestampMs;
        }

        const event = historyTradeToFillEvent(trade);
        const match = await args.store.matchCopyOrderForTrade(event);
        if (!match.order) {
          summary.unmatched += 1;
          if (match.unmatchedReason === "AMBIGUOUS_FALLBACK") {
            summary.ambiguousUnmatched += 1;
          }
          continue;
        }

        summary.matchedOrders += 1;
        if (!args.applyWrites) {
          const exists = await args.store.hasCopyFillByExternalTradeId(event.externalTradeId);
          if (exists) {
            summary.duplicates += 1;
          } else {
            summary.fillsInserted += 1;
          }
          continue;
        }

        const ingest = await args.store.ingestTradeFill({
          order: match.order,
          event
        });
        if (ingest.duplicate) {
          summary.duplicates += 1;
          continue;
        }
        if (ingest.copyFillId) {
          summary.fillsInserted += 1;
        }
      }

      if (!page.nextCursor) {
        break;
      }
      nextCursor = page.nextCursor;
    }

    cursorAtMsByAddress[makerAddress] = newestTimestampMs;
  }

  return {
    summary,
    cursorAtMsByAddress
  };
}

function historyTradeToFillEvent(trade: FillHistoryTrade): UserTradeFillEvent {
  const filledUsdcGross = roundTo(trade.size * trade.price, 8);
  const feeUsdc =
    trade.feeRateBps !== undefined && trade.feeRateBps > 0 ? roundTo((filledUsdcGross * trade.feeRateBps) / 10_000, 8) : 0;
  const timestampMs = trade.matchTimeMs ?? trade.lastUpdateMs ?? Date.now();

  return {
    externalTradeId: trade.id,
    externalOrderIds: [...new Set([...(trade.makerOrderIds ?? []), trade.takerOrderId ?? ""]).values()].filter(Boolean),
    tokenId: trade.tokenId,
    marketId: trade.marketId,
    side: trade.side ?? "BUY",
    filledShares: trade.size,
    price: trade.price,
    filledUsdcGross,
    feeUsdc,
    filledAt: new Date(timestampMs),
    payload: {
      source: "CLOB_REST_TRADES",
      makerAddresses: trade.makerAddresses,
      raw: trade.payload
    }
  };
}

async function listMakerAddresses(
  store: FillAttributionStore,
  preferredMakerAddresses: string[],
  copyProfileId?: string
): Promise<string[]> {
  const fromProfiles = await store.listFollowerAddresses(copyProfileId);
  const merged = [...preferredMakerAddresses, ...fromProfiles]
    .map((value) => normalizeAddress(value))
    .filter((value): value is string => value !== null);
  return [...new Set(merged)];
}

function normalizeTrade(trade: Trade, targetMakerAddress: string | null): FillHistoryTrade | null {
  const tokenId = readString(trade.asset_id);
  const size = readNumber(trade.size);
  const price = readNumber(trade.price);
  if (!tokenId || size === undefined || size <= 0 || price === undefined || price <= 0) {
    return null;
  }

  const makerOrders = Array.isArray(trade.maker_orders) ? trade.maker_orders : [];
  const makerAddresses = makerOrders
    .map((makerOrder) => normalizeAddress(readString(makerOrder.maker_address)))
    .filter((value): value is string => value !== null);
  const matchingMakerOrder =
    targetMakerAddress === null
      ? undefined
      : makerOrders.find((makerOrder) => normalizeAddress(readString(makerOrder.maker_address)) === targetMakerAddress);

  const side = normalizeSide(readString(matchingMakerOrder?.side) ?? readString(trade.side));
  if (!side) {
    return null;
  }

  const makerOrderIds = makerOrders
    .map((makerOrder) => readString(makerOrder.order_id))
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return {
    id: readString(trade.id) ?? "",
    takerOrderId: readString(trade.taker_order_id) ?? undefined,
    makerOrderIds,
    tokenId,
    marketId: readString(trade.market) ?? undefined,
    side,
    size,
    price,
    feeRateBps: readNumber(trade.fee_rate_bps),
    matchTimeMs: parseTradeTimestampMs(readString(trade.match_time)),
    lastUpdateMs: parseTradeTimestampMs(readString(trade.last_update)),
    makerAddresses,
    payload: toRecord(trade)
  };
}

function normalizeSide(value: string | undefined): FillSide | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toUpperCase();
  if (normalized === "BUY" || normalized === "SELL") {
    return normalized;
  }
  return undefined;
}

function parseTradeTimestampMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  if (parsed < 2_000_000_000) {
    return Math.trunc(parsed * 1000);
  }
  return Math.trunc(parsed);
}

function toUnixSecondsString(ms: number): string {
  return String(Math.trunc(ms / 1000));
}

function normalizeCursor(value: string | undefined): string | undefined {
  if (!value || value === "LTE=" || value === "0") {
    return undefined;
  }
  return value;
}

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
    return null;
  }
  if (normalized === "0x0000000000000000000000000000000000000000") {
    return null;
  }
  return normalized;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
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

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
