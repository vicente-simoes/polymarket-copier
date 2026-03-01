const KEY_VERSION = "v1";
const SCALE = 6;

export interface CanonicalTradeKeyInput {
  leaderId: string;
  walletAddress?: string | null;
  tokenId: string;
  side: "BUY" | "SELL";
  shares: number | string;
  price: number | string;
  leaderFillAtMs: number;
}

export function buildCanonicalTradeKey(input: CanonicalTradeKeyInput): string {
  const wallet = normalizeLower(input.walletAddress ?? "unknown");
  const tokenId = normalizeLower(input.tokenId);
  const side = input.side.toUpperCase() as "BUY" | "SELL";
  const fillSecond = Math.max(0, Math.floor(input.leaderFillAtMs / 1000));
  const sharesMicros = decimalToScaledInteger(input.shares, SCALE);
  const priceMicros = decimalToScaledInteger(input.price, SCALE);

  return [
    KEY_VERSION,
    input.leaderId,
    wallet,
    tokenId,
    side,
    String(fillSecond),
    sharesMicros.toString(),
    priceMicros.toString()
  ].join(":");
}

function decimalToScaledInteger(value: number | string, scale: number): bigint {
  const scaleFactor = 10n ** BigInt(scale);
  const text = normalizeDecimalInput(value);
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid decimal value for canonical trade key: ${value}`);
  }

  const negative = match[1] === "-";
  const wholePart = BigInt(match[2] ?? "0");
  const rawFraction = match[3] ?? "";
  const padded = `${rawFraction}${"0".repeat(scale + 1)}`.slice(0, scale + 1);
  const baseFraction = padded.slice(0, scale);
  const roundingDigit = padded[scale] ?? "0";

  let scaled = wholePart * scaleFactor + BigInt(baseFraction || "0");
  if (roundingDigit >= "5") {
    scaled += 1n;
  }

  return negative ? -scaled : scaled;
}

function normalizeDecimalInput(value: number | string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid non-finite number for canonical trade key: ${value}`);
    }
    return value.toFixed(12).replace(/\.?0+$/, "") || "0";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid empty decimal string for canonical trade key");
  }

  if (/[eE]/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid decimal string for canonical trade key: ${value}`);
    }
    return parsed.toFixed(12).replace(/\.?0+$/, "") || "0";
  }

  return trimmed;
}

function normalizeLower(value: string): string {
  return value.trim().toLowerCase();
}
