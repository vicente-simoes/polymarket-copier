import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { applyBuyAllocation, applySellAllocation } from "@copybot/shared";
import { allocateAndNormalizeFill, capSellAllocationsByAvailableShares } from "../src/fills/store.js";
import { UserChannelWsClient, parseOrderEvent, parseTradeEvent, type WsLike } from "../src/fills/user-ws.js";

class FakeWs extends EventEmitter implements WsLike {
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

test("Stage 10 user-channel WS client subscribes and parses trade/order messages", async () => {
  const socket = new FakeWs();
  const seenTrades: string[] = [];
  const seenOrders: string[] = [];

  const client = new UserChannelWsClient({
    url: "wss://user.example/ws",
    apiKey: "key",
    apiSecret: "secret",
    passphrase: "pass",
    createSocket: () => socket,
    onTrade: async ({ event }) => {
      seenTrades.push(event.externalTradeId);
    },
    onOrder: async ({ event }) => {
      seenOrders.push(event.externalOrderId);
    }
  });

  client.connect();
  socket.open();

  assert.equal(socket.sent.length, 1);
  const subscribePayload = JSON.parse(socket.sent[0] ?? "{}") as {
    type?: string;
    auth?: { apiKey?: string; secret?: string; passphrase?: string };
  };
  assert.equal(subscribePayload.type, "user");
  assert.equal(subscribePayload.auth?.apiKey, "key");
  assert.equal(subscribePayload.auth?.secret, "secret");
  assert.equal(subscribePayload.auth?.passphrase, "pass");

  socket.message({
    event_type: "trade",
    id: "trade-1",
    asset_id: "token-1",
    market: "market-1",
    side: "BUY",
    size: "2",
    price: "0.51",
    taker_order_id: "order-1",
    timestamp: "1700000000"
  });

  socket.message({
    event_type: "order",
    id: "order-1",
    asset_id: "token-1",
    side: "BUY",
    type: "PLACEMENT",
    timestamp: "1700000001"
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(seenTrades, ["trade-1"]);
  assert.deepEqual(seenOrders, ["order-1"]);
});

test("Stage 10 parsed trade/order payloads expose canonical fields", () => {
  const trade = parseTradeEvent({
    event_type: "trade",
    id: "trade-2",
    asset_id: "token-2",
    market: "market-2",
    side: "SELL",
    size: "3",
    price: "0.42",
    fee_usdc: "0.02",
    maker_orders: [{ order_id: "order-maker-1" }],
    taker_order_id: "order-taker-1",
    timestamp: "1700000100"
  });

  assert.ok(trade);
  assert.equal(trade?.externalTradeId, "trade-2");
  assert.equal(trade?.side, "SELL");
  assert.equal(trade?.filledShares, 3);
  assert.equal(trade?.price, 0.42);
  assert.equal(trade?.feeUsdc, 0.02);
  assert.ok(trade?.externalOrderIds.includes("order-maker-1"));
  assert.ok(trade?.externalOrderIds.includes("order-taker-1"));

  const order = parseOrderEvent({
    event_type: "order",
    id: "order-2",
    side: "BUY",
    original_size: "10",
    size_matched: "10",
    timestamp: "1700000200"
  });
  assert.ok(order);
  assert.equal(order?.orderStatus, "FILLED");
});

test("Stage 10 allocations reconcile and leader PnL can be derived from allocations", () => {
  const weights = {
    leaderA: 0.7,
    leaderB: 0.3
  };

  const buyAllocations = allocateAndNormalizeFill({
    filledShares: 10,
    filledUsdcGross: 5,
    feeUsdc: 0.1,
    weights
  });

  const buyShares = buyAllocations.reduce((sum, allocation) => sum + allocation.shares, 0);
  const buyUsdcNet = buyAllocations.reduce((sum, allocation) => sum + allocation.usdcNet, 0);
  const buyFee = buyAllocations.reduce((sum, allocation) => sum + allocation.feeUsdc, 0);
  assert.ok(Math.abs(buyShares - 10) < 1e-9);
  assert.ok(Math.abs(buyUsdcNet - 4.9) < 1e-8);
  assert.ok(Math.abs(buyFee - 0.1) < 1e-8);

  const ledger = new Map<string, { shares: number; costUsd: number; realizedPnlUsd: number }>();
  for (const allocation of buyAllocations) {
    if (allocation.leaderId === "UNATTRIBUTED") {
      continue;
    }
    const current = ledger.get(allocation.leaderId) ?? { shares: 0, costUsd: 0, realizedPnlUsd: 0 };
    ledger.set(
      allocation.leaderId,
      applyBuyAllocation(current, {
        shares: allocation.shares,
        usdc: allocation.usdcNet,
        feeUsdc: allocation.feeUsdc
      })
    );
  }

  const sellAllocationsRaw = allocateAndNormalizeFill({
    filledShares: 4,
    filledUsdcGross: 2.4,
    feeUsdc: 0.04,
    weights
  });

  const cappedSellAllocations = capSellAllocationsByAvailableShares(sellAllocationsRaw, {
    leaderA: ledger.get("leaderA")?.shares ?? 0,
    leaderB: ledger.get("leaderB")?.shares ?? 0
  });

  const sellShares = cappedSellAllocations.reduce((sum, allocation) => sum + allocation.shares, 0);
  assert.ok(Math.abs(sellShares - 4) < 1e-6);

  let combinedRealized = 0;
  for (const allocation of cappedSellAllocations) {
    if (allocation.leaderId === "UNATTRIBUTED") {
      continue;
    }
    const current = ledger.get(allocation.leaderId) ?? { shares: 0, costUsd: 0, realizedPnlUsd: 0 };
    const next = applySellAllocation(current, {
      shares: allocation.shares,
      usdc: allocation.usdcNet + allocation.feeUsdc,
      feeUsdc: allocation.feeUsdc
    });
    combinedRealized += next.realizedPnlUsd - current.realizedPnlUsd;
    ledger.set(allocation.leaderId, next);
  }

  assert.ok(combinedRealized > 0);
});
