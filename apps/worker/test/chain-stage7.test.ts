import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChainTriggerPipeline, InMemoryTriggerDeduper, encodeAddressTopic } from "../src/chain/index.js";
import { ORDER_FILLED_TOPIC0, ORDERS_MATCHED_TOPIC0, type ChainTriggerStore } from "../src/chain/index.js";

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }
}

class FakeChainStore implements ChainTriggerStore {
  wallets: Array<{ leaderId: string; walletAddress: string }> = [];
  persisted: Array<{ triggerId: string; side: string; tokenId: string; price: string }> = [];
  rollbacks: Array<{ triggerId: string; leaderId: string; tokenId: string }> = [];
  reconcileTasks: Array<{ triggerId: string; leaderId: string; tokenId: string }> = [];
  errors: Array<{ message: string; context: Record<string, unknown> }> = [];

  async listActiveLeaderWallets(): Promise<Array<{ leaderId: string; walletAddress: string }>> {
    return this.wallets;
  }

  async persistChainTrigger(trigger: {
    triggerId: string;
    side: "BUY" | "SELL";
    tokenId: string;
    price: string;
  }): Promise<void> {
    this.persisted.push({
      triggerId: trigger.triggerId,
      side: trigger.side,
      tokenId: trigger.tokenId,
      price: trigger.price
    });
  }

