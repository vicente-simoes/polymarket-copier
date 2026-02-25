import { createHmac } from "node:crypto";
import type { ExecutionOrderRequest, ExecutionOrderResult, ExecutionVenueClient } from "./types.js";

export interface ClobExecutionClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  fetchImpl?: typeof fetch;
}

export class ClobExecutionClient implements ExecutionVenueClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClobExecutionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.passphrase = options.passphrase;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createAndSubmitOrder(input: ExecutionOrderRequest): Promise<ExecutionOrderResult> {
    const unsignedOrder = {
      token_id: input.tokenId,
      market_id: input.marketId,
      side: input.side,
      orderType: input.orderType,
      amount_kind: input.amountKind,
      amount: input.amount,
      price_limit: input.priceLimit,
      tick_size: input.tickSize,
      neg_risk: input.negRisk,
      idempotency_key: input.idempotencyKey,
      created_at_ms: Date.now()
    };

    const signedOrder = {
      ...unsignedOrder,
      signature: this.signOrder(unsignedOrder)
    };

    const requestBody = {
      order: signedOrder,
      owner: this.apiKey,
      orderType: input.orderType,
      postOnly: false
    };

    const response = await this.fetchImpl(new URL("/order", this.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    const responsePayload = await safeJson(response);
    if (!response.ok) {
      throw new Error(`CLOB order submit failed (${response.status}): ${stringifyPayload(responsePayload)}`);
    }

    const externalOrderId = readString(responsePayload, "orderID") ?? readString(responsePayload, "order_id") ?? readString(responsePayload, "id");
    const status = normalizeOrderStatus(readString(responsePayload, "status"));

    return {
      externalOrderId,
      status,
      responsePayload: toRecord(responsePayload)
    };
  }

  private signOrder(order: Record<string, unknown>): string {
    return createHmac("sha256", `${this.apiSecret}:${this.passphrase}`)
      .update(JSON.stringify(order))
      .digest("hex");
  }
}

function normalizeOrderStatus(value: string | undefined): ExecutionOrderResult["status"] {
  if (!value) {
    return "PLACED";
  }

  const normalized = value.toUpperCase();
  if (
    normalized === "PLACED" ||
    normalized === "PARTIALLY_FILLED" ||
    normalized === "FILLED" ||
    normalized === "FAILED" ||
    normalized === "CANCELLED" ||
    normalized === "RETRYING"
  ) {
    return normalized;
  }

  return "PLACED";
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function readString(payload: unknown, key: string): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function stringifyPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return "";
  }

  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function toRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}
