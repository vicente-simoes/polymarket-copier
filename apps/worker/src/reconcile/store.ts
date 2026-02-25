import { Prisma, PrismaClient } from "@copybot/db";
import type { ReconcileAuditRecord, ReconcileStore } from "./types.js";

export class PrismaReconcileStore implements ReconcileStore {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async listActiveCopyProfileIds(): Promise<string[]> {
    const profiles = await this.prisma.copyProfile.findMany({
      where: {
        status: "ACTIVE"
      },
      orderBy: {
        createdAt: "asc"
      },
      select: {
        id: true
      }
    });

    return profiles.map((profile) => profile.id);
  }

  async rebuildFollowerSnapshot(copyProfileId: string, snapshotAt: Date, snapshotAtMs: number): Promise<{
    tokensSnapshotted: number;
    absoluteSharesSum: number;
  }> {
    const fills = await this.prisma.copyFill.findMany({
      where: {
        copyOrder: {
          copyProfileId
        }
      },
      select: {
        tokenId: true,
        marketId: true,
        side: true,
        filledShares: true
      }
    });

    const byToken = new Map<string, { tokenId: string; marketId?: string; shares: number }>();
    for (const fill of fills) {
      const existing = byToken.get(fill.tokenId) ?? {
        tokenId: fill.tokenId,
        marketId: fill.marketId ?? undefined,
        shares: 0
      };

      if (!existing.marketId && fill.marketId) {
        existing.marketId = fill.marketId;
      }

      const signedShares = fill.side === "BUY" ? Number(fill.filledShares) : -Number(fill.filledShares);
      existing.shares += signedShares;
      byToken.set(fill.tokenId, existing);
    }

    const rows = [...byToken.values()].filter((row) => Math.abs(row.shares) >= 1e-12);
    const absoluteSharesSum = rows.reduce((sum, row) => sum + Math.abs(row.shares), 0);

    await this.prisma.$transaction(async (tx) => {
      if (rows.length > 0) {
        await tx.followerPositionSnapshot.createMany({
          data: rows.map((row) => ({
            copyProfileId,
            snapshotAt,
            snapshotAtMs: BigInt(snapshotAtMs),
            tokenId: row.tokenId,
            marketId: row.marketId ?? null,
            shares: String(row.shares),
            payload: toInputJsonValue({
              source: "RECONCILE_FILLS",
              rebuiltAtMs: snapshotAtMs
            })
          }))
        });
      }

      await tx.heartbeat.create({
        data: {
          component: "WORKER",
          instanceId: "reconcile-engine",
          status: "OK",
          observedAt: snapshotAt,
          payload: toInputJsonValue({
            kind: "FOLLOWER_RECONCILE",
            copyProfileId,
            snapshotAt: snapshotAt.toISOString(),
            snapshotAtMs,
            tokensSnapshotted: rows.length,
            absoluteSharesSum
          })
        }
      });
    });

    return {
      tokensSnapshotted: rows.length,
      absoluteSharesSum
    };
  }

  async getLatestLeaderSnapshotAt(): Promise<Date | null> {
    const aggregate = await this.prisma.leaderPositionSnapshot.aggregate({
      _max: {
        snapshotAt: true
      }
    });

    return aggregate._max.snapshotAt ?? null;
  }

  async getLatestFollowerSnapshotAt(copyProfileId: string): Promise<Date | null> {
    const aggregate = await this.prisma.followerPositionSnapshot.aggregate({
      where: {
        copyProfileId
      },
      _max: {
        snapshotAt: true
      }
    });

    const heartbeatRows = await this.prisma.$queryRaw<Array<{ observedAt: Date }>>`
      SELECT "observedAt"
      FROM "Heartbeat"
      WHERE "component" = 'WORKER'::"ComponentType"
        AND "payload"->>'kind' = 'FOLLOWER_RECONCILE'
        AND "payload"->>'copyProfileId' = ${copyProfileId}
      ORDER BY "observedAt" DESC
      LIMIT 1
    `;

    const snapshotAt = aggregate._max.snapshotAt ?? null;
    const heartbeatAt = heartbeatRows[0]?.observedAt ?? null;
    if (!snapshotAt) {
      return heartbeatAt;
    }
    if (!heartbeatAt) {
      return snapshotAt;
    }
    return snapshotAt.getTime() >= heartbeatAt.getTime() ? snapshotAt : heartbeatAt;
  }

  async countOpenAttemptCollisions(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT "copyProfileId", "tokenId", "side"
        FROM "CopyAttempt"
        WHERE "decision" = 'PENDING'::"AttemptDecision"
          AND "status" IN ('PENDING'::"AttemptStatus", 'RETRYING'::"AttemptStatus", 'EXECUTING'::"AttemptStatus")
        GROUP BY "copyProfileId", "tokenId", "side"
        HAVING COUNT(*) > 1
      ) AS collisions
    `;

    return rows[0]?.count ?? 0;
  }

  async countDuplicateOrderDecisionKeys(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT "copyAttemptId"
        FROM "CopyOrder"
        WHERE "copyAttemptId" IS NOT NULL
          AND "status" IN ('PLACED'::"OrderStatus", 'PARTIALLY_FILLED'::"OrderStatus", 'FILLED'::"OrderStatus")
        GROUP BY "copyAttemptId"
        HAVING COUNT(*) > 1
      ) AS duplicate_attempt_executions
    `;

    return rows[0]?.count ?? 0;
  }

  async writeReconcileAudit(input: ReconcileAuditRecord): Promise<void> {
    const nextHealth = input.status === "OK" ? "OK" : "DEGRADED";
    const latencyMs = asLatency(input.details.durationMs);

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.systemStatus.findUnique({
        where: {
          component: "WORKER"
        },
        select: {
          status: true,
          details: true
        }
      });

      const baseDetails = asObject(existing?.details);
      const nextDetails = {
        ...baseDetails,
        reconcile: {
          cycleAt: input.cycleAt.toISOString(),
          status: input.status,
          ...input.details
        }
      };

      await tx.systemStatus.upsert({
        where: {
          component: "WORKER"
        },
        create: {
          component: "WORKER",
          status: nextHealth,
          lastEventAt: input.cycleAt,
          details: toInputJsonValue(nextDetails)
        },
        update: {
          status: nextHealth,
          lastEventAt: input.cycleAt,
          details: toInputJsonValue(nextDetails)
        }
      });

      await tx.heartbeat.create({
        data: {
          component: "WORKER",
          instanceId: "reconcile-engine",
          status: nextHealth,
          observedAt: input.cycleAt,
          latencyMs,
          payload: toInputJsonValue({
            kind: "RECONCILE_CYCLE",
            status: input.status,
            cycleAt: input.cycleAt.toISOString(),
            ...input.details
          })
        }
      });
    });
  }

  async writeReconcileIssue(input: {
    code: string;
    message: string;
    severity: "WARN" | "ERROR";
    context?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.errorEvent.create({
      data: {
        component: "WORKER",
        severity: input.severity === "WARN" ? "WARN" : "ERROR",
        code: input.code,
        message: input.message,
        context: input.context ? toInputJsonValue(input.context) : undefined
      }
    });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asLatency(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}
