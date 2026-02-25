import { parseDataApiPosition, parseDataApiTrade, type DataApiPosition, type DataApiTrade } from "@copybot/shared";
import type { DataApiPositionsPageRequest, DataApiTradesPageRequest, LeaderDataApiClient } from "./types.js";

export class DataApiHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Data API request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export function isRetryableDataApiError(error: unknown): boolean {
  if (error instanceof DataApiHttpError) {
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
  }

  if (error instanceof Error) {
    return (
      error.message.includes("fetch failed") ||
      error.message.includes("ECONNRESET") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("ENOTFOUND")
    );
  }

  return false;
}

export interface DataApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class DataApiClient implements LeaderDataApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DataApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchTradesPage(args: DataApiTradesPageRequest): Promise<DataApiTrade[]> {
    const url = new URL("/trades", this.baseUrl);
    url.searchParams.set("user", args.user);
    url.searchParams.set("limit", String(args.limit));
    url.searchParams.set("offset", String(args.offset));
    url.searchParams.set("takerOnly", String(args.takerOnly ?? true));

    const payload = await this.fetchJson(url);
    return this.parseArray(payload, parseDataApiTrade);
  }

  async fetchPositionsPage(args: DataApiPositionsPageRequest): Promise<DataApiPosition[]> {
    const url = new URL("/positions", this.baseUrl);
    url.searchParams.set("user", args.user);
    url.searchParams.set("limit", String(args.limit));
    url.searchParams.set("offset", String(args.offset));
    if (args.sizeThreshold !== undefined) {
      url.searchParams.set("sizeThreshold", String(args.sizeThreshold));
    }
    if (args.sortBy) {
      url.searchParams.set("sortBy", args.sortBy);
    }
    if (args.sortDirection) {
      url.searchParams.set("sortDirection", args.sortDirection);
    }

    const payload = await this.fetchJson(url);
    return this.parseArray(payload, parseDataApiPosition);
  }

  private async fetchJson(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new DataApiHttpError(response.status, body);
    }

    return response.json();
  }

  private parseArray<T>(payload: unknown, parseItem: (value: unknown) => T): T[] {
    if (!Array.isArray(payload)) {
      throw new Error("Data API response is not an array");
    }

    return payload.map((row) => parseItem(row));
  }
}
