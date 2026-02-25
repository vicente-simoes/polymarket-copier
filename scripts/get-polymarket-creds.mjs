#!/usr/bin/env node

function printUsage() {
  console.log(`Generate Polymarket CLOB L2 credentials (apiKey/secret/passphrase) for the follower account.

Expected env (one of):
  - POLYMARKET_FOLLOWER_PRIVATE_KEY
  - FOLLOWER_PRIVATE_KEY
  - PRIVATE_KEY

Optional env:
  - CLOB_REST_BASE_URL (default: https://clob.polymarket.com)
  - POLYMARKET_CHAIN_ID or CHAIN_ID (default: 137)

Usage:
  pnpm polymarket:creds

Notes:
  - This uses the official Polymarket CLOB client method createOrDeriveApiKey().
  - It prints repo-ready env lines:
      POLYMARKET_API_KEY=...
      POLYMARKET_API_SECRET=...
      POLYMARKET_PASSPHRASE=...
`);
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function parsePositiveInt(raw, fallback) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function mask(value) {
  if (typeof value !== "string" || value.length < 8) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizeCredsShape(creds) {
  if (!creds || typeof creds !== "object") {
    return null;
  }

  const obj = /** @type {Record<string, unknown>} */ (creds);
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : typeof obj.key === "string" ? obj.key : null;
  const secret = typeof obj.secret === "string" ? obj.secret : null;
  const passphrase = typeof obj.passphrase === "string" ? obj.passphrase : null;

  if (!apiKey || !secret || !passphrase) {
    return null;
  }

  return { apiKey, secret, passphrase };
}

async function loadDeps() {
  try {
    const [clobModule, ethersModule] = await Promise.all([
      import("@polymarket/clob-client"),
      import("ethers")
    ]);

    const ClobClient =
      clobModule.ClobClient ??
      clobModule.default?.ClobClient ??
      clobModule.default;
    const Wallet = ethersModule.Wallet ?? ethersModule.default?.Wallet;

    if (!ClobClient || !Wallet) {
      throw new Error("Could not resolve ClobClient and Wallet exports.");
    }

    return { ClobClient, Wallet };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Missing required packages for credential generation.");
    console.error("Install them at the workspace root, then rerun:");
    console.error("  pnpm add -w -D @polymarket/clob-client ethers@5");
    console.error("");
    console.error(`Resolution error: ${message}`);
    process.exit(1);
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const privateKey = firstNonEmpty([
    process.env.POLYMARKET_FOLLOWER_PRIVATE_KEY,
    process.env.FOLLOWER_PRIVATE_KEY,
    process.env.PRIVATE_KEY
  ]);

  if (!privateKey) {
    console.error("Missing follower private key env.");
    console.error("Set one of: POLYMARKET_FOLLOWER_PRIVATE_KEY, FOLLOWER_PRIVATE_KEY, PRIVATE_KEY");
    process.exit(1);
  }

  const host = firstNonEmpty([
    process.env.CLOB_REST_BASE_URL,
    process.env.POLYMARKET_CLOB_HOST
  ]) ?? "https://clob.polymarket.com";

  const chainId = parsePositiveInt(
    firstNonEmpty([process.env.POLYMARKET_CHAIN_ID, process.env.CHAIN_ID]),
    137
  );

  const { ClobClient, Wallet } = await loadDeps();
  const signer = new Wallet(privateKey);

  console.log("Generating/deriving Polymarket CLOB API credentials...");
  console.log(`Host: ${host}`);
  console.log(`Chain ID: ${chainId}`);
  console.log(`Signer: ${signer.address}`);

  let client;
  try {
    client = new ClobClient(host, chainId, signer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("");
    console.error("Failed to construct ClobClient with (host, chainId, signer).");
    console.error("The SDK constructor signature may differ from this script version.");
    console.error(`Constructor error: ${message}`);
    process.exit(1);
  }

  if (typeof client.createOrDeriveApiKey !== "function") {
    console.error("This installed @polymarket/clob-client does not expose createOrDeriveApiKey().");
    console.error("Check the Polymarket docs / SDK version and update the script if needed.");
    process.exit(1);
  }

  let rawCreds;
  try {
    rawCreds = await client.createOrDeriveApiKey();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to create/derive API key from Polymarket.");
    console.error(`Error: ${message}`);
    process.exit(1);
  }

  const creds = normalizeCredsShape(rawCreds);
  if (!creds) {
    console.error("Unexpected credential response shape.");
    console.error(JSON.stringify(rawCreds, null, 2));
    process.exit(1);
  }

  console.log("");
  console.log("Success. Save these in your root .env:");
  console.log(`POLYMARKET_API_KEY=${creds.apiKey}`);
  console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
  console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
  console.log("");
  console.log("Credential summary (masked):");
  console.log(`POLYMARKET_API_KEY=${mask(creds.apiKey)}`);
  console.log(`POLYMARKET_API_SECRET=${mask(creds.secret)}`);
  console.log(`POLYMARKET_PASSPHRASE=${mask(creds.passphrase)}`);
}

void main();
