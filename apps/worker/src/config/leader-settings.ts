export interface ParsedLeaderSettings {
  allowList?: string[];
  denyList?: string[];
  maxExposurePerLeaderUsd?: number;
  maxExposurePerMarketOutcomeUsd?: number;
  maxDailyNotionalTurnoverUsd?: number;
  maxSlippageBps?: number;
  maxPricePerShareUsd?: number | null;
  minNotionalPerOrderUsd?: number;
  minDeltaNotionalUsd?: number;
  minDeltaShares?: number;
}

export function readLeaderSettings(value: unknown): ParsedLeaderSettings {
  const raw = asObject(value);
  return {
    allowList: readStringArray(raw.allowList),
    denyList: readStringArray(raw.denyList),
    maxExposurePerLeaderUsd: readPositiveNumber(raw.maxExposurePerLeaderUsd),
    maxExposurePerMarketOutcomeUsd: readPositiveNumber(raw.maxExposurePerMarketOutcomeUsd),
    maxDailyNotionalTurnoverUsd: readPositiveNumber(raw.maxDailyNotionalTurnoverUsd),
    maxSlippageBps: readNonNegativeInteger(raw.maxSlippageBps),
    maxPricePerShareUsd: readOptionalPositiveNumberOverride(raw.maxPricePerShareUsd),
    minNotionalPerOrderUsd: readPositiveNumber(raw.minNotionalPerOrderUsd),
    minDeltaNotionalUsd: readPositiveNumber(raw.minDeltaNotionalUsd),
    minDeltaShares: readPositiveNumber(raw.minDeltaShares)
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const parsed = [...new Set(value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter((entry) => entry.length > 0))];
  if (parsed.length === 0) {
    return undefined;
  }
  return parsed;
}

function readOptionalPositiveNumberOverride(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  const parsed = readNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function readPositiveNumber(value: unknown): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined || parsed < 0 || !Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
