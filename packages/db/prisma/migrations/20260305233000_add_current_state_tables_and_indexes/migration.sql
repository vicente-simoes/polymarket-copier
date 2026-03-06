-- AlterEnum
ALTER TYPE "ComponentType" ADD VALUE 'DASHBOARD_STATUS';

-- CreateTable
CREATE TABLE "LeaderCurrentPosition" (
  "leaderId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "marketId" TEXT,
  "shares" DECIMAL(38,18) NOT NULL,
  "avgPrice" DECIMAL(20,10),
  "currentPrice" DECIMAL(20,10),
  "currentValueUsd" DECIMAL(20,8),
  "snapshotAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LeaderCurrentPosition_pkey" PRIMARY KEY ("leaderId","tokenId")
);

-- CreateTable
CREATE TABLE "FollowerCurrentPosition" (
  "copyProfileId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "marketId" TEXT,
  "outcome" TEXT,
  "shares" DECIMAL(38,18) NOT NULL,
  "costBasisUsd" DECIMAL(20,8),
  "currentPrice" DECIMAL(20,10),
  "currentValueUsd" DECIMAL(20,8),
  "source" TEXT NOT NULL,
  "snapshotAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FollowerCurrentPosition_pkey" PRIMARY KEY ("copyProfileId","tokenId")
);

-- CreateTable
CREATE TABLE "LeaderLatestTradePrice" (
  "leaderId" TEXT NOT NULL,
  "tokenId" TEXT NOT NULL,
  "side" "DeltaSide" NOT NULL,
  "price" DECIMAL(20,10) NOT NULL,
  "leaderFillAtMs" BIGINT NOT NULL,
  "source" "LeaderTradeSource" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LeaderLatestTradePrice_pkey" PRIMARY KEY ("leaderId","tokenId","side")
);

-- CreateIndex
CREATE INDEX "LeaderCurrentPosition_leaderId_snapshotAt_idx" ON "LeaderCurrentPosition"("leaderId", "snapshotAt");

-- CreateIndex
CREATE INDEX "LeaderCurrentPosition_tokenId_idx" ON "LeaderCurrentPosition"("tokenId");

-- CreateIndex
CREATE INDEX "FollowerCurrentPosition_copyProfileId_snapshotAt_idx" ON "FollowerCurrentPosition"("copyProfileId", "snapshotAt");

-- CreateIndex
CREATE INDEX "FollowerCurrentPosition_tokenId_idx" ON "FollowerCurrentPosition"("tokenId");

-- CreateIndex
CREATE INDEX "LeaderLatestTradePrice_tokenId_idx" ON "LeaderLatestTradePrice"("tokenId");

-- CreateIndex
CREATE INDEX "LeaderLatestTradePrice_leaderId_leaderFillAtMs_idx" ON "LeaderLatestTradePrice"("leaderId", "leaderFillAtMs");

-- CreateIndex
CREATE INDEX "PendingDelta_copyProfileId_status_tokenId_idx" ON "PendingDelta"("copyProfileId", "status", "tokenId");

-- CreateIndex
CREATE INDEX "CopyAttempt_decision_status_createdAt_idx" ON "CopyAttempt"("decision", "status", "createdAt");

-- CreateIndex
CREATE INDEX "CopyOrder_copyProfileId_status_attemptedAt_idx" ON "CopyOrder"("copyProfileId", "status", "attemptedAt");

-- CreateIndex
CREATE INDEX "CopyOrder_copyProfileId_tokenId_attemptedAt_idx" ON "CopyOrder"("copyProfileId", "tokenId", "attemptedAt");

-- AddForeignKey
ALTER TABLE "LeaderCurrentPosition" ADD CONSTRAINT "LeaderCurrentPosition_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowerCurrentPosition" ADD CONSTRAINT "FollowerCurrentPosition_copyProfileId_fkey" FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderLatestTradePrice" ADD CONSTRAINT "LeaderLatestTradePrice_leaderId_fkey" FOREIGN KEY ("leaderId") REFERENCES "Leader"("id") ON DELETE CASCADE ON UPDATE CASCADE;
