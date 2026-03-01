import type { WorkerEnv } from "@copybot/shared";

export type PolymarketSignatureTypeName = WorkerEnv["POLYMARKET_SIGNATURE_TYPE"];

export interface ResolvedPolymarketSigningConfig {
  privateKey: string;
  chainId: 137 | 80002;
  signatureType: number;
  signatureTypeName: PolymarketSignatureTypeName;
  funderAddress?: string;
}

interface ResolvePolymarketSigningConfigOptions {
  required: boolean;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY_RE = /^0x[a-fA-F0-9]{64}$/;

const SIGNATURE_TYPE_MAP: Record<PolymarketSignatureTypeName, number> = {
  EOA: 0,
  POLY_PROXY: 1,
  POLY_GNOSIS_SAFE: 2
};

export function resolvePolymarketSigningConfig(
  env: WorkerEnv,
  options: ResolvePolymarketSigningConfigOptions
): ResolvedPolymarketSigningConfig | null {
  const privateKey = env.POLYMARKET_FOLLOWER_PRIVATE_KEY;
  if (!privateKey) {
    if (options.required) {
      throw new Error(
        "Missing POLYMARKET_FOLLOWER_PRIVATE_KEY (or FOLLOWER_PRIVATE_KEY / PRIVATE_KEY alias). " +
          "Order placement requires an L1 private key for EIP-712 signing."
      );
    }
    return null;
  }

  if (!PRIVATE_KEY_RE.test(privateKey)) {
    throw new Error(
      "Invalid POLYMARKET_FOLLOWER_PRIVATE_KEY format. Expected a 32-byte hex private key (0x + 64 hex chars)."
    );
  }

  if (env.POLYMARKET_CHAIN_ID !== 137 && env.POLYMARKET_CHAIN_ID !== 80002) {
    throw new Error(
      `Unsupported POLYMARKET_CHAIN_ID=${env.POLYMARKET_CHAIN_ID}. Supported values: 137 (Polygon), 80002 (Amoy).`
    );
  }

  const signatureTypeName = env.POLYMARKET_SIGNATURE_TYPE;
  const signatureType = SIGNATURE_TYPE_MAP[signatureTypeName];
  if (signatureType === undefined) {
    throw new Error(
      `Unsupported POLYMARKET_SIGNATURE_TYPE=${String(signatureTypeName)}. ` +
        "Expected EOA, POLY_PROXY, or POLY_GNOSIS_SAFE."
    );
  }

  const needsFunder =
    signatureTypeName === "POLY_PROXY" || signatureTypeName === "POLY_GNOSIS_SAFE";
  const funderAddress = env.POLYMARKET_FUNDER_ADDRESS;

  if (needsFunder && !funderAddress) {
    throw new Error(
      `POLYMARKET_FUNDER_ADDRESS is required when POLYMARKET_SIGNATURE_TYPE=${signatureTypeName}.`
    );
  }

  if (funderAddress && !EVM_ADDRESS_RE.test(funderAddress)) {
    throw new Error(
      "Invalid POLYMARKET_FUNDER_ADDRESS format. Expected an EVM address (0x + 40 hex chars)."
    );
  }

  return {
    privateKey,
    chainId: env.POLYMARKET_CHAIN_ID,
    signatureType,
    signatureTypeName,
    funderAddress
  };
}

