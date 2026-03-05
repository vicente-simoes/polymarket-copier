import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTokenMetadataObservationFromRow,
  buildTokenMetadataObservationsFromDataApiPositions,
  buildTokenMetadataObservationsFromTradeEvents,
  mergeObservationBatch
} from "../src/token-metadata/store.js";
import { mergeBackfillObservationGroups } from "../src/token-metadata/backfill.js";

test("token metadata observations from positions dedupe repeated tokens without churn", () => {
  const observedAt = new Date("2026-03-05T12:00:00.000Z");
  const observations = buildTokenMetadataObservationsFromDataApiPositions(
    [
      {
        proxyWallet: "0x1",
        asset: "token-1",
        conditionId: "market-1",
        size: 3,
        title: "Fed cuts rates?",
        slug: "fed-cuts-rates",
        eventSlug: "macro-2026",
        outcome: "YES"
      },
      {
        proxyWallet: "0x1",
        asset: "token-1",
        conditionId: "market-1",
        size: 1,
        title: "Fed cuts rates?",
        slug: "fed-cuts-rates",
        eventSlug: "macro-2026",
        outcome: "YES"
      }
    ],
    observedAt
  );

  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0], {
    tokenId: "token-1",
    marketId: "market-1",
    title: "Fed cuts rates?",
    slug: "fed-cuts-rates",
    eventSlug: "macro-2026",
    outcome: "YES",
    firstSeenAt: observedAt,
    lastSeenAt: observedAt
  });
});

test("token metadata observations from trade events cover trade-only tokens", () => {
  const observations = buildTokenMetadataObservationsFromTradeEvents([
    {
      triggerId: "trade-1",
      canonicalKey: "trade-1",
      transactionHash: "0xabc",
      leaderFillAtMs: Date.parse("2026-03-05T12:10:00.000Z"),
      detectedAtMs: Date.parse("2026-03-05T12:10:01.000Z"),
      marketId: "market-2",
      tokenId: "token-2",
      outcome: "NO",
      side: "SELL",
      shares: 2,
      price: 0.44,
      notionalUsd: 0.88,
      payload: {
        source: "DATA_API",
        raw: {
          title: "BTC above 150k?",
          slug: "btc-above-150k",
          eventSlug: "btc-2026"
        }
      }
    }
  ]);

  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.tokenId, "token-2");
  assert.equal(observations[0]?.marketId, "market-2");
  assert.equal(observations[0]?.title, "BTC above 150k?");
  assert.equal(observations[0]?.slug, "btc-above-150k");
  assert.equal(observations[0]?.eventSlug, "btc-2026");
  assert.equal(observations[0]?.outcome, "NO");
});

test("token metadata backfill precedence keeps leader fields and fills missing gaps", () => {
  const leaderPositions = mergeObservationBatch([
    {
      tokenId: "token-3",
      marketId: "market-3",
      title: "Leader title",
      slug: null,
      eventSlug: null,
      outcome: null,
      firstSeenAt: new Date("2026-03-05T10:00:00.000Z"),
      lastSeenAt: new Date("2026-03-05T10:00:00.000Z")
    }
  ]);
  const leaderTrades = mergeObservationBatch([
    {
      tokenId: "token-3",
      marketId: "market-3b",
      title: "Trade title",
      slug: "trade-slug",
      eventSlug: "event-slug",
      outcome: "YES",
      firstSeenAt: new Date("2026-03-05T11:00:00.000Z"),
      lastSeenAt: new Date("2026-03-05T11:00:00.000Z")
    }
  ]);
  const followerPositions = mergeObservationBatch([
    {
      tokenId: "token-3",
      marketId: "market-3c",
      title: "Follower title",
      slug: "follower-slug",
      eventSlug: null,
      outcome: "NO",
      firstSeenAt: new Date("2026-03-05T12:00:00.000Z"),
      lastSeenAt: new Date("2026-03-05T12:00:00.000Z")
    }
  ]);

  const merged = mergeBackfillObservationGroups({
    leaderPositions,
    leaderTrades,
    followerPositions
  });

  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    tokenId: "token-3",
    marketId: "market-3",
    title: "Leader title",
    slug: "trade-slug",
    eventSlug: "event-slug",
    outcome: "YES",
    firstSeenAt: new Date("2026-03-05T10:00:00.000Z"),
    lastSeenAt: new Date("2026-03-05T12:00:00.000Z")
  });
});

test("token metadata row observation rehydrates historical payloads", () => {
  const observation = buildTokenMetadataObservationFromRow({
    tokenId: "token-4",
    marketId: null,
    outcome: null,
    payload: {
      source: "RECONCILE_DATA_API",
      marketTitle: "Will SOL reach 1k?",
      raw: {
        conditionId: "market-4",
        slug: "sol-1k",
        eventSlug: "sol-2026",
        outcome: "YES"
      }
    },
    observedAt: new Date("2026-03-05T13:00:00.000Z")
  });

  assert.deepEqual(observation, {
    tokenId: "token-4",
    marketId: "market-4",
    title: "Will SOL reach 1k?",
    slug: "sol-1k",
    eventSlug: "sol-2026",
    outcome: "YES",
    firstSeenAt: new Date("2026-03-05T13:00:00.000Z"),
    lastSeenAt: new Date("2026-03-05T13:00:00.000Z")
  });
});
