import {
  Chain as ClobChain,
  ClobClient as PolymarketClobClient,
  OrderType as ClobOrderType,
  Side as ClobSide,
  type ApiKeyCreds,
  type CreateOrderOptions,
  type UserMarketOrder
} from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type { ExecutionOrderRequest, ExecutionOrderResult, ExecutionVenueClient } from "./types.js";

type ClobTickSize = NonNullable<CreateOrderOptions["tickSize"]>;

interface ClobSdkClient {
  createAndPostMarketOrder(
    userMarketOrder: UserMarketOrder,
    options?: Partial<CreateOrderOptions>,
    orderType?: ClobOrderType
  ): Promise<unknown>;
}

interface ClobSdkClientFactoryInput {
  baseUrl: string;
  chainId: 137 | 80002;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  creds: ApiKeyCreds;
}

type ClobSdkClientFactory = (input: ClobSdkClientFactoryInput) => ClobSdkClient;

export interface ClobExecutionClientOptions {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  passphrase: string;
  privateKey?: string;
  chainId?: 137 | 80002;
  signatureType?: number;
  funderAddress?: string;
  sdkClientFactory?: ClobSdkClientFactory;
}

export class ClobExecutionClient implements ExecutionVenueClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly passphrase: string;
  private readonly privateKey?: string;
  private readonly signerAddress?: string;
  private readonly chainId?: 137 | 80002;
  private readonly signatureType?: number;
  private readonly funderAddress?: string;
  private readonly sdkClientFactory: ClobSdkClientFactory;
  private sdkClient?: ClobSdkClient;

  constructor(options: ClobExecutionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.passphrase = options.passphrase;
    this.privateKey = options.privateKey;
    this.signerAddress = deriveSignerAddress(options.privateKey);
    this.chainId = options.chainId;
    this.signatureType = options.signatureType;
    this.funderAddress = options.funderAddress;
    this.sdkClientFactory = options.sdkClientFactory ?? defaultSdkClientFactory;
  }

  async createAndSubmitOrder(input: ExecutionOrderRequest): Promise<ExecutionOrderResult> {
    if (input.orderType !== "FAK") {
      throw new Error(`Unsupported order type for ClobExecutionClient: ${input.orderType}`);
    }

    if (input.side === "BUY" && input.amountKind !== "USD") {
      throw new Error(`BUY FAK orders must use amountKind=USD (received ${input.amountKind})`);
    }
    if (input.side === "SELL" && input.amountKind !== "SHARES") {
      throw new Error(`SELL FAK orders must use amountKind=SHARES (received ${input.amountKind})`);
    }

    const sdkClient = this.getSdkClient();
    const tickSize = toClobTickSize(input.tickSize);
    const userMarketOrder: UserMarketOrder = {
      tokenID: input.tokenId,
      side: input.side === "BUY" ? ClobSide.BUY : ClobSide.SELL,
      amount: input.amount,
      price: input.priceLimit
    };

    let responsePayload: unknown;
    try {
      responsePayload = await sdkClient.createAndPostMarketOrder(
        userMarketOrder,
        {
          tickSize,
          negRisk: input.negRisk
        },
        ClobOrderType.FAK
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        appendBalanceAllowanceHint(`CLOB order submit failed: ${message}`, {
          signatureType: this.signatureType,
          funderAddress: this.funderAddress,
          signerAddress: this.signerAddress
        })
      );
    }

    if (isErrorResponse(responsePayload)) {
      const message = extractSubmitErrorMessage(responsePayload) ?? stringifyPayload(responsePayload);
      throw new Error(
        appendBalanceAllowanceHint(`CLOB order submit failed: ${message}`, {
          signatureType: this.signatureType,
          funderAddress: this.funderAddress,
          signerAddress: this.signerAddress
        })
      );
    }

    const payload = unwrapResponsePayload(responsePayload);
    const externalOrderId =
      readString(payload, "orderID") ??
      readString(payload, "order_id") ??
      readString(payload, "id");
    const status = normalizeOrderStatus(readString(payload, "status"));

    if (!externalOrderId && status !== "FILLED" && status !== "PARTIALLY_FILLED") {
      throw new Error(`CLOB order submit failed: missing order id in response: ${stringifyPayload(responsePayload)}`);
    }

    return {
      externalOrderId,
      status,
      responsePayload: toRecord(responsePayload)
    };
  }

  private getSdkClient(): ClobSdkClient {
    if (this.sdkClient) {
      return this.sdkClient;
    }

    if (!this.privateKey || !this.chainId || this.signatureType === undefined) {
      throw new Error(
        "CLOB execution signing is not configured. Set POLYMARKET_FOLLOWER_PRIVATE_KEY, POLYMARKET_CHAIN_ID, and POLYMARKET_SIGNATURE_TYPE."
      );
    }

    this.sdkClient = this.sdkClientFactory({
      baseUrl: this.baseUrl,
      chainId: this.chainId,
      privateKey: this.privateKey,
      signatureType: this.signatureType,
      funderAddress: this.funderAddress,
      creds: {
        key: this.apiKey,
        secret: this.apiSecret,
        passphrase: this.passphrase
      }
    });

    return this.sdkClient;
  }
}

