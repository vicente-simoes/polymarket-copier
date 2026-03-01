-- Add canonical cross-source identity for leader trades.
ALTER TABLE "LeaderTradeEvent"
ADD COLUMN "canonicalKey" TEXT;

-- Backfill existing rows without attempting historical dedupe in this migration.
UPDATE "LeaderTradeEvent"
SET "canonicalKey" = 'legacy:' || "id"
WHERE "canonicalKey" IS NULL;

ALTER TABLE "LeaderTradeEvent"
ALTER COLUMN "canonicalKey" SET NOT NULL;

CREATE UNIQUE INDEX "LeaderTradeEvent_leaderId_canonicalKey_key"
ON "LeaderTradeEvent"("leaderId", "canonicalKey");
