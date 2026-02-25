import { createHash } from "node:crypto";

function canonicalize(input: unknown): string {
  if (input === null) {
    return "null";
  }

  if (typeof input !== "object") {
    return JSON.stringify(input);
  }

  if (Array.isArray(input)) {
    return `[${input.map(canonicalize).join(",")}]`;
  }

  const object = input as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

export function makeIdempotencyKey(namespace: string, payload: unknown): string {
  const canonical = canonicalize(payload);
  const hash = createHash("sha256").update(`${namespace}:${canonical}`).digest("hex");
  return `${namespace}:${hash}`;
}

export function triggerId(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}:${logIndex}`;
}

export function copyDecisionKey(payload: unknown): string {
  return makeIdempotencyKey("copy-decision", payload);
}

export function orderRetryKey(orderIntentId: string, retryNumber: number): string {
  return makeIdempotencyKey("order-retry", {
    orderIntentId,
    retryNumber
  });
}