function defaultSdkClientFactory(input: ClobSdkClientFactoryInput): ClobSdkClient {
  const signer = new Wallet(input.privateKey);
  return new PolymarketClobClient(
    input.baseUrl,
    input.chainId === 137 ? ClobChain.POLYGON : ClobChain.AMOY,
    signer,
    input.creds,
    input.signatureType,
    input.funderAddress
  );
}

function toClobTickSize(value: number): ClobTickSize {
  if (Number.isFinite(value)) {
    if (Math.abs(value - 0.1) < 1e-12) {
      return "0.1";
    }
    if (Math.abs(value - 0.01) < 1e-12) {
      return "0.01";
    }
    if (Math.abs(value - 0.001) < 1e-12) {
      return "0.001";
    }
    if (Math.abs(value - 0.0001) < 1e-12) {
      return "0.0001";
    }
  }

  throw new Error(
    `Unsupported CLOB tick size ${value}. Supported values: 0.1, 0.01, 0.001, 0.0001.`
  );
}

function isErrorResponse(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const normalized = unwrapResponsePayload(payload);
  const success = normalized.success;
  if (success === false) {
    return true;
  }

  const error = normalized.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return true;
  }

  const status = normalized.status;
  if (typeof status === "number" && status >= 400) {
    return true;
  }

  return false;
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

function deriveSignerAddress(privateKey: string | undefined): string | undefined {
  if (!privateKey) {
    return undefined;
  }

  try {
    return new Wallet(privateKey).address;
  } catch {
    return undefined;
  }
}

function extractSubmitErrorMessage(payload: unknown): string | undefined {
  const record = unwrapResponsePayload(payload);
  return (
    readString(record, "error") ??
    readString(record, "errorMsg") ??
    readString(record, "message") ??
    readString(record, "detail")
  );
}

function appendBalanceAllowanceHint(
  message: string,
  context: {
    signatureType?: number;
    funderAddress?: string;
    signerAddress?: string;
  }
): string {
  const normalized = message.toLowerCase();
  if (!normalized.includes("balance") && !normalized.includes("allowance")) {
    return message;
  }

  if (context.signatureType === 0 && !context.funderAddress) {
    return (
      message +
      " (check POLYMARKET_SIGNATURE_TYPE/POLYMARKET_FUNDER_ADDRESS; proxy or safe accounts usually require POLY_PROXY or POLY_GNOSIS_SAFE with funder set to your Polymarket profile address)"
    );
  }

  if (context.funderAddress) {
    return `${message} (check USDC balance/allowance on funder ${context.funderAddress})`;
  }

  if (context.signerAddress) {
    return `${message} (check USDC balance/allowance on signer ${context.signerAddress})`;
  }

  return message;
}

function toRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload as Record<string, unknown>;
}

function unwrapResponsePayload(payload: unknown): Record<string, unknown> {
  const top = toRecord(payload);
  const nested = top.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return top;
}
