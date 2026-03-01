import assert from "node:assert/strict";
import test from "node:test";
import { ClobExecutionClient } from "../src/execution/clob.js";
import type { ExecutionOrderRequest } from "../src/execution/types.js";

interface RecordedSdkCall {
  userMarketOrder: unknown;
  options: unknown;
  orderType: unknown;
}

function makeOrderRequest(
  overrides: Partial<ExecutionOrderRequest> = {}
): ExecutionOrderRequest {
  return {
    copyAttemptId: "attempt-1",
    tokenId: "123",
    marketId: "market-1",
    side: "BUY",
    orderType: "FAK",
    amountKind: "USD",
    amount: 2.5,
    priceLimit: 0.61,
    tickSize: 0.01,
    negRisk: false,
    idempotencyKey: "idem-1",
    ...overrides
  };
}

function makeClient(result: unknown, calls: RecordedSdkCall[] = []): ClobExecutionClient {
  return new ClobExecutionClient({
    baseUrl: "https://clob.polymarket.com",
    apiKey: "api-key",
    apiSecret: "api-secret",
    passphrase: "passphrase",
    privateKey: "0x" + "1".repeat(64),
    chainId: 137,
    signatureType: 0,
    sdkClientFactory: () => ({
      createAndPostMarketOrder: async (userMarketOrder, options, orderType) => {
        calls.push({ userMarketOrder, options, orderType });
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }
    })
  });
}

test("ClobExecutionClient maps BUY FAK order to Polymarket SDK market-order call", async () => {
  const calls: RecordedSdkCall[] = [];
  const client = makeClient({ orderID: "ord-1", status: "PLACED" }, calls);

  const result = await client.createAndSubmitOrder(
    makeOrderRequest({
      side: "BUY",
      amountKind: "USD",
      amount: 1.23,
      priceLimit: 0.55,
      tickSize: 0.01,
      negRisk: true
    })
  );

  assert.equal(result.externalOrderId, "ord-1");
  assert.equal(result.status, "PLACED");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    userMarketOrder: {
      tokenID: "123",
      side: "BUY",
      amount: 1.23,
      price: 0.55
    },
    options: {
      tickSize: "0.01",
      negRisk: true
    },
    orderType: "FAK"
  });
});

test("ClobExecutionClient maps SELL FAK shares order and normalizes alternate response ids", async () => {
  const calls: RecordedSdkCall[] = [];
  const client = makeClient({ order_id: "ord-2", status: "filled" }, calls);

  const result = await client.createAndSubmitOrder(
    makeOrderRequest({
      side: "SELL",
      amountKind: "SHARES",
      amount: 3,
      priceLimit: 0.42,
      tickSize: 0.001
    })
  );

  assert.equal(result.externalOrderId, "ord-2");
  assert.equal(result.status, "FILLED");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    userMarketOrder: {
      tokenID: "123",
      side: "SELL",
      amount: 3,
      price: 0.42
    },
    options: {
      tickSize: "0.001",
      negRisk: false
    },
    orderType: "FAK"
  });
});

test("ClobExecutionClient rejects unsupported tick sizes with explicit error", async () => {
  const client = makeClient({ orderID: "ord-3", status: "PLACED" });

  await assert.rejects(
    () =>
      client.createAndSubmitOrder(
        makeOrderRequest({
          tickSize: 0.05
        })
      ),
    /Unsupported CLOB tick size 0.05/
  );
});

test("ClobExecutionClient surfaces SDK errors and error responses", async () => {
  const sdkThrowClient = makeClient(new Error("boom"));
  await assert.rejects(
    () => sdkThrowClient.createAndSubmitOrder(makeOrderRequest()),
    /CLOB order submit failed: boom/
  );

  const sdkErrorPayloadClient = makeClient({ success: false, errorMsg: "bad request" });
  await assert.rejects(
    () => sdkErrorPayloadClient.createAndSubmitOrder(makeOrderRequest()),
    /CLOB order submit failed/
  );

  const sdkErrorFieldClient = makeClient({ error: "not enough balance / allowance", status: 400 });
  await assert.rejects(
    () => sdkErrorFieldClient.createAndSubmitOrder(makeOrderRequest()),
    /not enough balance \/ allowance/
  );
});

test("ClobExecutionClient rejects placement responses without an order id", async () => {
  const client = makeClient({ success: true, status: "PLACED" });

  await assert.rejects(
    () => client.createAndSubmitOrder(makeOrderRequest()),
    /missing order id/i
  );
});

test("ClobExecutionClient enforces BUY/SELL amountKind semantics for FAK orders", async () => {
  const client = makeClient({ orderID: "ord-4", status: "PLACED" });

  await assert.rejects(
    () =>
      client.createAndSubmitOrder(
        makeOrderRequest({
          side: "BUY",
          amountKind: "SHARES"
        })
      ),
    /BUY FAK orders must use amountKind=USD/
  );

  await assert.rejects(
    () =>
      client.createAndSubmitOrder(
        makeOrderRequest({
          side: "SELL",
          amountKind: "USD"
        })
      ),
    /SELL FAK orders must use amountKind=SHARES/
  );
});
