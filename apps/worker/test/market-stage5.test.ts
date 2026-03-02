import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ClobRestClient } from "../src/market/rest.js";
import { MarketCache } from "../src/market/cache.js";
import { InMemoryMarketMetadataStore } from "../src/market/redis.js";
import { MarketWsClient, type WsLike } from "../src/market/ws.js";

function makeBook(tokenId: string, bid: number, ask: number) {
  return {
    market: `market-${tokenId}`,
    asset_id: tokenId,
    timestamp: "2023-10-01T12:00:00Z",
    bids: [{ price: String(bid), size: "10" }],
    asks: [{ price: String(ask), size: "10" }],
    min_order_size: "1",
    tick_size: "0.01",
    neg_risk: false
  };
}

function makeParsedBook(tokenId: string, bid: number, ask: number) {
  return {
    market: `market-${tokenId}`,
    asset_id: tokenId,
    timestamp: "2023-10-01T12:00:00Z",
    bids: [{ price: bid, size: 10 }],
    asks: [{ price: ask, size: 10 }],
    min_order_size: 1,
    tick_size: 0.01,
    neg_risk: false
  };
}

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
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

  messageRaw(payload: string): void {
    this.emit("message", payload);
  }

  error(message: string): void {
    this.emit("error", new Error(message));
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ClobRestClient supports /book and /books response parsing", async () => {
  const seen: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const requestUrl = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    seen.push({ url: requestUrl, method, body });

    if (requestUrl.includes("/book?")) {
      return new Response(JSON.stringify(makeBook("tokenA", 0.45, 0.55)), { status: 200 });
    }

    return new Response(
      JSON.stringify({
        books: [makeBook("tokenA", 0.45, 0.55), makeBook("tokenB", 0.47, 0.58)]
      }),
      { status: 200 }
    );
  };

  const client = new ClobRestClient({
    baseUrl: "https://clob.polymarket.com",
    fetchImpl
  });

  const one = await client.fetchBook("tokenA");
  assert.equal(one.asset_id, "tokenA");
  assert.equal(one.tick_size, 0.01);

  const many = await client.fetchBooks(["tokenA", "tokenB"]);
  assert.equal(many.length, 2);
  assert.equal(many[1]?.asset_id, "tokenB");

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.method, "GET");
  assert.equal(seen[1]?.method, "POST");
  assert.match(seen[1]?.body ?? "", /tokenA/);
});

test("ClobRestClient normalizes top-of-book when payload levels are reverse-ordered", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        market: "market-reversed",
        asset_id: "token-reversed",
        timestamp: "2023-10-01T12:00:00Z",
        // Mirrors the ordering observed in live CLOB responses.
        bids: [
          { price: "0.01", size: "100" },
          { price: "0.50", size: "5" },
          { price: "0.49", size: "20" }
        ],
        asks: [
          { price: "0.99", size: "10" },
          { price: "0.52", size: "20" },
          { price: "0.51", size: "15" }
        ],
        min_order_size: "1",
        tick_size: "0.01",
        neg_risk: false
      }),
      { status: 200 }
    );

  const client = new ClobRestClient({
    baseUrl: "https://clob.polymarket.com",
    fetchImpl
  });

  const book = await client.fetchBook("token-reversed");
  assert.equal(book.bids[0]?.price, 0.5);
  assert.equal(book.asks[0]?.price, 0.51);

  const top = client.topOfBook(book);
  assert.equal(top.bestBid, 0.5);
  assert.equal(top.bestAsk, 0.51);
});