  async markTriggerRollback(args: {
    triggerId: string;
    leaderId: string;
    tokenId: string;
    removedAtMs: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.rollbacks.push({
      triggerId: args.triggerId,
      leaderId: args.leaderId,
      tokenId: args.tokenId
    });
  }

  async recordReconcileTask(task: {
    leaderId: string;
    tokenId: string;
    triggerId: string;
    reason: "CHAIN_REORG";
    enqueuedAtMs: number;
  }): Promise<void> {
    this.reconcileTasks.push({
      triggerId: task.triggerId,
      leaderId: task.leaderId,
      tokenId: task.tokenId
    });
  }

  async recordPipelineError(message: string, context: Record<string, unknown> = {}): Promise<void> {
    this.errors.push({ message, context });
  }
}

test("Stage 7 decodes OrderFilled BUY trigger and dedupes txHash:logIndex", async () => {
  const store = new FakeChainStore();
  const leaderWallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  store.wallets = [{ leaderId: "leader-1", walletAddress: leaderWallet }];

  const pipeline = new ChainTriggerPipeline({
    store,
    deduper: new InMemoryTriggerDeduper(() => 10_000),
    config: {
      enabled: false,
      wsUrl: "wss://alchemy.example",
      exchangeContracts: ["0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"],
      dedupeTtlSeconds: 3600,
      walletRefreshIntervalMs: 30_000,
      reconcileQueueMaxSize: 100
    },
    now: () => 10_000
  });

  await pipeline.refreshLeaderWalletDirectory();

  const payload = buildLogNotification({
    topic0: ORDER_FILLED_TOPIC0,
    txHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    logIndex: 1,
    makerAddress: leaderWallet,
    eventDataSlots: [0n, 123n, 2_000_000n, 4_000_000n, 10_000n]
  });

  await pipeline.processNotification(payload, 10_000);
  await pipeline.processNotification(payload, 10_000);

  assert.equal(store.persisted.length, 1);
  assert.equal(store.persisted[0]?.side, "BUY");
  assert.equal(store.persisted[0]?.tokenId, "123");
  assert.equal(store.persisted[0]?.price, "0.5");
  assert.equal(store.rollbacks.length, 0);

  const status = pipeline.getStatus();
  assert.equal(status.persistedTriggers, 1);
  assert.equal(status.duplicateTriggers, 1);
  assert.equal(status.lastTriggerLagMs, 0);
  assert.equal(status.lastDetectLagMs, 0);
});

test("Stage 7 handles OrdersMatched SELL and removed=true reorg rollback queueing", async () => {
  const store = new FakeChainStore();
  const leaderWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  store.wallets = [{ leaderId: "leader-2", walletAddress: leaderWallet }];

  let nowMs = 20_000;
  const pipeline = new ChainTriggerPipeline({
    store,
    deduper: new InMemoryTriggerDeduper(() => nowMs),
    config: {
      enabled: false,
      wsUrl: "wss://alchemy.example",
      exchangeContracts: ["0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"],
      dedupeTtlSeconds: 3600,
      walletRefreshIntervalMs: 30_000,
      reconcileQueueMaxSize: 100
    },
    now: () => nowMs
  });

  await pipeline.refreshLeaderWalletDirectory();

  const basePayload = buildLogNotification({
    topic0: ORDERS_MATCHED_TOPIC0,
    txHash: "0x2222222222222222222222222222222222222222222222222222222222222222",
    logIndex: 2,
    makerAddress: leaderWallet,
    eventDataSlots: [999n, 0n, 5_000_000n, 2_500_000n]
  });

  await pipeline.processNotification(basePayload, nowMs);

  nowMs += 1_000;
  const removedPayload = {
    ...basePayload,
    params: {
      ...basePayload.params,
      result: {
        ...basePayload.params.result,
        removed: true
      }
    }
  };
  await pipeline.processNotification(removedPayload, nowMs);

  assert.equal(store.persisted.length, 1);
  assert.equal(store.persisted[0]?.side, "SELL");
  assert.equal(store.persisted[0]?.tokenId, "999");
  assert.equal(store.rollbacks.length, 1);
  assert.equal(store.reconcileTasks.length, 1);
  assert.equal(store.reconcileTasks[0]?.tokenId, "999");

  const status = pipeline.getStatus();
  assert.equal(status.rollbackTriggers, 1);
  assert.equal(status.queueSize, 1);
});

test("Stage 7 subscribes Alchemy logs with leader wallet topic filters", async () => {
  const store = new FakeChainStore();
  const socket = new FakeSocket();
  store.wallets = [
    { leaderId: "l1", walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { leaderId: "l2", walletAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
  ];

  const pipeline = new ChainTriggerPipeline({
    store,
    deduper: new InMemoryTriggerDeduper(() => 30_000),
    config: {
      enabled: true,
      wsUrl: "wss://alchemy.example",
      exchangeContracts: ["0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e"],
      dedupeTtlSeconds: 3600,
      walletRefreshIntervalMs: 30_000,
      reconcileQueueMaxSize: 100
    },
    now: () => 30_000,
    createSocket: () => socket
  });

  await pipeline.start();
  socket.open();

  assert.equal(socket.sent.length, 2);
  const first = JSON.parse(socket.sent[0] ?? "{}") as Record<string, unknown>;
  const second = JSON.parse(socket.sent[1] ?? "{}") as Record<string, unknown>;

  assert.equal(first.method, "eth_subscribe");
  assert.equal(second.method, "eth_subscribe");

  const firstTopics = ((first.params as unknown[])?.[1] as { topics?: unknown[] })?.topics ?? [];
  const secondTopics = ((second.params as unknown[])?.[1] as { topics?: unknown[] })?.topics ?? [];

  assert.equal(firstTopics[0], ORDER_FILLED_TOPIC0);
  assert.equal(secondTopics[0], ORDERS_MATCHED_TOPIC0);
  assert.deepEqual(firstTopics[2], [
    encodeAddressTopic("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    encodeAddressTopic("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  ]);

  pipeline.stop();
});

function buildLogNotification(input: {
  topic0: string;
  txHash: string;
  logIndex: number;
  makerAddress: string;
  eventDataSlots: bigint[];
}): {
  jsonrpc: "2.0";
  method: "eth_subscription";
  params: {
    subscription: string;
    result: {
      address: string;
      blockHash: string;
      blockNumber: string;
      data: string;
      logIndex: string;
      topics: string[];
      transactionHash: string;
      transactionIndex: string;
      removed: false;
    };
  };
} {
  return {
    jsonrpc: "2.0",
    method: "eth_subscription",
    params: {
      subscription: "0xsub",
      result: {
        address: "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
        blockHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        blockNumber: "0x123",
        data: encodeSlots(input.eventDataSlots),
        logIndex: `0x${input.logIndex.toString(16)}`,
        topics: [
          input.topic0,
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          encodeAddressTopic(input.makerAddress),
          "0x000000000000000000000000cccccccccccccccccccccccccccccccccccccccc"
        ],
        transactionHash: input.txHash,
        transactionIndex: "0x0",
        removed: false
      }
    }
  };
}

function encodeSlots(values: bigint[]): string {
  const encoded = values.map((value) => value.toString(16).padStart(64, "0")).join("");
  return `0x${encoded}`;
}
