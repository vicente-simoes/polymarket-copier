import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  test("db integration skipped without DATABASE_URL", () => {
    assert.ok(true);
  });
} else {
  const prisma = new PrismaClient();

  test("core read/write path covers stage 3 entities", async () => {
    const runId = `it-${Date.now()}`;

    const createdIds: {
      copyFillId?: string;
      copyOrderId?: string;
      copyAttemptId?: string;
      pendingDeltaId?: string;
      leaderId?: string;
      copyProfileId?: string;
    } = {};

    try {
      const leader = await prisma.leader.create({
        data: {
          name: `Leader ${runId}`,
          profileAddress: `0x${runId.padEnd(40, "0").slice(0, 40)}`,
          status: "ACTIVE",
          metadata: { source: "integration-test" }
        }
      });
      createdIds.leaderId = leader.id;

      await prisma.leaderWallet.create({
        data: {
          leaderId: leader.id,
          walletAddress: `0x${runId.padEnd(40, "1").slice(0, 40)}`,
          source: "DISCOVERED",
          isPrimary: true,
          isActive: true
        }
      });

      const copyProfile = await prisma.copyProfile.create({
        data: {
          name: `profile-${runId}`,
          followerAddress: `0x${runId.padEnd(40, "2").slice(0, 40)}`,
          status: "ACTIVE",
          defaultRatio: "0.05",
          config: { mode: "integration-test" }
        }
      });
      createdIds.copyProfileId = copyProfile.id;

      await prisma.copyProfileLeader.create({
        data: {
          copyProfileId: copyProfile.id,
          leaderId: leader.id,
          ratio: "0.05",
          status: "ACTIVE",
          settings: { maxExposureUsd: 100 }
        }
      });

      await prisma.leaderTradeEvent.create({
        data: {
          leaderId: leader.id,
          source: "CHAIN",
          triggerId: `${runId}:0`,
          canonicalKey: `legacy:${runId}:0`,
          transactionHash: `0x${runId.padEnd(64, "a").slice(0, 64)}`,
          logIndex: 0,
          leaderFillAtMs: BigInt(Date.now() - 1000),
          wsReceivedAtMs: BigInt(Date.now() - 500),
          detectedAtMs: BigInt(Date.now()),
          marketId: `market-${runId}`,
          tokenId: `token-${runId}`,
          outcome: "YES",
          side: "BUY",
          shares: "10",
          price: "0.57",
          notionalUsd: "5.70",
          payload: { source: "integration-test" }
        }
      });

      await assert.rejects(
        () =>
          prisma.leaderTradeEvent.create({
            data: {
              leaderId: leader.id,
              source: "DATA_API",
              triggerId: `${runId}:duplicate-canonical`,
              canonicalKey: `legacy:${runId}:0`,
              transactionHash: `0x${runId.padEnd(64, "b").slice(0, 64)}`,
              logIndex: 1,
              leaderFillAtMs: BigInt(Date.now() - 900),
              wsReceivedAtMs: null,
              detectedAtMs: BigInt(Date.now()),
              marketId: `market-${runId}`,
              tokenId: `token-${runId}`,
              outcome: "YES",
              side: "BUY",
              shares: "10",
              price: "0.57",
              notionalUsd: "5.70",
              payload: { source: "integration-test-duplicate" }
            }
          }),
        (error: unknown) =>
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
      );

      await prisma.leaderPositionSnapshot.create({
        data: {
          leaderId: leader.id,
          snapshotAt: new Date(),
          snapshotAtMs: BigInt(Date.now()),
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          outcome: "YES",
          shares: "12",
          avgPrice: "0.55",
          currentPrice: "0.58",
          initialValueUsd: "6.60",
          currentValueUsd: "6.96",
          cashPnlUsd: "0.36",
          realizedPnlUsd: "0.00"
        }
      });

      await prisma.followerPositionSnapshot.create({
        data: {
          copyProfileId: copyProfile.id,
          snapshotAt: new Date(),
          snapshotAtMs: BigInt(Date.now()),
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          outcome: "YES",
          shares: "0.6",
          avgCostUsd: "0.56",
          currentPrice: "0.58",
          costBasisUsd: "0.34",
          currentValueUsd: "0.35",
          unrealizedPnlUsd: "0.01"
        }
      });

      const pendingDelta = await prisma.pendingDelta.create({
        data: {
          copyProfileId: copyProfile.id,
          leaderId: leader.id,
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          side: "BUY",
          pendingDeltaShares: "1.25",
          pendingDeltaNotionalUsd: "0.71",
          minExecutableNotionalUsd: "1.00",
          status: "PENDING",
          expiresAt: new Date(Date.now() + 60_000)
        }
      });
      createdIds.pendingDeltaId = pendingDelta.id;

      const copyAttempt = await prisma.copyAttempt.create({
        data: {
          copyProfileId: copyProfile.id,
          leaderId: leader.id,
          pendingDeltaId: pendingDelta.id,
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          side: "BUY",
          status: "PENDING",
          decision: "PENDING",
          accumulatedDeltaShares: "1.25",
          accumulatedDeltaNotionalUsd: "0.71",
          idempotencyKey: `attempt-${runId}`,
          retries: 0,
          maxRetries: 20,
          expiresAt: new Date(Date.now() + 60_000)
        }
      });
      createdIds.copyAttemptId = copyAttempt.id;

      const copyOrder = await prisma.copyOrder.create({
        data: {
          copyProfileId: copyProfile.id,
          copyAttemptId: copyAttempt.id,
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          side: "BUY",
          orderType: "FAK",
          intendedNotionalUsd: "1.05",
          intendedShares: "1.80",
          priceLimit: "0.59",
          leaderWeights: {
            [leader.id]: 1
          },
          idempotencyKey: `order-${runId}`,
          externalOrderId: `ext-order-${runId}`,
          status: "PLACED"
        }
      });
      createdIds.copyOrderId = copyOrder.id;

      const copyFill = await prisma.copyFill.create({
        data: {
          copyOrderId: copyOrder.id,
          externalTradeId: `ext-trade-${runId}`,
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          side: "BUY",
          filledShares: "1.80",
          filledUsdc: "1.02",
          feeUsdc: "0.01",
          avgPrice: "0.57",
          filledAt: new Date()
        }
      });
      createdIds.copyFillId = copyFill.id;

      await prisma.copyFillAllocation.create({
        data: {
          copyFillId: copyFill.id,
          copyOrderId: copyOrder.id,
          leaderId: leader.id,
          tokenId: `token-${runId}`,
          sharesDelta: "1.80",
          usdcDelta: "1.01",
          feeUsdcDelta: "0.01",
          avgPrice: "0.57"
        }
      });

      await prisma.leaderTokenLedger.create({
        data: {
          leaderId: leader.id,
          tokenId: `token-${runId}`,
          marketId: `market-${runId}`,
          shares: "1.80",
          costUsd: "1.02"
        }
      });

      await prisma.leaderPnlSummary.create({
        data: {
          leaderId: leader.id,
          realizedPnlUsd: "0.00"
        }
      });

      await prisma.portfolioSnapshot.create({
        data: {
          copyProfileId: copyProfile.id,
          snapshotAt: new Date(),
          snapshotAtMs: BigInt(Date.now()),
          granularity: "RAW_1M",
          exposureUsd: "1.02",
          totalValueUsd: "1.03",
          realizedPnlUsd: "0.00",
          unrealizedPnlUsd: "0.01",
          totalPnlUsd: "0.01"
        }
      });

      await prisma.systemStatus.upsert({
        where: { component: "WORKER" },
        update: {
          status: "OK",
          details: { source: "integration-test" }
        },
        create: {
          component: "WORKER",
          status: "OK",
          details: { source: "integration-test" }
        }
      });

      await prisma.heartbeat.create({
        data: {
          component: "WORKER",
          status: "OK",
          latencyMs: 12,
          payload: { source: "integration-test" }
        }
      });

      await prisma.errorEvent.create({
        data: {
          component: "WORKER",
          severity: "ERROR",
          code: "IT_SAMPLE",
          message: "integration test sample error",
          context: { sample: true },
          relatedLeaderId: leader.id,
          relatedTokenId: `token-${runId}`,
          relatedOrderId: copyOrder.id
        }
      });

      await prisma.configAuditLog.create({
        data: {
          scope: "COPY_PROFILE",
          scopeRefId: copyProfile.id,
          copyProfileId: copyProfile.id,
          changedBy: "integration-test",
          changeType: "UPDATED",
          previousValue: { defaultRatio: "0.04" },
          nextValue: { defaultRatio: "0.05" },
          reason: "test update"
        }
      });

      const [leaderTrades, attempts, orders, allocations] = await Promise.all([
        prisma.leaderTradeEvent.findMany({
          where: { leaderId: leader.id },
          orderBy: { leaderFillAtMs: "desc" }
        }),
        prisma.copyAttempt.findMany({
          where: { status: "PENDING" },
          orderBy: { createdAt: "desc" }
        }),
        prisma.copyOrder.findMany({
          where: { status: "PLACED" },
          orderBy: { createdAt: "desc" }
        }),
        prisma.copyFillAllocation.findMany({
          where: { tokenId: `token-${runId}` },
          orderBy: { allocatedAt: "desc" }
        })
      ]);

      assert.equal(leaderTrades.length, 1);
      assert.equal(attempts.length, 1);
      assert.equal(orders.length, 1);
      assert.equal(allocations.length, 1);
      assert.equal(allocations[0]?.leaderId, leader.id);
    } finally {
      if (createdIds.copyFillId) {
        await prisma.copyFillAllocation.deleteMany({ where: { copyFillId: createdIds.copyFillId } });
        await prisma.copyFill.deleteMany({ where: { id: createdIds.copyFillId } });
      }

      if (createdIds.copyOrderId) {
        await prisma.copyOrder.deleteMany({ where: { id: createdIds.copyOrderId } });
      }

      if (createdIds.copyAttemptId) {
        await prisma.copyAttempt.deleteMany({ where: { id: createdIds.copyAttemptId } });
      }

      if (createdIds.pendingDeltaId) {
        await prisma.pendingDelta.deleteMany({ where: { id: createdIds.pendingDeltaId } });
      }

      if (createdIds.leaderId) {
        await prisma.errorEvent.deleteMany({ where: { relatedLeaderId: createdIds.leaderId } });
        await prisma.leaderPnlSummary.deleteMany({ where: { leaderId: createdIds.leaderId } });
        await prisma.leaderTokenLedger.deleteMany({ where: { leaderId: createdIds.leaderId } });
        await prisma.leaderPositionSnapshot.deleteMany({ where: { leaderId: createdIds.leaderId } });
        await prisma.leaderTradeEvent.deleteMany({ where: { leaderId: createdIds.leaderId } });
        await prisma.copyProfileLeader.deleteMany({ where: { leaderId: createdIds.leaderId } });
        await prisma.leaderWallet.deleteMany({ where: { leaderId: createdIds.leaderId } });
      }

      if (createdIds.copyProfileId) {
        await prisma.configAuditLog.deleteMany({ where: { copyProfileId: createdIds.copyProfileId } });
        await prisma.portfolioSnapshot.deleteMany({ where: { copyProfileId: createdIds.copyProfileId } });
        await prisma.followerPositionSnapshot.deleteMany({ where: { copyProfileId: createdIds.copyProfileId } });
        await prisma.copyProfile.deleteMany({ where: { id: createdIds.copyProfileId } });
      }

      await prisma.heartbeat.deleteMany({ where: { payload: { path: ["source"], equals: "integration-test" } } });
      await prisma.systemStatus.deleteMany({ where: { details: { path: ["source"], equals: "integration-test" } } });
      await prisma.$disconnect();
    }
  });
}