test("MarketCache prefers WS price, falls back to REST, and marks stale when refresh fails", async () => {
  let nowMs = 1_000_000;
  let failFetch = false;

  const restClient = {
    async fetchBook(tokenId: string) {
      if (failFetch) {
        throw new Error("network down");
      }
      return {
        ...makeParsedBook(tokenId, 0.4, 0.6),
        market: "market-alpha",
        asset_id: tokenId,
        bids: [{ price: 0.4, size: 20 }],
        asks: [{ price: 0.6, size: 20 }]
      };
    },
    async fetchBooks(tokenIds: string[]) {
      return tokenIds.map((tokenId) => ({
        ...makeParsedBook(tokenId, 0.4, 0.6),
        market: "market-alpha",
        asset_id: tokenId
      }));
    }
  } as ClobRestClient;

  const cache = new MarketCache({
    restClient,
    now: () => nowMs,
    config: {
      metadataTtlMs: 60_000,
      wsPriceTtlMs: 10_000,
      restPriceTtlMs: 30_000,
      redisMetadataTtlSeconds: 1800
    }
  });

  cache.setWatchedTokenIds(["token-1"]);

  const restBacked = await cache.getBookState("token-1");
  assert.equal(restBacked.priceSource, "REST");
  assert.equal(restBacked.isStale, false);
  assert.equal(restBacked.midPrice, 0.5);

  cache.ingestWsPrice({
    tokenId: "token-1",
    bestBid: 0.49,
    bestAsk: 0.51,
    atMs: nowMs
  });

  const wsBacked = await cache.getBookState("token-1");
  assert.equal(wsBacked.priceSource, "WS");
  assert.equal(wsBacked.midPrice, 0.5);

  nowMs += 11_000;
  const fallbackToRest = await cache.getBookState("token-1");
  assert.equal(fallbackToRest.priceSource, "REST");
  assert.equal(fallbackToRest.isStale, false);

  nowMs += 25_000;
  failFetch = true;
  const stale = await cache.getBookState("token-1");
  assert.equal(stale.isStale, true);
  assert.ok(stale.staleReasons.includes("STALE_PRICE") || stale.staleReasons.includes("MISSING_PRICE"));
});

test("MarketCache persists metadata in Redis layer and can hydrate it later", async () => {
  let nowMs = 10_000;
  const redisStore = new InMemoryMarketMetadataStore(() => nowMs);

  const seedCache = new MarketCache({
    restClient: {
      async fetchBook() {
        throw new Error("unused");
      },
      async fetchBooks() {
        throw new Error("unused");
      }
    } as ClobRestClient,
    redisStore,
    now: () => nowMs,
    config: {
      metadataTtlMs: 60_000,
      wsPriceTtlMs: 10_000,
      restPriceTtlMs: 30_000,
      redisMetadataTtlSeconds: 120
    }
  });

  await seedCache.ingestRestBook({
    ...makeParsedBook("token-redis", 0.42, 0.61),
    market: "market-redis",
    asset_id: "token-redis",
    min_order_size: 2,
    tick_size: 0.05,
    neg_risk: true
  });

  const hydratedCache = new MarketCache({
    restClient: {
      async fetchBook() {
        throw new Error("network down");
      },
      async fetchBooks() {
        throw new Error("network down");
      }
    } as ClobRestClient,
    redisStore,
    now: () => nowMs,
    config: {
      metadataTtlMs: 60_000,
      wsPriceTtlMs: 10_000,
      restPriceTtlMs: 30_000,
      redisMetadataTtlSeconds: 120
    }
  });

  const state = await hydratedCache.getBookState("token-redis");
  assert.equal(state.tickSize, 0.05);
  assert.equal(state.minOrderSize, 2);
  assert.equal(state.negRisk, true);
  assert.equal(state.isStale, true);
  assert.ok(state.staleReasons.includes("MISSING_PRICE"));
});

test("MarketCache does not treat one-sided WS updates as fresh two-sided prices", async () => {
  let nowMs = 2_000_000;

  const restClient = {
    async fetchBook(tokenId: string) {
      return {
        ...makeParsedBook(tokenId, 0.4, 0.6),
        market: "market-beta",
        asset_id: tokenId
      };
    },
    async fetchBooks(tokenIds: string[]) {
      return tokenIds.map((tokenId) => ({
        ...makeParsedBook(tokenId, 0.4, 0.6),
        market: "market-beta",
        asset_id: tokenId
      }));
    }
  } as ClobRestClient;

  const cache = new MarketCache({
    restClient,
    now: () => nowMs,
    config: {
      metadataTtlMs: 60_000,
      wsPriceTtlMs: 10_000,
      restPriceTtlMs: 30_000,
      redisMetadataTtlSeconds: 1800
    }
  });

  const initial = await cache.getBookState("token-partial");
  assert.equal(initial.priceSource, "REST");

  cache.ingestWsPrice({
    tokenId: "token-partial",
    bestBid: 0.49,
    bestAsk: 0.51,
    atMs: nowMs
  });

  const wsBacked = await cache.getBookState("token-partial");
  assert.equal(wsBacked.priceSource, "WS");

  // Expire the original WS quote, then receive only a one-sided update.
  nowMs += 11_000;
  cache.ingestWsPrice({
    tokenId: "token-partial",
    bestBid: 0.5,
    atMs: nowMs
  });

  // With a one-sided fresh WS update, cache should not surface WS as a fresh two-sided quote.
  const fallback = await cache.getBookState("token-partial");
  assert.equal(fallback.priceSource, "REST");
  assert.equal(fallback.bestBid, 0.4);
  assert.equal(fallback.bestAsk, 0.6);
});

