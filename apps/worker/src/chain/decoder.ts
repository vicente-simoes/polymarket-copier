import { parseAlchemyLogNotification, triggerId as buildTriggerId } from "@copybot/shared";
import {
  ORDER_FILLED_TOPIC0,
  ORDERS_MATCHED_TOPIC0,
  type ChainTrigger,
  type ChainTriggerEventName,
  type ChainTriggerSide
} from "./types.js";

const USDC_DECIMALS = 6;
const TOKEN_DECIMALS = 6;

export function decodeChainTrigger(payload: unknown, walletToLeader: Map<string, string>, nowMs: number): ChainTrigger | null {
  const notification = parseAlchemyLogNotification(payload);
  const log = notification.params.result;

  if (!log.transactionHash || !log.logIndex || !log.topics || log.topics.length === 0) {
    return null;
  }

  const topic0 = log.topics[0]?.toLowerCase();
  const event = resolveEventName(topic0);
  if (!event) {
    return null;
  }

  const participant = resolveLeaderParticipant(log.topics, walletToLeader);
  if (!participant) {
    return null;
  }
  const { leaderId, leaderWallet, leaderRole } = participant;

  const dataSlots = decodeDataSlots(log.data, event === "OrderFilled" ? 5 : 4);
  const makerAssetId = dataSlots[0];
  const takerAssetId = dataSlots[1];
  const makerAmountFilled = dataSlots[2];
  const takerAmountFilled = dataSlots[3];
  const fee = event === "OrderFilled" ? dataSlots[4] : 0n;

  if (
    makerAssetId === undefined ||
    takerAssetId === undefined ||
    makerAmountFilled === undefined ||
    takerAmountFilled === undefined ||
    fee === undefined
  ) {
    return null;
  }

  const sideInfo = deriveSide({
    makerAssetId,
    takerAssetId,
    makerAmountFilled,
    takerAmountFilled
  });
  if (!sideInfo) {
    return null;
  }

  const txHash = log.transactionHash.toLowerCase();
  const logIndex = Number(parseHexOrDecimal(log.logIndex));
  const wsReceivedAtMs = nowMs;
  const leaderFillAtMs = resolveLeaderFillAtMs(payload, wsReceivedAtMs);
  const detectedAtMs = nowMs;
  const triggerId = buildTriggerId(txHash, logIndex);
  const side = leaderRole === "maker" ? sideInfo.side : flipSide(sideInfo.side);

  return {
    triggerId,
    chain: "polygon",
    event,
    exchangeContract: log.address.toLowerCase(),
    leaderId,
    leaderWallet,
    leaderRole,
    tokenId: sideInfo.tokenId.toString(),
    side,
    tokenAmountBaseUnits: sideInfo.tokenAmountBaseUnits.toString(),
    usdcAmountBaseUnits: sideInfo.usdcAmountBaseUnits.toString(),
    feeBaseUnits: fee.toString(),
    shares: formatUnits(sideInfo.tokenAmountBaseUnits, TOKEN_DECIMALS),
    notionalUsd: formatUnits(sideInfo.usdcAmountBaseUnits, USDC_DECIMALS),
    price: divideAsDecimal(sideInfo.usdcAmountBaseUnits, sideInfo.tokenAmountBaseUnits, 10),
    transactionHash: txHash,
    logIndex,
    blockNumberHex: log.blockNumber,
    blockHash: log.blockHash,
    leaderFillAtMs,
    wsReceivedAtMs,
    detectedAtMs,
    removed: Boolean(log.removed),
    rawLog: {
      ...log,
      topics: [...log.topics]
    }
  };
}

function resolveLeaderParticipant(
  topics: string[],
  walletToLeader: Map<string, string>
): { leaderId: string; leaderWallet: string; leaderRole: "maker" | "taker" } | null {
  const makerWallet = topics[2] ? decodeAddressTopic(topics[2]) : undefined;
  const takerWallet = topics[3] ? decodeAddressTopic(topics[3]) : undefined;
  const makerLeaderId = makerWallet ? walletToLeader.get(makerWallet) : undefined;
  if (makerLeaderId) {
    return {
      leaderId: makerLeaderId,
      leaderWallet: makerWallet!,
      leaderRole: "maker"
    };
  }

  const takerLeaderId = takerWallet ? walletToLeader.get(takerWallet) : undefined;
  if (takerLeaderId) {
    return {
      leaderId: takerLeaderId,
      leaderWallet: takerWallet!,
      leaderRole: "taker"
    };
  }

  return null;
}

