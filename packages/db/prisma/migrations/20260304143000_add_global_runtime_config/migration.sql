-- Global singleton runtime config used by worker hot-reload controls.
CREATE TABLE "GlobalRuntimeConfig" (
  "id" TEXT NOT NULL,
  "config" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "GlobalRuntimeConfig_pkey" PRIMARY KEY ("id")
);