test("MarketCache marks WS spread stale after 5s even when wsPriceTtl is longer", async () => {
  let nowMs = 3_000_000;

  const cache = new MarketCache({
    restClient: {
      async fetchBook(tokenId: string) {
        return {
          ...makeParsedBook(tokenId, 0.4, 0.6),
          market: "market-gamma",
          asset_id: tokenId
        };
      },
      async fetchBooks(tokenIds: string[]) {
        return tokenIds.map((tokenId) => ({
          ...makeParsedBook(tokenId, 0.4, 0.6),
          market: "market-gamma",
          asset_id: tokenId
        }));
      }
    } as ClobRestClient,
    now: () => nowMs,
    config: {
      metadataTtlMs: 60_000,
      wsPriceTtlMs: 15_000,
      restPriceTtlMs: 30_000,
      redisMetadataTtlSeconds: 1800
    }
  });

  cache.ingestWsPrice({
    tokenId: "token-spread-stale",
    bestBid: 0.48,
    bestAsk: 0.52,
    atMs: nowMs
  });

  const live = await cache.getBookState("token-spread-stale", { wsConnected: true });
  assert.equal(live.spreadState, "LIVE");
  assert.ok(Math.abs((live.spreadUsd ?? 0) - 0.04) < 1e-9);

  nowMs += 6_000;
  const stale = await cache.getBookState("token-spread-stale", { wsConnected: true });
  assert.equal(stale.spreadState, "STALE");
  assert.equal(stale.spreadUsd, undefined);
});

test("MarketCache uses REST spread when WS is disconnected", async () => {
  let nowMs = 4_000_000;

  const cache = new MarketCache({
    restClient: {
      async fetchBook(tokenId: string) {
        return {
          ...makeParsedBook(tokenId, 0.11, 0.13),
          market: "market-delta",
          asset_id: tokenId
        };
      },
      async fetchBooks(tokenIds: string[]) {
        return tokenIds.map((tokenId) => ({
          ...makeParsedBook(tokenId, 0.11, 0.13),
          market: "market-delta",
          asset_id: tokenId
        }));
      }
    } as ClobRestClient,
    now: () => nowMs,
    config: {
      metadataTtlMs: 60_000,
      wsPriceTtlMs: 15_000,
      restPriceTtlMs: 30_000,
      redisMetadataTtlSeconds: 1800
    }
  });

  const fallback = await cache.getBookState("token-rest-fallback", { wsConnected: false });
  assert.equal(fallback.priceSource, "REST");
  assert.equal(fallback.spreadState, "LIVE");
  assert.ok(Math.abs((fallback.spreadUsd ?? 0) - 0.02) < 1e-9);
});

