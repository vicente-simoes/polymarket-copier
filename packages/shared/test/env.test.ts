import assert from "node:assert/strict";
import test from "node:test";
import { parseWorkerEnv } from "../src/env.js";

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

test("parseWorkerEnv normalizes private-key and chain-id aliases to canonical fields", () => {
  const env = parseWorkerEnv(
    makeEnv({
      FOLLOWER_PRIVATE_KEY: "0x" + "1".repeat(64),
      CHAIN_ID: "80002",
      POLYMARKET_SIGNATURE_TYPE: "1"
    })
  );

  assert.equal(env.POLYMARKET_FOLLOWER_PRIVATE_KEY, "0x" + "1".repeat(64));
  assert.equal(env.POLYMARKET_CHAIN_ID, 80002);
  assert.equal(env.POLYMARKET_SIGNATURE_TYPE, "POLY_PROXY");
});

test("parseWorkerEnv keeps canonical values when aliases are also present", () => {
  const env = parseWorkerEnv(
    makeEnv({
      POLYMARKET_FOLLOWER_PRIVATE_KEY: "0x" + "a".repeat(64),
      FOLLOWER_PRIVATE_KEY: "0x" + "b".repeat(64),
      PRIVATE_KEY: "0x" + "c".repeat(64),
      POLYMARKET_CHAIN_ID: "137",
      CHAIN_ID: "80002",
      POLYMARKET_FUNDER_ADDRESS: " 0x" + "d".repeat(40) + " "
    })
  );

  assert.equal(env.POLYMARKET_FOLLOWER_PRIVATE_KEY, "0x" + "a".repeat(64));
  assert.equal(env.POLYMARKET_CHAIN_ID, 137);
  assert.equal(env.POLYMARKET_FUNDER_ADDRESS, "0x" + "d".repeat(40));
});

test("parseWorkerEnv supports optional MAX_PRICE_PER_SHARE_USD", () => {
  const enabled = parseWorkerEnv(
    makeEnv({
      MAX_PRICE_PER_SHARE_USD: "0.65"
    })
  );
  assert.equal(enabled.MAX_PRICE_PER_SHARE_USD, 0.65);

  const disabled = parseWorkerEnv(
    makeEnv({
      MAX_PRICE_PER_SHARE_USD: ""
    })
  );
  assert.equal(disabled.MAX_PRICE_PER_SHARE_USD, undefined);
});
