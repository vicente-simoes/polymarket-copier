import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPolymarketMarketPath,
  extractTokenDisplayMetadataFromPayload,
  mergeTokenDisplayMetadata,
  toTokenDisplayMetadataView
} from "../src/index.js";

test("token display metadata extracts leader trade payload fields", () => {
  const metadata = extractTokenDisplayMetadataFromPayload({
    raw: {
      conditionId: "market-1",
      title: "Fed cuts rates?",
      slug: "fed-cuts-rates",
      eventSlug: "macro-2026",
      outcome: "YES"
    }
  });

  assert.deepEqual(metadata, {
    marketId: "market-1",
    title: "Fed cuts rates?",
    slug: "fed-cuts-rates",
    eventSlug: "macro-2026",
    outcome: "YES"
  });
});

test("token display metadata extracts leader position payload fields", () => {
  const metadata = extractTokenDisplayMetadataFromPayload({
    raw: {
      conditionId: "market-2",
      title: "BTC above 150k?",
      slug: "btc-above-150k",
      eventSlug: "btc-2026",
      outcome: "NO"
    }
  });

  assert.equal(metadata.marketId, "market-2");
  assert.equal(metadata.title, "BTC above 150k?");
  assert.equal(metadata.slug, "btc-above-150k");
  assert.equal(metadata.eventSlug, "btc-2026");
  assert.equal(metadata.outcome, "NO");
});

test("token display metadata extracts follower snapshot payload fields", () => {
  const metadata = extractTokenDisplayMetadataFromPayload({
    source: "RECONCILE_DATA_API",
    marketTitle: "Will ETH hit 10k?",
    outcome: "YES",
    raw: {
      conditionId: "market-3"
    }
  });

  assert.equal(metadata.marketId, "market-3");
  assert.equal(metadata.title, "Will ETH hit 10k?");
  assert.equal(metadata.outcome, "YES");
});

test("token display metadata builds market paths from event and market slugs", () => {
  assert.equal(buildPolymarketMarketPath("macro-2026", "fed-cuts-rates"), "macro-2026/fed-cuts-rates");
  assert.equal(buildPolymarketMarketPath("fed-cuts-rates", "fed-cuts-rates"), "fed-cuts-rates");
  assert.equal(buildPolymarketMarketPath(null, "fed-cuts-rates"), "fed-cuts-rates");
});

test("token display metadata merge preserves existing strong fields and fills gaps", () => {
  const existing = {
    tokenId: "token-1",
    marketId: "market-1",
    title: "Leader title",
    slug: null,
    eventSlug: null,
    outcome: null,
    firstSeenAt: new Date("2026-03-05T10:00:00.000Z"),
    lastSeenAt: new Date("2026-03-05T10:00:00.000Z")
  };
  const incoming = {
    tokenId: "token-1",
    marketId: "market-2",
    title: "Follower title",
    slug: "fed-cuts-rates",
    eventSlug: "macro-2026",
    outcome: "YES",
    firstSeenAt: new Date("2026-03-05T09:00:00.000Z"),
    lastSeenAt: new Date("2026-03-05T11:00:00.000Z")
  };

  const merged = mergeTokenDisplayMetadata(existing, incoming);
  assert.equal(merged.marketId, "market-1");
  assert.equal(merged.title, "Leader title");
  assert.equal(merged.slug, "fed-cuts-rates");
  assert.equal(merged.eventSlug, "macro-2026");
  assert.equal(merged.outcome, "YES");
  assert.equal(merged.firstSeenAt.toISOString(), "2026-03-05T09:00:00.000Z");
  assert.equal(merged.lastSeenAt.toISOString(), "2026-03-05T11:00:00.000Z");
});

test("token display metadata view derives marketLabel and marketSlug consistently", () => {
  const view = toTokenDisplayMetadataView({
    marketId: "market-1",
    title: null,
    slug: "fed-cuts-rates",
    eventSlug: "macro-2026",
    outcome: "YES"
  });

  assert.deepEqual(view, {
    marketId: "market-1",
    marketLabel: "fed-cuts-rates",
    marketSlug: "macro-2026/fed-cuts-rates",
    outcome: "YES"
  });
});
