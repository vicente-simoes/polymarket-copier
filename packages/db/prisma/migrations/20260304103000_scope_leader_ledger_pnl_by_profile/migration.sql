-- Scope leader exposure/PnL ledgers by copy profile for multi-profile correctness.
ALTER TABLE "LeaderTokenLedger"
ADD COLUMN "copyProfileId" TEXT;

ALTER TABLE "LeaderPnlSummary"
ADD COLUMN "copyProfileId" TEXT;

WITH first_profile AS (
  SELECT "id"
  FROM "CopyProfile"
  ORDER BY "createdAt" ASC
  LIMIT 1
)
UPDATE "LeaderTokenLedger"
SET "copyProfileId" = (SELECT "id" FROM first_profile)
WHERE "copyProfileId" IS NULL;

WITH first_profile AS (
  SELECT "id"
  FROM "CopyProfile"
  ORDER BY "createdAt" ASC
  LIMIT 1
)
UPDATE "LeaderPnlSummary"
SET "copyProfileId" = (SELECT "id" FROM first_profile)
WHERE "copyProfileId" IS NULL;

ALTER TABLE "LeaderTokenLedger"
ALTER COLUMN "copyProfileId" SET NOT NULL;

ALTER TABLE "LeaderPnlSummary"
ALTER COLUMN "copyProfileId" SET NOT NULL;

ALTER TABLE "LeaderTokenLedger"
ADD CONSTRAINT "LeaderTokenLedger_copyProfileId_fkey"
FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaderPnlSummary"
ADD CONSTRAINT "LeaderPnlSummary_copyProfileId_fkey"
FOREIGN KEY ("copyProfileId") REFERENCES "CopyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DROP INDEX IF EXISTS "LeaderTokenLedger_leaderId_tokenId_key";
DROP INDEX IF EXISTS "LeaderPnlSummary_leaderId_key";

CREATE UNIQUE INDEX "LeaderTokenLedger_copyProfileId_leaderId_tokenId_key"
ON "LeaderTokenLedger"("copyProfileId", "leaderId", "tokenId");

CREATE UNIQUE INDEX "LeaderPnlSummary_copyProfileId_leaderId_key"
ON "LeaderPnlSummary"("copyProfileId", "leaderId");

CREATE INDEX "LeaderTokenLedger_copyProfileId_leaderId_tokenId_idx"
ON "LeaderTokenLedger"("copyProfileId", "leaderId", "tokenId");

CREATE INDEX "LeaderPnlSummary_copyProfileId_leaderId_idx"
ON "LeaderPnlSummary"("copyProfileId", "leaderId");
