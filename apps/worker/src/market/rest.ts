import { parseClobBookSummary, type ClobBookSummary } from "@copybot/shared";

export interface ClobRestClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class ClobRestClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClobRestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchBook(tokenId: string): Promise<ClobBookSummary> {
    const url = new URL("/book", this.baseUrl);
    url.searchParams.set("token_id", tokenId);

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" }
    });
    const payload = await this.parseJson(response);
    return parseClobBookSummary(payload);
  }

  async fetchBooks(tokenIds: string[]): Promise<ClobBookSummary[]> {
    if (tokenIds.length === 0) {
      return [];
    }

    const url = new URL("/books", this.baseUrl);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify(tokenIds.map((tokenId) => ({ token_id: tokenId })))
    });

    const payload = await this.parseJson(response);
    const books = this.extractBooksArray(payload);
    return books.map((book) => parseClobBookSummary(book));
  }

  topOfBook(summary: ClobBookSummary): { bestBid?: number; bestAsk?: number } {
    return {
      bestBid: bestBidFromLevels(summary.bids),
      bestAsk: bestAskFromLevels(summary.asks)
    };
  }

  private async parseJson(response: Response): Promise<unknown> {
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CLOB request failed (${response.status}): ${text}`);
    }

    return response.json();
  }

  private extractBooksArray(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }

    if (payload && typeof payload === "object") {
      const booksField = (payload as { books?: unknown }).books;
      if (Array.isArray(booksField)) {
        return booksField;
      }
    }

    throw new Error("Unexpected /books response shape");
  }
}

function bestBidFromLevels(levels: Array<{ price: number; size: number }>): number | undefined {
  let best: number | undefined;
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.price <= 0 || level.size <= 0) {
      continue;
    }
    if (best === undefined || level.price > best) {
      best = level.price;
    }
  }
  return best;
}

function bestAskFromLevels(levels: Array<{ price: number; size: number }>): number | undefined {
  let best: number | undefined;
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.size) || level.price <= 0 || level.size <= 0) {
      continue;
    }
    if (best === undefined || level.price < best) {
      best = level.price;
    }
  }
  return best;
}