test("MarketWsClient subscribes by watched set and processes price/tick updates", async () => {
  const socket = new FakeWs();
  let nowMs = 50_000;
  const seenPrices: Array<{ tokenId: string; bestBid?: number; bestAsk?: number }> = [];
  const seenTicks: Array<{ tokenId: string; tickSize: number }> = [];

  const client = new MarketWsClient({
    url: "wss://market.example/ws",
    now: () => nowMs,
    createSocket: () => socket,
    onPriceUpdate: (update) => {
      seenPrices.push({ tokenId: update.tokenId, bestBid: update.bestBid, bestAsk: update.bestAsk });
    },
    onTickSizeUpdate: (update) => {
      seenTicks.push({ tokenId: update.tokenId, tickSize: update.tickSize });
    }
  });

  client.setWatchedTokenIds(["a", "b"]);
  client.connect();
  socket.open();

  assert.equal(socket.sentMessages.length, 1);
  assert.match(socket.sentMessages[0] ?? "", /"type":"market"/);
  assert.match(socket.sentMessages[0] ?? "", /"assets_ids":\["a","b"\]/);

  client.setWatchedTokenIds(["b", "c"]);
  assert.equal(socket.sentMessages.length, 3);
  assert.match(socket.sentMessages[1] ?? "", /"type":"market"/);
  assert.match(socket.sentMessages[1] ?? "", /"assets_ids":\["a"\]/);
  assert.match(socket.sentMessages[1] ?? "", /"operation":"unsubscribe"/);
  assert.match(socket.sentMessages[2] ?? "", /"type":"market"/);
  assert.match(socket.sentMessages[2] ?? "", /"assets_ids":\["c"\]/);
  assert.match(socket.sentMessages[2] ?? "", /"operation":"subscribe"/);

  socket.messageRaw("PONG");

  nowMs += 1_000;
  socket.message({
    event_type: "price_change",
    timestamp: "1690000000000",
    price_changes: [{ asset_id: "c", best_bid: "0.48", best_ask: "0.52" }]
  });
  assert.equal(seenPrices.length, 1);
  assert.equal(seenPrices[0]?.tokenId, "c");
  assert.equal(seenPrices[0]?.bestBid, 0.48);

  socket.message({
    event_type: "tick_size_change",
    timestamp: "1690000000000",
    tick_size_changes: [{ asset_id: "c", tick_size: "0.01" }]
  });
  assert.equal(seenTicks.length, 1);
  assert.equal(seenTicks[0]?.tokenId, "c");
  assert.equal(seenTicks[0]?.tickSize, 0.01);

  socket.messageRaw(
    JSON.stringify([
      {
        event_type: "price_change",
        timestamp: "1690000001000",
        price_changes: [{ asset_id: "c", best_bid: "0.49", best_ask: "0.53" }]
      },
      {
        event_type: "tick_size_change",
        timestamp: "1690000001000",
        tick_size_changes: [{ asset_id: "c", tick_size: "0.02" }]
      }
    ])
  );
  assert.equal(seenPrices.length, 2);
  assert.equal(seenTicks.length, 2);

  const metricsWhileOpen = client.getMetrics();
  assert.equal(metricsWhileOpen.connected, true);
  assert.equal(metricsWhileOpen.watchedTokenCount, 2);
  assert.equal(metricsWhileOpen.subscribedTokenCount, 2);
  assert.equal(metricsWhileOpen.reconnectCount, 0);
  assert.ok(metricsWhileOpen.lastMessageAtMs);
  assert.equal(metricsWhileOpen.lastError, undefined);

  client.disconnect();
  const metricsAfterClose = client.getMetrics();
  assert.equal(metricsAfterClose.connected, false);
});

test("MarketWsClient reconnects and resubscribes after unexpected close", async () => {
  const sockets: FakeWs[] = [];
  const client = new MarketWsClient({
    url: "wss://market.example/ws",
    createSocket: () => {
      const socket = new FakeWs();
      sockets.push(socket);
      return socket;
    },
    reconnectDelayMs: 5,
    heartbeatIntervalMs: 1_000
  });

  client.setWatchedTokenIds(["token-r1", "token-r2"]);
  client.connect();
  assert.equal(sockets.length, 1);

  sockets[0]?.open();
  assert.equal(sockets[0]?.sentMessages.length, 1);
  assert.match(sockets[0]?.sentMessages[0] ?? "", /"type":"market"/);
  assert.match(sockets[0]?.sentMessages[0] ?? "", /"assets_ids":\["token-r1","token-r2"\]/);

  sockets[0]?.close();
  await wait(20);

  assert.equal(client.getMetrics().reconnectCount, 1);
  assert.equal(sockets.length, 2);
  sockets[1]?.open();
  assert.equal(sockets[1]?.sentMessages.length, 1);
  assert.match(sockets[1]?.sentMessages[0] ?? "", /"type":"market"/);
  assert.match(sockets[1]?.sentMessages[0] ?? "", /"assets_ids":\["token-r1","token-r2"\]/);

  client.disconnect();
});

test("MarketWsClient sends heartbeat pings and stops after disconnect", async () => {
  const socket = new FakeWs();
  const client = new MarketWsClient({
    url: "wss://market.example/ws",
    createSocket: () => socket,
    heartbeatIntervalMs: 5,
    reconnectDelayMs: 50
  });

  client.connect();
  socket.open();
  await wait(25);

  assert.ok(socket.sentMessages.includes("PING"));
  const sentCount = socket.sentMessages.length;

  client.disconnect();
  await wait(20);
  assert.equal(socket.sentMessages.length, sentCount);
});
