export interface ProfileGuardrailOverrides {
  attemptExpirationSeconds?: number;
  maxWorseningBuyUsd?: number;
  maxWorseningSellUsd?: number;
  buyImprovementGuardEnabled?: boolean;
  maxBuyImprovementBps?: number | null;
  maxSlippageBps?: number;
  maxSpreadUsd?: number;
  maxPricePerShareUsd?: number | null;
  minNotionalPerOrderUsd?: number;
  minBookDepthForSizeEnabled?: boolean;
  cooldownPerMarketSeconds?: number;
  maxRetriesPerAttempt?: number;
  maxOpenOrders?: number | null;
}

export interface ProfileSizingOverrides {
  maxExposurePerLeaderUsd?: number;
  maxExposurePerMarketOutcomeUsd?: number;
  maxHourlyNotionalTurnoverUsd?: number;
  maxDailyNotionalTurnoverUsd?: number;
}

export function readProfileGuardrailOverrides(configValue: unknown): ProfileGuardrailOverrides {
  const config = asObject(configValue);
  const guardrails = asObject(config.guardrails);

  return {
    attemptExpirationSeconds: readPositiveInteger(guardrails.attemptExpirationSeconds),
    maxWorseningBuyUsd: readNonNegativeNumber(guardrails.maxWorseningBuyUsd),
    maxWorseningSellUsd: readNonNegativeNumber(guardrails.maxWorseningSellUsd),
    buyImprovementGuardEnabled: readBoolean(guardrails.buyImprovementGuardEnabled),
    maxBuyImprovementBps: readOptionalPositiveIntegerOverride(guardrails.maxBuyImprovementBps),
    maxSlippageBps: readNonNegativeInteger(guardrails.maxSlippageBps),
    maxSpreadUsd: readNonNegativeNumber(guardrails.maxSpreadUsd),
    maxPricePerShareUsd: readOptionalPositiveNumberOverride(guardrails.maxPricePerShareUsd),
    minNotionalPerOrderUsd: readPositiveNumber(guardrails.minNotionalPerOrderUsd),
    minBookDepthForSizeEnabled: readBoolean(guardrails.minBookDepthForSizeEnabled),
    cooldownPerMarketSeconds: readNonNegativeInteger(guardrails.cooldownPerMarketSeconds),
    maxRetriesPerAttempt: readNonNegativeInteger(guardrails.maxRetriesPerAttempt),
    maxOpenOrders: readOptionalPositiveIntegerOverride(guardrails.maxOpenOrders)
  };
}

export function readProfileSizingOverrides(configValue: unknown): ProfileSizingOverrides {
  const config = asObject(configValue);
  const sizing = asObject(config.sizing);

  return {
    maxExposurePerLeaderUsd: readPositiveNumber(sizing.maxExposurePerLeaderUsd),
    maxExposurePerMarketOutcomeUsd: readPositiveNumber(sizing.maxExposurePerMarketOutcomeUsd),
    maxHourlyNotionalTurnoverUsd: readPositiveNumber(sizing.maxHourlyNotionalTurnoverUsd),
    maxDailyNotionalTurnoverUsd: readPositiveNumber(sizing.maxDailyNotionalTurnoverUsd)
  };
}

export function readCopySystemEnabled(configValue: unknown): boolean | undefined {
  const config = asObject(configValue);
  const masterSwitches = asObject(config.masterSwitches);
  const configured = masterSwitches.copySystemEnabled;
  if (typeof configured === "boolean") {
    return configured;
  }
  return undefined;
}

export function readProfileMaxPriceOverride(configValue: unknown): number | null | undefined {
  return readProfileGuardrailOverrides(configValue).maxPricePerShareUsd;
}

export function readLeaderMaxPriceOverride(settingsValue: unknown): number | null | undefined {
  const settings = asObject(settingsValue);
  return readOptionalPositiveNumberOverride(settings.maxPricePerShareUsd);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
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

function readOptionalPositiveIntegerOverride(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  const parsed = readNumber(value);
  if (parsed === undefined || parsed <= 0 || !Number.isInteger(parsed)) {
    return undefined;
  }
  return parsed;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function readNonNegativeNumber(value: unknown): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined || parsed < 0) {
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

function readPositiveInteger(value: unknown): number | undefined {
  const parsed = readNumber(value);
  if (parsed === undefined || parsed <= 0 || !Number.isInteger(parsed)) {
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
