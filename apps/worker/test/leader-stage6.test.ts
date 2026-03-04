import assert from "node:assert/strict";
import test from "node:test";
import { DataApiHttpError } from "../src/leader/data-api.js";
import { LeaderPoller } from "../src/leader/poller.js";
import type {
  LeaderDataApiClient,
  LeaderIngestionStore,
  LeaderPollerStatus,
  LeaderRecord,
  NormalizedTradeEvent
} from "../src/leader/types.js";
import type { DataApiPosition, DataApiTrade } from "@copybot/shared";

class FakeStore implements LeaderIngestionStore {
  leaders: LeaderRecord[] = [];
  latestCursorByLeader = new Map<string, number | null>();
  savedWallets: Array<{ leaderId: string; wallets: string[] }> = [];
  savedPositions: Array<{ leaderId: string; positions: DataApiPosition[] }> = [];
  savedTrades: Array<{ leaderId: string; events: NormalizedTradeEvent[] }> = [];
  pollMeta: Array<{ leaderId: string; pollKind: "positions" | "trades"; meta: Record<string, unknown> }> = [];
  failures: Array<{ leaderId: string; pollKind: "positions" | "trades"; message: string }> = [];
  workerStatus: LeaderPollerStatus[] = [];

  async listActiveLeaders(): Promise<LeaderRecord[]> {
    return this.leaders;
  }

  async getLatestDataApiTradeCursorMs(leaderId: string): Promise<number | null> {
    return this.latestCursorByLeader.get(leaderId) ?? null;
  }

  async upsertLeaderWallets(leaderId: string, wallets: string[]): Promise<void> {
    this.savedWallets.push({ leaderId, wallets: [...wallets] });
  }

  async saveLeaderPositionSnapshots(args: {
    leaderId: string;
    snapshotAt: Date;
    snapshotAtMs: number;
    positions: DataApiPosition[];
  }): Promise<number> {
    this.savedPositions.push({ leaderId: args.leaderId, positions: args.positions });
    return args.positions.length;
  }

  async saveLeaderTradeEvents(args: { leaderId: string; events: NormalizedTradeEvent[] }): Promise<number> {
    this.savedTrades.push({ leaderId: args.leaderId, events: args.events });
    return args.events.length;
  }

  async saveLeaderPollMeta(args: {
    leaderId: string;
    pollKind: "positions" | "trades";
    meta: Record<string, unknown>;
  }): Promise<void> {
    this.pollMeta.push(args);
    if (args.pollKind === "trades" && typeof args.meta.cursorMs === "number" && Number.isFinite(args.meta.cursorMs)) {
      this.latestCursorByLeader.set(args.leaderId, Math.floor(args.meta.cursorMs));
    }
  }

  async savePollFailure(args: {
    leaderId: string;
    pollKind: "positions" | "trades";
    message: string;
    retryable: boolean;
    attemptCount: number;
    context?: Record<string, unknown>;
  }): Promise<void> {
    this.failures.push({
      leaderId: args.leaderId,
      pollKind: args.pollKind,
      message: args.message
    });
  }

  async saveWorkerPollStatus(status: LeaderPollerStatus): Promise<void> {
    this.workerStatus.push(status);
  }
}

test("Stage 6 trades poll paginates and ingests only rows at/after cursor", async () => {
  const store = new FakeStore();
  const leader: LeaderRecord = {
    id: "leader-1",
    name: "Leader One",
    profileAddress: "0x111"
  };
  store.leaders = [leader];
  store.latestCursorByLeader.set(leader.id, 1_700_000_001_000);

  const pageCalls: number[] = [];
  const dataApi: LeaderDataApiClient = {
    async fetchTradesPage(args) {
      pageCalls.push(args.offset);
      if (args.offset === 0) {
        return [
          makeTrade({
            timestamp: 1_700_000_003,
            transactionHash: "0xaaa",
            proxyWallet: "0xwallet1"
          }),
          makeTrade({
            timestamp: 1_700_000_001,
            transactionHash: "0xbbb",
            proxyWallet: "0xwallet1"
          })
        ];
      }

      return [
        makeTrade({
          timestamp: 1_700_000_000,
          transactionHash: "0xccc",
          proxyWallet: "0xwallet2"
        })
      ];
    },
    async fetchPositionsPage() {
      return [];
    }
  };

  let nowMs = 1_800_000_000_000;
  const poller = new LeaderPoller({
    dataApi,
    store,
    now: () => nowMs,
    sleep: async () => undefined,
    config: {
      positionsIntervalMs: 60_000,
      tradesIntervalMs: 30_000,
      pageLimit: 2,
      batchSize: 1,
      maxRetries: 2,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
      maxPagesPerLeader: 10,
      tradesTakerOnly: false
    }
  });

  await poller.runTradesPoll();

  assert.deepEqual(pageCalls, [0, 2]);
  assert.equal(store.savedTrades.length, 1);
  const saved = store.savedTrades[0]?.events ?? [];
  assert.equal(saved.length, 2);
  assert.equal(saved[0]?.tokenId, "token-1");
  assert.equal(saved[1]?.tokenId, "token-1");
  assert.ok(saved[0]?.canonicalKey.startsWith("v1:leader-1:"));
  assert.ok(saved[0]?.triggerId.startsWith("data-api:leader-1:"));
  assert.equal(store.savedWallets.length, 1);
  assert.deepEqual(store.savedWallets[0]?.wallets.sort(), ["0xwallet1", "0xwallet2"]);

  const status = poller.getStatus();
  assert.equal(status.trades.totalRuns, 1);
  assert.equal(status.trades.totalFailures, 0);
  assert.equal(status.trades.lastRecordsSeen, 3);
  assert.equal(status.trades.lastRecordsInserted, 2);
});

