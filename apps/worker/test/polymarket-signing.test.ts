import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerEnv } from "@copybot/shared";
import { resolvePolymarketSigningConfig } from "../src/execution/polymarket-signing.js";

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/polymarket_copier",
    REDIS_URL: "redis://localhost:6379",
    POLYMARKET_API_KEY: "key",
    POLYMARKET_API_SECRET: "secret",
    POLYMARKET_PASSPHRASE: "passphrase",
    ALCHEMY_WS_URL: "wss://polygon-mainnet.g.alchemy.com/v2/test",
    ...overrides
  };
}

test("resolvePolymarketSigningConfig returns null in observe-only mode without private key", () => {
  const env = parseWorkerEnv(makeEnv());
  const resolved = resolvePolymarketSigningConfig(env, { required: false });
  assert.equal(resolved, null);
});

test("resolvePolymarketSigningConfig fails when execution requires missing private key", () => {
  const env = parseWorkerEnv(makeEnv());

  assert.throws(
    () => resolvePolymarketSigningConfig(env, { required: true }),
    /Missing POLYMARKET_FOLLOWER_PRIVATE_KEY/
  );
});

test("resolvePolymarketSigningConfig accepts EOA signing without funder", () => {
  const env = parseWorkerEnv(
    makeEnv({
      POLYMARKET_FOLLOWER_PRIVATE_KEY: "0x" + "a".repeat(64),
      POLYMARKET_SIGNATURE_TYPE: "EOA",
      POLYMARKET_CHAIN_ID: "137"
    })
  );

  const resolved = resolvePolymarketSigningConfig(env, { required: true });
  assert.ok(resolved);
  assert.equal(resolved?.signatureType, 0);
  assert.equal(resolved?.chainId, 137);
  assert.equal(resolved?.funderAddress, undefined);
});

test("resolvePolymarketSigningConfig requires funder for proxy and safe modes", () => {
  const proxyEnv = parseWorkerEnv(
    makeEnv({
      POLYMARKET_FOLLOWER_PRIVATE_KEY: "0x" + "b".repeat(64),
      POLYMARKET_SIGNATURE_TYPE: "POLY_PROXY"
    })
  );

  assert.throws(
    () => resolvePolymarketSigningConfig(proxyEnv, { required: true }),
    /POLYMARKET_FUNDER_ADDRESS is required/
  );

  const safeEnv = parseWorkerEnv(
    makeEnv({
      POLYMARKET_FOLLOWER_PRIVATE_KEY: "0x" + "c".repeat(64),
      POLYMARKET_SIGNATURE_TYPE: "2",
      POLYMARKET_FUNDER_ADDRESS: "0x" + "d".repeat(40)
    })
  );

  const resolved = resolvePolymarketSigningConfig(safeEnv, { required: true });
  assert.equal(resolved?.signatureType, 2);
  assert.equal(resolved?.funderAddress, "0x" + "d".repeat(40));
});

test("resolvePolymarketSigningConfig rejects unsupported chain id and malformed values", () => {
  const badChainEnv = parseWorkerEnv(
    makeEnv({
      POLYMARKET_FOLLOWER_PRIVATE_KEY: "0x" + "e".repeat(64),
      POLYMARKET_CHAIN_ID: "1"
    })
  );
  assert.throws(
    () => resolvePolymarketSigningConfig(badChainEnv, { required: true }),
    /Unsupported POLYMARKET_CHAIN_ID=1/
  );

  const badKeyEnv = parseWorkerEnv(
    makeEnv({
      POLYMARKET_FOLLOWER_PRIVATE_KEY: "not-a-key"
    })
  );
  assert.throws(
    () => resolvePolymarketSigningConfig(badKeyEnv, { required: true }),
    /Invalid POLYMARKET_FOLLOWER_PRIVATE_KEY format/
  );
});