export function encodeAddressTopic(address: string): string {
  const normalized = address.toLowerCase().replace(/^0x/, "");
  return `0x${normalized.padStart(64, "0")}`;
}

function resolveEventName(topic0: string | undefined): ChainTriggerEventName | null {
  if (topic0 === ORDER_FILLED_TOPIC0) {
    return "OrderFilled";
  }

  if (topic0 === ORDERS_MATCHED_TOPIC0) {
    return "OrdersMatched";
  }

  return null;
}

function decodeAddressTopic(topic: string): string {
  const normalized = topic.toLowerCase().replace(/^0x/, "");
  return `0x${normalized.slice(-40)}`;
}

function decodeDataSlots(data: string, expectedSlots: number): bigint[] {
  const normalized = data.replace(/^0x/, "");
  const slots: bigint[] = [];

  for (let index = 0; index < expectedSlots; index += 1) {
    const start = index * 64;
    const end = start + 64;
    const chunk = normalized.slice(start, end);
    if (chunk.length < 64) {
      break;
    }
    slots.push(BigInt(`0x${chunk}`));
  }

  return slots;
}

function parseHexOrDecimal(value: string): bigint {
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return BigInt(value);
  }
  return BigInt(value);
}

function resolveLeaderFillAtMs(payload: unknown, fallbackMs: number): number {
  if (!payload || typeof payload !== "object") {
    return fallbackMs;
  }

  const rawParams = (payload as Record<string, unknown>).params;
  if (!rawParams || typeof rawParams !== "object") {
    return fallbackMs;
  }

  const rawResult = (rawParams as Record<string, unknown>).result;
  if (!rawResult || typeof rawResult !== "object") {
    return fallbackMs;
  }

  const rawTimestamp =
    (rawResult as Record<string, unknown>).blockTimestamp ??
    (rawResult as Record<string, unknown>).timestamp ??
    (rawResult as Record<string, unknown>).timeStamp;

  if (typeof rawTimestamp === "number") {
    return rawTimestamp < 2_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
  }

  if (typeof rawTimestamp === "string" && rawTimestamp.length > 0) {
    try {
      const parsed = parseHexOrDecimal(rawTimestamp);
      const asNumber = Number(parsed);
      if (!Number.isFinite(asNumber)) {
        return fallbackMs;
      }

      return asNumber < 2_000_000_000 ? asNumber * 1000 : asNumber;
    } catch {
      return fallbackMs;
    }
  }

  return fallbackMs;
}

function deriveSide(input: {
  makerAssetId: bigint;
  takerAssetId: bigint;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
}):
  | {
      side: ChainTriggerSide;
      tokenId: bigint;
      tokenAmountBaseUnits: bigint;
      usdcAmountBaseUnits: bigint;
    }
  | null {
  if (input.makerAssetId === 0n && input.takerAssetId !== 0n) {
    return {
      side: "BUY",
      tokenId: input.takerAssetId,
      tokenAmountBaseUnits: input.takerAmountFilled,
      usdcAmountBaseUnits: input.makerAmountFilled
    };
  }

  if (input.takerAssetId === 0n && input.makerAssetId !== 0n) {
    return {
      side: "SELL",
      tokenId: input.makerAssetId,
      tokenAmountBaseUnits: input.makerAmountFilled,
      usdcAmountBaseUnits: input.takerAmountFilled
    };
  }

  return null;
}

function flipSide(side: ChainTriggerSide): ChainTriggerSide {
  return side === "BUY" ? "SELL" : "BUY";
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;
  const sign = negative ? "-" : "";

  if (fraction === 0n) {
    return `${sign}${whole.toString()}`;
  }

  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fractionText}`;
}

function divideAsDecimal(numerator: bigint, denominator: bigint, precision: number): string {
  if (denominator === 0n) {
    return "0";
  }

  const negative = (numerator < 0n) !== (denominator < 0n);
  let remainder = numerator < 0n ? -numerator : numerator;
  const divisor = denominator < 0n ? -denominator : denominator;
  const whole = remainder / divisor;
  remainder %= divisor;

  if (remainder === 0n) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  let fraction = "";
  for (let i = 0; i < precision; i += 1) {
    remainder *= 10n;
    const digit = remainder / divisor;
    remainder %= divisor;
    fraction += digit.toString();
    if (remainder === 0n) {
      break;
    }
  }

  fraction = fraction.replace(/0+$/, "");
  if (fraction.length === 0) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}
