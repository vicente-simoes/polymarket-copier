import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLeaderCurrentPositionsFromDataApiPositions,
  mapFollowerSnapshotRowsToCurrentPositions,
  mergeLeaderLatestTradePriceInputs
} from "../src/current-state/store.js";
import {
  buildLeaderLatestTradePriceInputsFromRows,
  resolveFollowerCurrentPositionSource
} from "../src/current-state/backfill.js";

test("leader current positions collapse repeated tokens into one row", () => {
  const rows = buildLeaderCurrentPositionsFromDataApiPositions([
    {
      proxyWallet: "0x1",
      asset: "token-1",
      conditionId: "market-1",
      size: 2,
      avgPrice: 0.41,
      curPrice: 0.44,
      currentValue: 0.88
    },
    {
      proxyWallet: "0x1",
      asset: "token-1",
      conditionId: "market-1",
      size: 3,
      avgPrice: 0.41,
      curPrice: 0.44,
      currentValue: 1.32
    }
  ]);

  assert.deepEqual(rows, [
    {
      tokenId: "token-1",
      marketId: "market-1",
      shares: 5,
      avgPrice: 0.41,
      currentPrice: 0.44,
      currentValueUsd: 2.2
    }
  ]);
});

test("follower current positions preserve first metadata while summing exposure", () => {
  const rows = mapFollowerSnapshotRowsToCurrentPositions([
    {
      tokenId: "token-2",
      marketId: "market-2",
      outcome: "YES",
      shares: 4,
      costBasisUsd: 1.6,
      currentPrice: 0.5,
      currentValueUsd: 2
    },
    {
      tokenId: "token-2",
      marketId: null,
      outcome: null,
      shares: 1,
      costBasisUsd: 0.4,
      currentPrice: undefined,
      currentValueUsd: 0.5
    }
  ]);

  assert.deepEqual(rows, [
    {
      tokenId: "token-2",
      marketId: "market-2",
      outcome: "YES",
      shares: 5,
      costBasisUsd: 2,
      currentPrice: 0.5,
      currentValueUsd: 2.5
    }
  ]);
});

test("leader latest trade price merge keeps only the newest point per leader/token/side", () => {
  const merged = mergeLeaderLatestTradePriceInputs([
    {
      leaderId: "leader-1",
      tokenId: "token-3",
      side: "BUY",
      price: 0.47,
      leaderFillAtMs: 100,
      source: "DATA_API"
    },
    {
      leaderId: "leader-1",
      tokenId: "token-3",
      side: "BUY",
      price: 0.51,
      leaderFillAtMs: 200,
      source: "CHAIN"
    }
  ]);

  assert.deepEqual(merged, [
    {
      leaderId: "leader-1",
      tokenId: "token-3",
      side: "BUY",
      price: 0.51,
      leaderFillAtMs: 200,
      source: "CHAIN"
    }
  ]);
});

test("latest trade price row backfill normalizes numeric db values", () => {
  const rows = buildLeaderLatestTradePriceInputsFromRows([
    {
      leaderId: "leader-2",
      tokenId: "token-4",
      side: "SELL",
      price: "0.63",
      leaderFillAtMs: "1700000000000",
      source: "DATA_API"
    }
  ]);

  assert.deepEqual(rows, [
    {
      leaderId: "leader-2",
      tokenId: "token-4",
      side: "SELL",
      price: 0.63,
      leaderFillAtMs: 1700000000000,
      source: "DATA_API"
    }
  ]);
});

test("follower current position source resolves data api and fills fallback", () => {
  assert.equal(resolveFollowerCurrentPositionSource({ source: "RECONCILE_DATA_API" }), "DATA_API");
  assert.equal(resolveFollowerCurrentPositionSource({ source: "RECONCILE_FILLS_FALLBACK" }), "RECONCILE_FILLS");
  assert.equal(resolveFollowerCurrentPositionSource(null), "RECONCILE_FILLS");
});