test("Stage 6 cursor advances from newest seen trade even when dedupe skips inserts", async () => {
  const store = new FakeStore();
  const leader: LeaderRecord = {
    id: "leader-1",
    name: "Leader One",
    profileAddress: "0x111"
  };
  store.leaders = [leader];
  store.latestCursorByLeader.set(leader.id, 1_700_000_001_000);

  const pageCalls: number[] = [];
  let skipInserts = true;
  const dataApi: LeaderDataApiClient = {
    async fetchTradesPage(args) {
      pageCalls.push(args.offset);
      if (args.offset === 0) {
        return [
          makeTrade({ timestamp: 1_700_000_003, transactionHash: "0xaaa" }),
          makeTrade({ timestamp: 1_700_000_002, transactionHash: "0xbbb" })
        ];
      }

      return [
        makeTrade({ timestamp: 1_700_000_000, transactionHash: "0xccc" }),
        makeTrade({ timestamp: 1_699_999_999, transactionHash: "0xddd" })
      ];
    },
    async fetchPositionsPage() {
      return [];
    }
  };

  const originalSaveLeaderTradeEvents = store.saveLeaderTradeEvents.bind(store);
  store.saveLeaderTradeEvents = async (args) => {
    store.savedTrades.push(args);
    return skipInserts ? 0 : args.events.length;
  };

  const poller = new LeaderPoller({
    dataApi,
    store,
    now: () => 1_800_000_000_000,
    sleep: async () => undefined,
    config: {
      positionsIntervalMs: 60_000,
      tradesIntervalMs: 30_000,
      pageLimit: 2,
      batchSize: 1,
      maxRetries: 2,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
      maxPagesPerLeader: 10,
      tradesTakerOnly: false
    }
  });

  await poller.runTradesPoll();
  assert.deepEqual(pageCalls, [0, 2]);
  assert.equal(store.latestCursorByLeader.get(leader.id), 1_700_000_003_000);

  pageCalls.length = 0;
  skipInserts = false;
  await poller.runTradesPoll();
  assert.deepEqual(pageCalls, [0, 2]);

  store.saveLeaderTradeEvents = originalSaveLeaderTradeEvents;
});

test("Stage 6 poller retries throttled requests with backoff", async () => {
  const store = new FakeStore();
  store.leaders = [
    {
      id: "leader-1",
      name: "Leader One",
      profileAddress: "0x111"
    }
  ];

  let attempts = 0;
  const backoffSleeps: number[] = [];

  const dataApi: LeaderDataApiClient = {
    async fetchTradesPage() {
      return [];
    },
    async fetchPositionsPage() {
      attempts += 1;
      if (attempts === 1) {
        throw new DataApiHttpError(429, "throttled");
      }

      return [];
    }
  };

  const poller = new LeaderPoller({
    dataApi,
    store,
    sleep: async (durationMs) => {
      backoffSleeps.push(durationMs);
    },
    config: {
      positionsIntervalMs: 60_000,
      tradesIntervalMs: 30_000,
      pageLimit: 100,
      batchSize: 1,
      maxRetries: 3,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
      maxPagesPerLeader: 2,
      tradesTakerOnly: false
    }
  });

  await poller.runPositionsPoll();

  assert.equal(attempts, 2);
  assert.equal(store.failures.length, 0);
  assert.equal(backoffSleeps.length, 1);
  const status = poller.getStatus();
  assert.equal(status.positions.totalFailures, 0);
  assert.equal(status.positions.consecutiveFailures, 0);
});

test("Stage 6 positions polling interval can be reconfigured at runtime", () => {
  const store = new FakeStore();
  const dataApi: LeaderDataApiClient = {
    async fetchTradesPage() {
      return [];
    },
    async fetchPositionsPage() {
      return [];
    }
  };

  const poller = new LeaderPoller({
    dataApi,
    store,
    config: {
      positionsIntervalMs: 60_000,
      tradesIntervalMs: 30_000,
      pageLimit: 100,
      batchSize: 1,
      maxRetries: 2,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
      maxPagesPerLeader: 1,
      tradesTakerOnly: false
    }
  });

  poller.setPositionsIntervalMs(2_500);
  const config = poller as unknown as { config: { positionsIntervalMs: number } };
  assert.equal(config.config.positionsIntervalMs, 2_500);
});

function makeTrade(overrides: Partial<DataApiTrade>): DataApiTrade {
  return {
    proxyWallet: "0xwallet",
    side: "BUY",
    asset: "token-1",
    conditionId: "market-1",
    size: 1,
    price: 0.55,
    timestamp: 1_700_000_000,
    ...overrides
  };
}
