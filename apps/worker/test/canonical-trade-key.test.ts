import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalTradeKey } from "../src/ingestion/canonical-trade-key.js";

test("canonical trade key matches for CHAIN string values and DATA_API numeric values", () => {
  const fromChain = buildCanonicalTradeKey({
    leaderId: "leader-1",
    walletAddress: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdef1234",
    tokenId: "123456789",
    side: "SELL",
    shares: "1570.460000",
    price: "0.6110000000",
    leaderFillAtMs: 1_740_782_340_912
  });

  const fromDataApi = buildCanonicalTradeKey({
    leaderId: "leader-1",
    walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdef1234",
    tokenId: "123456789",
    side: "SELL",
    shares: 1570.46,
    price: 0.611,
    leaderFillAtMs: 1_740_782_340_300
  });

  assert.equal(fromChain, fromDataApi);
});

test("canonical trade key still dedupes without tx hash because key is fingerprint-based", () => {
  const withMissingTx = buildCanonicalTradeKey({
    leaderId: "leader-2",
    walletAddress: "0xwallet",
    tokenId: "token-9",
    side: "BUY",
    shares: 101.24,
    price: 0.611,
    leaderFillAtMs: 1_740_782_340_000
  });

  const fromWs = buildCanonicalTradeKey({
    leaderId: "leader-2",
    walletAddress: "0xwallet",
    tokenId: "token-9",
    side: "BUY",
    shares: "101.240000",
    price: "0.611000",
    leaderFillAtMs: 1_740_782_340_999
  });

  assert.equal(withMissingTx, fromWs);
});

test("canonical trade key is stable across floating-point representation noise", () => {
  const noisy = buildCanonicalTradeKey({
    leaderId: "leader-3",
    walletAddress: "0xwallet",
    tokenId: "token-7",
    side: "BUY",
    shares: 1.2345674999999,
    price: 0.30000000000000004,
    leaderFillAtMs: 1_740_782_340_010
  });

  const clean = buildCanonicalTradeKey({
    leaderId: "leader-3",
    walletAddress: "0xwallet",
    tokenId: "token-7",
    side: "BUY",
    shares: "1.2345675",
    price: "0.3",
    leaderFillAtMs: 1_740_782_340_900
  });

  assert.equal(noisy, clean);
});
