import { z } from "zod";

export const AlchemyLogSchema = z.object({
  address: z.string(),
  blockHash: z.string(),
  blockNumber: z.string(),
  data: z.string(),
  logIndex: z.string(),
  topics: z.array(z.string()),
  transactionHash: z.string(),
  transactionIndex: z.string().optional(),
  removed: z.boolean().optional()
});

export const AlchemyLogNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("eth_subscription"),
  params: z.object({
    subscription: z.string(),
    result: AlchemyLogSchema
  })
});

export const DataApiTradeSchema = z.object({
  proxyWallet: z.string(),
  side: z.enum(["BUY", "SELL"]),
  asset: z.string(),
  conditionId: z.string(),
  size: z.coerce.number(),
  price: z.coerce.number(),
  timestamp: z.coerce.number(),
  title: z.string().optional(),
  slug: z.string().optional(),
  outcome: z.string().optional(),
  outcomeIndex: z.coerce.number().optional(),
  eventSlug: z.string().optional(),
  transactionHash: z.string().optional()
});

export const DataApiPositionSchema = z.object({
  proxyWallet: z.string(),
  asset: z.string(),
  conditionId: z.string(),
  size: z.coerce.number(),
  avgPrice: z.coerce.number().optional(),
  initialValue: z.coerce.number().optional(),
  currentValue: z.coerce.number().optional(),
  cashPnl: z.coerce.number().optional(),
  realizedPnl: z.coerce.number().optional(),
  curPrice: z.coerce.number().optional(),
  negativeRisk: z.boolean().optional(),
  title: z.string().optional(),
  slug: z.string().optional(),
  outcome: z.string().optional(),
  outcomeIndex: z.coerce.number().optional(),
  eventSlug: z.string().optional()
});

export const ClobBookSummarySchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  timestamp: z.string(),
  hash: z.string().optional(),
  bids: z.array(
    z.object({
      price: z.coerce.number(),
      size: z.coerce.number()
    })
  ),
  asks: z.array(
    z.object({
      price: z.coerce.number(),
      size: z.coerce.number()
    })
  ),
  min_order_size: z.coerce.number(),
  tick_size: z.coerce.number(),
  neg_risk: z.boolean().optional().default(false)
});

export type AlchemyLogNotification = z.infer<typeof AlchemyLogNotificationSchema>;
export type DataApiTrade = z.infer<typeof DataApiTradeSchema>;
export type DataApiPosition = z.infer<typeof DataApiPositionSchema>;
export type ClobBookSummary = z.infer<typeof ClobBookSummarySchema>;

export function parseAlchemyLogNotification(input: unknown): AlchemyLogNotification {
  return AlchemyLogNotificationSchema.parse(input);
}

export function parseDataApiTrade(input: unknown): DataApiTrade {
  return DataApiTradeSchema.parse(input);
}

export function parseDataApiPosition(input: unknown): DataApiPosition {
  return DataApiPositionSchema.parse(input);
}

export function parseClobBookSummary(input: unknown): ClobBookSummary {
  return ClobBookSummarySchema.parse(input);
}
