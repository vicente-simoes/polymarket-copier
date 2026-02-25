-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "LeaderStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WalletSource" AS ENUM ('DATA_API', 'MANUAL', 'DISCOVERED');

-- CreateEnum
CREATE TYPE "CopyProfileStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CopyProfileLeaderStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REMOVED');

-- CreateEnum
CREATE TYPE "LeaderTradeSource" AS ENUM ('CHAIN', 'DATA_API');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "DeltaSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "PendingDeltaStatus" AS ENUM ('PENDING', 'ELIGIBLE', 'BLOCKED', 'EXPIRED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'EXECUTING', 'EXECUTED', 'SKIPPED', 'EXPIRED', 'FAILED', 'RETRYING');

-- CreateEnum
CREATE TYPE "AttemptDecision" AS ENUM ('PENDING', 'EXECUTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('MIN_NOTIONAL', 'MIN_ORDER_SIZE', 'SLIPPAGE', 'PRICE_GUARD', 'SPREAD', 'THIN_BOOK', 'STALE_PRICE', 'MARKET_WS_DISCONNECTED', 'RATE_LIMIT', 'KILL_SWITCH', 'LEADER_PAUSED', 'EXPIRED', 'BOOK_UNAVAILABLE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('FAK', 'FOK', 'GTC', 'GTD');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PLACED', 'PARTIALLY_FILLED', 'FILLED', 'FAILED', 'CANCELLED', 'RETRYING');

-- CreateEnum
CREATE TYPE "SnapshotGranularity" AS ENUM ('RAW_1M', 'ROLLUP_5M', 'ROLLUP_1H', 'ROLLUP_1D');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('OK', 'DOWN', 'DEGRADED');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM ('WORKER', 'DATABASE', 'REDIS', 'ALCHEMY_WS', 'WEB', 'NGINX');

-- CreateEnum
CREATE TYPE "ErrorSeverity" AS ENUM ('INFO', 'WARN', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ConfigScope" AS ENUM ('GLOBAL', 'LEADER', 'COPY_PROFILE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ConfigChangeType" AS ENUM ('CREATED', 'UPDATED', 'DELETED');

-- CreateTable
CREATE TABLE "Leader" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileAddress" TEXT NOT NULL,
    "status" "LeaderStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Leader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderWallet" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "source" "WalletSource" NOT NULL DEFAULT 'DATA_API',
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "followerAddress" TEXT NOT NULL,
    "status" "CopyProfileStatus" NOT NULL DEFAULT 'ACTIVE',
    "defaultRatio" DECIMAL(20,8) NOT NULL,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyProfileLeader" (
    "id" TEXT NOT NULL,
    "copyProfileId" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "ratio" DECIMAL(20,8) NOT NULL,
    "status" "CopyProfileLeaderStatus" NOT NULL DEFAULT 'ACTIVE',
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyProfileLeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderTradeEvent" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "source" "LeaderTradeSource" NOT NULL,
    "triggerId" TEXT,
    "transactionHash" TEXT,
    "logIndex" INTEGER,
    "leaderFillAtMs" BIGINT NOT NULL,
    "wsReceivedAtMs" BIGINT,
    "detectedAtMs" BIGINT NOT NULL,
    "marketId" TEXT,
    "tokenId" TEXT NOT NULL,
    "outcome" TEXT,
    "side" "TradeSide" NOT NULL,
    "shares" DECIMAL(38,18) NOT NULL,
    "price" DECIMAL(20,10) NOT NULL,
    "notionalUsd" DECIMAL(20,8) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderTradeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderPositionSnapshot" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "snapshotAtMs" BIGINT,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "outcome" TEXT,
    "shares" DECIMAL(38,18) NOT NULL,
    "avgPrice" DECIMAL(20,10),
    "currentPrice" DECIMAL(20,10),
    "initialValueUsd" DECIMAL(20,8),
    "currentValueUsd" DECIMAL(20,8),
    "cashPnlUsd" DECIMAL(20,8),
    "realizedPnlUsd" DECIMAL(20,8),
    "negativeRisk" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderPositionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowerPositionSnapshot" (
    "id" TEXT NOT NULL,
    "copyProfileId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "snapshotAtMs" BIGINT,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "outcome" TEXT,
    "shares" DECIMAL(38,18) NOT NULL,
    "avgCostUsd" DECIMAL(20,8),
    "currentPrice" DECIMAL(20,10),
    "costBasisUsd" DECIMAL(20,8),
    "currentValueUsd" DECIMAL(20,8),
    "unrealizedPnlUsd" DECIMAL(20,8),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowerPositionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingDelta" (
    "id" TEXT NOT NULL,
    "copyProfileId" TEXT NOT NULL,
    "leaderId" TEXT,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "side" "DeltaSide" NOT NULL,
    "pendingDeltaShares" DECIMAL(38,18) NOT NULL,
    "pendingDeltaNotionalUsd" DECIMAL(20,8) NOT NULL,
    "minExecutableNotionalUsd" DECIMAL(20,8) NOT NULL DEFAULT 1,
    "status" "PendingDeltaStatus" NOT NULL DEFAULT 'PENDING',
    "blockReason" "SkipReason",
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingDelta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyAttempt" (
    "id" TEXT NOT NULL,
    "copyProfileId" TEXT NOT NULL,
    "leaderId" TEXT,
    "pendingDeltaId" TEXT,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "side" "DeltaSide" NOT NULL,
    "status" "AttemptStatus" NOT NULL DEFAULT 'PENDING',
    "decision" "AttemptDecision" NOT NULL DEFAULT 'PENDING',
    "accumulatedDeltaShares" DECIMAL(38,18),
    "accumulatedDeltaNotionalUsd" DECIMAL(20,8),
    "reason" "SkipReason",
    "errorPayload" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 20,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyOrder" (
    "id" TEXT NOT NULL,
    "copyProfileId" TEXT NOT NULL,
    "copyAttemptId" TEXT,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "side" "DeltaSide" NOT NULL,
    "orderType" "OrderType" NOT NULL DEFAULT 'FAK',
    "intendedNotionalUsd" DECIMAL(20,8),
    "intendedShares" DECIMAL(38,18),
    "priceLimit" DECIMAL(20,10),
    "leaderWeights" JSONB NOT NULL,
    "unattributedWeight" DECIMAL(20,8),
    "idempotencyKey" TEXT NOT NULL,
    "externalOrderId" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'PLACED',
    "feePaidUsd" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "errorPayload" JSONB,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopyOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyFill" (
    "id" TEXT NOT NULL,
    "copyOrderId" TEXT NOT NULL,
    "externalTradeId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "side" "DeltaSide" NOT NULL,
    "filledShares" DECIMAL(38,18) NOT NULL,
    "filledUsdc" DECIMAL(20,8) NOT NULL,
    "feeUsdc" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "avgPrice" DECIMAL(20,10) NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyFill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopyFillAllocation" (
    "id" TEXT NOT NULL,
    "copyFillId" TEXT NOT NULL,
    "copyOrderId" TEXT NOT NULL,
    "leaderId" TEXT,
    "leaderBucket" TEXT,
    "tokenId" TEXT NOT NULL,
    "sharesDelta" DECIMAL(38,18) NOT NULL,
    "usdcDelta" DECIMAL(20,8) NOT NULL,
    "feeUsdcDelta" DECIMAL(20,8) NOT NULL,
    "avgPrice" DECIMAL(20,10),
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopyFillAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderTokenLedger" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "shares" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderTokenLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderPnlSummary" (
    "id" TEXT NOT NULL,
    "leaderId" TEXT NOT NULL,
    "realizedPnlUsd" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaderPnlSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL,
    "copyProfileId" TEXT NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "snapshotAtMs" BIGINT,
    "granularity" "SnapshotGranularity" NOT NULL DEFAULT 'RAW_1M',
    "exposureUsd" DECIMAL(20,8) NOT NULL,
    "totalValueUsd" DECIMAL(20,8),
    "realizedPnlUsd" DECIMAL(20,8),
    "unrealizedPnlUsd" DECIMAL(20,8),
    "totalPnlUsd" DECIMAL(20,8),
    "window1hPnlUsd" DECIMAL(20,8),
    "window24hPnlUsd" DECIMAL(20,8),
    "window7dPnlUsd" DECIMAL(20,8),
    "window30dPnlUsd" DECIMAL(20,8),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortfolioSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemStatus" (
    "id" TEXT NOT NULL,
    "component" "ComponentType" NOT NULL,
    "status" "HealthStatus" NOT NULL DEFAULT 'OK',
    "lastEventAt" TIMESTAMP(3),
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemStatus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Heartbeat" (
    "id" TEXT NOT NULL,
    "component" "ComponentType" NOT NULL,
    "instanceId" TEXT,
    "status" "HealthStatus" NOT NULL DEFAULT 'OK',
    "latencyMs" INTEGER,
    "payload" JSONB,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Heartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorEvent" (
    "id" TEXT NOT NULL,
    "component" "ComponentType" NOT NULL,
    "severity" "ErrorSeverity" NOT NULL DEFAULT 'ERROR',
    "code" TEXT,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" JSONB,
    "relatedLeaderId" TEXT,
    "relatedTokenId" TEXT,
    "relatedOrderId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigAuditLog" (
    "id" TEXT NOT NULL,
    "scope" "ConfigScope" NOT NULL,
    "scopeRefId" TEXT,
    "copyProfileId" TEXT,
    "changedBy" TEXT,
    "changeType" "ConfigChangeType" NOT NULL,
    "previousValue" JSONB,
    "nextValue" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Leader_status_createdAt_idx" ON "Leader"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Leader_profileAddress_key" ON "Leader"("profileAddress");

-- CreateIndex
CREATE INDEX "LeaderWallet_walletAddress_idx" ON "LeaderWallet"("walletAddress");

-- CreateIndex
CREATE INDEX "LeaderWallet_leaderId_isActive_idx" ON "LeaderWallet"("leaderId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderWallet_leaderId_walletAddress_key" ON "LeaderWallet"("leaderId", "walletAddress");

-- CreateIndex
CREATE INDEX "CopyProfile_status_createdAt_idx" ON "CopyProfile"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyProfile_name_followerAddress_key" ON "CopyProfile"("name", "followerAddress");

-- CreateIndex
CREATE INDEX "CopyProfileLeader_leaderId_status_createdAt_idx" ON "CopyProfileLeader"("leaderId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyProfileLeader_copyProfileId_leaderId_key" ON "CopyProfileLeader"("copyProfileId", "leaderId");

-- CreateIndex
CREATE INDEX "LeaderTradeEvent_leaderId_leaderFillAtMs_idx" ON "LeaderTradeEvent"("leaderId", "leaderFillAtMs");

-- CreateIndex
CREATE INDEX "LeaderTradeEvent_tokenId_leaderFillAtMs_idx" ON "LeaderTradeEvent"("tokenId", "leaderFillAtMs");

-- CreateIndex
CREATE INDEX "LeaderTradeEvent_source_detectedAtMs_idx" ON "LeaderTradeEvent"("source", "detectedAtMs");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderTradeEvent_triggerId_key" ON "LeaderTradeEvent"("triggerId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderTradeEvent_transactionHash_logIndex_key" ON "LeaderTradeEvent"("transactionHash", "logIndex");

-- CreateIndex
CREATE INDEX "LeaderPositionSnapshot_leaderId_snapshotAt_idx" ON "LeaderPositionSnapshot"("leaderId", "snapshotAt");

-- CreateIndex
CREATE INDEX "LeaderPositionSnapshot_tokenId_snapshotAt_idx" ON "LeaderPositionSnapshot"("tokenId", "snapshotAt");

-- CreateIndex
CREATE INDEX "FollowerPositionSnapshot_copyProfileId_snapshotAt_idx" ON "FollowerPositionSnapshot"("copyProfileId", "snapshotAt");

-- CreateIndex
CREATE INDEX "FollowerPositionSnapshot_tokenId_snapshotAt_idx" ON "FollowerPositionSnapshot"("tokenId", "snapshotAt");

-- CreateIndex
CREATE INDEX "PendingDelta_status_createdAt_idx" ON "PendingDelta"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PendingDelta_tokenId_createdAt_idx" ON "PendingDelta"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "PendingDelta_leaderId_createdAt_idx" ON "PendingDelta"("leaderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingDelta_copyProfileId_tokenId_side_key" ON "PendingDelta"("copyProfileId", "tokenId", "side");

-- CreateIndex
CREATE INDEX "CopyAttempt_status_createdAt_idx" ON "CopyAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CopyAttempt_tokenId_createdAt_idx" ON "CopyAttempt"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "CopyAttempt_leaderId_createdAt_idx" ON "CopyAttempt"("leaderId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyAttempt_idempotencyKey_key" ON "CopyAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CopyOrder_status_createdAt_idx" ON "CopyOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CopyOrder_tokenId_createdAt_idx" ON "CopyOrder"("tokenId", "createdAt");

-- CreateIndex
CREATE INDEX "CopyOrder_copyAttemptId_createdAt_idx" ON "CopyOrder"("copyAttemptId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyOrder_idempotencyKey_key" ON "CopyOrder"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CopyOrder_externalOrderId_key" ON "CopyOrder"("externalOrderId");

-- CreateIndex
CREATE INDEX "CopyFill_tokenId_filledAt_idx" ON "CopyFill"("tokenId", "filledAt");

-- CreateIndex
CREATE INDEX "CopyFill_copyOrderId_filledAt_idx" ON "CopyFill"("copyOrderId", "filledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopyFill_externalTradeId_key" ON "CopyFill"("externalTradeId");

-- CreateIndex
CREATE INDEX "CopyFillAllocation_leaderId_allocatedAt_idx" ON "CopyFillAllocation"("leaderId", "allocatedAt");

-- CreateIndex
CREATE INDEX "CopyFillAllocation_tokenId_allocatedAt_idx" ON "CopyFillAllocation"("tokenId", "allocatedAt");

-- CreateIndex
CREATE INDEX "CopyFillAllocation_copyOrderId_allocatedAt_idx" ON "CopyFillAllocation"("copyOrderId", "allocatedAt");

-- CreateIndex
CREATE INDEX "LeaderTokenLedger_tokenId_updatedAt_idx" ON "LeaderTokenLedger"("tokenId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderTokenLedger_leaderId_tokenId_key" ON "LeaderTokenLedger"("leaderId", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderPnlSummary_leaderId_key" ON "LeaderPnlSummary"("leaderId");

-- CreateIndex
CREATE INDEX "LeaderPnlSummary_realizedPnlUsd_idx" ON "LeaderPnlSummary"("realizedPnlUsd");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_copyProfileId_snapshotAt_idx" ON "PortfolioSnapshot"("copyProfileId", "snapshotAt");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_granularity_snapshotAt_idx" ON "PortfolioSnapshot"("granularity", "snapshotAt");

-- CreateIndex
CREATE INDEX "PortfolioSnapshot_copyProfileId_granularity_snapshotAt_idx" ON "PortfolioSnapshot"("copyProfileId", "granularity", "snapshotAt");

-- CreateIndex
CREATE INDEX "SystemStatus_status_lastUpdatedAt_idx" ON "SystemStatus"("status", "lastUpdatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SystemStatus_component_key" ON "SystemStatus"("component");

-- CreateIndex
CREATE INDEX "Heartbeat_component_observedAt_idx" ON "Heartbeat"("component", "observedAt");

-- CreateIndex
CREATE INDEX "Heartbeat_status_observedAt_idx" ON "Heartbeat"("status", "observedAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_component_occurredAt_idx" ON "ErrorEvent"("component", "occurredAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_severity_occurredAt_idx" ON "ErrorEvent"("severity", "occurredAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_relatedLeaderId_occurredAt_idx" ON "ErrorEvent"("relatedLeaderId", "occurredAt");

-- CreateIndex
CREATE INDEX "ErrorEvent_relatedTokenId_occurredAt_idx" ON "ErrorEvent"("relatedTokenId", "occurredAt");

-- CreateIndex
CREATE INDEX "ConfigAuditLog_scope_createdAt_idx" ON "ConfigAuditLog"("scope", "createdAt");

-- CreateIndex
CREATE INDEX "ConfigAuditLog_scopeRefId_createdAt_idx" ON "ConfigAuditLog"("scopeRefId", "createdAt");

-- CreateIndex
CREATE INDEX "ConfigAuditLog_copyProfileId_createdAt_idx" ON "ConfigAuditLog"("copyProfileId", "createdAt");

-- AddForeignKey
ALTER TABLE "LeaderWallet" ADD CONSTRAINT "LeaderWallet_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyProfileLeader" ADD CONSTRAINT "CopyProfileLeader_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyProfileLeader" ADD CONSTRAINT "CopyProfileLeader_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderTradeEvent" ADD CONSTRAINT "LeaderTradeEvent_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderPositionSnapshot" ADD CONSTRAINT "LeaderPositionSnapshot_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowerPositionSnapshot" ADD CONSTRAINT "FollowerPositionSnapshot_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDelta" ADD CONSTRAINT "PendingDelta_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingDelta" ADD CONSTRAINT "PendingDelta_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyAttempt" ADD CONSTRAINT "CopyAttempt_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyAttempt" ADD CONSTRAINT "CopyAttempt_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyAttempt" ADD CONSTRAINT "CopyAttempt_pendingDeltaId_fkey" FOREIGN KEY ("pendingDeltaId") REFERENCES "PendingDelta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyOrder" ADD CONSTRAINT "CopyOrder_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyOrder" ADD CONSTRAINT "CopyOrder_copyAttemptId_fkey" FOREIGN KEY ("copyAttemptId") REFERENCES "CopyAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyFill" ADD CONSTRAINT "CopyFill_copyOrderId_fkey" FOREIGN KEY ("copyOrderId") REFERENCES "CopyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyFillAllocation" ADD CONSTRAINT "CopyFillAllocation_copyFillId_fkey" FOREIGN KEY ("copyFillId") REFERENCES "CopyFill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyFillAllocation" ADD CONSTRAINT "CopyFillAllocation_copyOrderId_fkey" FOREIGN KEY ("copyOrderId") REFERENCES "CopyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopyFillAllocation" ADD CONSTRAINT "CopyFillAllocation_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderTokenLedger" ADD CONSTRAINT "LeaderTokenLedger_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderPnlSummary" ADD CONSTRAINT "LeaderPnlSummary_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortfolioSnapshot" ADD CONSTRAINT "PortfolioSnapshot_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorEvent" ADD CONSTRAINT "ErrorEvent_relatedLeaderId_fkey" FOREIGN KEY ("relatedLeaderId") REFERENCES "Leader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigAuditLog" ADD CONSTRAINT "ConfigAuditLog_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

