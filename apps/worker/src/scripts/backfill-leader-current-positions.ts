import { PrismaClient } from "@copybot/db";
import { runLeaderCurrentPositionBackfill } from "../current-state/backfill.js";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  await prisma.$connect();

  try {
    const result = await runLeaderCurrentPositionBackfill(prisma);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
