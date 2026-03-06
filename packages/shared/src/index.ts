export { WorkerEnvSchema, parseWorkerEnv, type WorkerEnv } from "./env.js";

export {
  DECIMAL_ZERO,
  d,
  clamp,
  safeDiv,
  decimalMax,
  decimalMin,
  sum,
  toFixed,
  isFiniteDecimal,
  type DecimalLike
} from "./domain/math.js";

export { roundDownToTick, roundUpToTick, roundShares, roundUsd } from "./domain/rounding.js";

export {
  targetNotionalUsd,
  sharesFromNotional,
  notionalFromShares,
  deltaShares,
  midPrice
} from "./domain/conversion.js";

export {
  computeBuyPriceCap,
  computeSellPriceFloor,
  directionalSlippageBps,
  buyImprovementBps,
  evaluateGuardrails,
  type TradeSide,
  type GuardrailConfig,
  type PriceInputs,
  type GuardrailEvaluation,
  type GuardrailFailureReason
} from "./domain/guardrails.js";

export {
  computeLiveExecutionDiagnostics,
  type ExecutionBookLevel,
  type LiveExecutionDiagnostics,
  type LiveExecutionDiagnosticsInput
} from "./domain/execution-diagnostics.js";

export { sizeFAKOrder, type FAKOrderSizingInput, type FAKOrderSizingResult } from "./domain/order.js";

export {
  UNATTRIBUTED_BUCKET,
  computeAttributionWeights,
  allocateFillByWeights,
  type AttributionWeights,
  type FillAllocation,
  type LeaderId
} from "./domain/attribution.js";

export {
  applyBuyAllocation,
  applySellAllocation,
  unrealizedPnlUsd,
  type LeaderLedgerState,
  type FillForLedger
} from "./domain/pnl.js";

export { makeIdempotencyKey, triggerId, copyDecisionKey, orderRetryKey } from "./domain/idempotency.js";

export {
  AlchemyLogSchema,
  AlchemyLogNotificationSchema,
  DataApiTradeSchema,
  DataApiPositionSchema,
  ClobBookSummarySchema,
  parseAlchemyLogNotification,
  parseDataApiTrade,
  parseDataApiPosition,
  parseClobBookSummary,
  type AlchemyLogNotification,
  type DataApiTrade,
  type DataApiPosition,
  type ClobBookSummary
} from "./schemas/external.js";

export {
  buildPolymarketMarketPath,
  extractTokenDisplayMetadataFromPayload,
  mergeTokenDisplayMetadata,
  toTokenDisplayMetadataView,
  type TokenDisplayMetadataObservation,
  type TokenDisplayMetadataRecord,
  type TokenDisplayMetadataView
} from "./domain/token-display-metadata.js";
