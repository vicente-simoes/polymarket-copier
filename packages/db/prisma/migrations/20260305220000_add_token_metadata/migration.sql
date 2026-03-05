CREATE TABLE "TokenMetadata" (
    "tokenId" TEXT NOT NULL,
    "marketId" TEXT,
    "title" TEXT,
    "slug" TEXT,
    "eventSlug" TEXT,
    "outcome" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TokenMetadata_pkey" PRIMARY KEY ("tokenId")
);

CREATE INDEX "TokenMetadata_marketId_idx" ON "TokenMetadata"("marketId");
