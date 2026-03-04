import { Prisma, PrismaClient } from '@prisma/client'
import webConfigModule from '../../../apps/web/lib/server/config.ts'

const { DEFAULT_SYSTEM_CONFIG, resolveSystemConfig } = webConfigModule as {
  DEFAULT_SYSTEM_CONFIG: {
    masterSwitches: {
      tradeDetectionEnabled: boolean
      userChannelWsEnabled: boolean
    }
    reconcile: {
      intervalSeconds: number
    }
  }
  resolveSystemConfig: (
    rawConfig: unknown,
    fallbackRatio: number
  ) => {
    masterSwitches: {
      tradeDetectionEnabled: boolean
      userChannelWsEnabled: boolean
    }
    reconcile: {
      intervalSeconds: number
    }
  }
  DEFAULT_RUNTIME_OPS_CONFIG: Record<string, unknown>
  toGlobalRuntimeConfigValueWithOps: (
    config: {
      masterSwitches: {
        tradeDetectionEnabled: boolean
        userChannelWsEnabled: boolean
      }
      reconcile: {
        intervalSeconds: number
      }
    },
    runtimeOps: Record<string, unknown>
  ) => Record<string, unknown>
}
const { DEFAULT_RUNTIME_OPS_CONFIG, toGlobalRuntimeConfigValueWithOps } = webConfigModule as {
  DEFAULT_RUNTIME_OPS_CONFIG: Record<string, unknown>
  toGlobalRuntimeConfigValueWithOps: (
    config: {
      masterSwitches: {
        tradeDetectionEnabled: boolean
        userChannelWsEnabled: boolean
      }
      reconcile: {
        intervalSeconds: number
      }
    },
    runtimeOps: Record<string, unknown>
  ) => Record<string, unknown>
}

const GLOBAL_RUNTIME_CONFIG_ID = 'global'

async function main(): Promise<void> {
  const prisma = new PrismaClient()
  try {
    const existingRow = (
      await prisma.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT "id"
          FROM "GlobalRuntimeConfig"
          WHERE "id" = ${GLOBAL_RUNTIME_CONFIG_ID}
          LIMIT 1
        `
      )
    )[0]

    if (existingRow) {
      console.log('[seed:global-runtime] global runtime config already exists; no-op')
      return
    }

    const copyProfile = await prisma.copyProfile.findFirst({
      where: {
        status: {
          in: ['ACTIVE', 'PAUSED']
        }
      },
      orderBy: {
        createdAt: 'asc'
      },
      select: {
        config: true,
        defaultRatio: true
      }
    })

    const resolved = copyProfile
      ? resolveSystemConfig(copyProfile.config, Number(copyProfile.defaultRatio))
      : DEFAULT_SYSTEM_CONFIG

    const runtimeConfig = toGlobalRuntimeConfigValueWithOps(resolved, DEFAULT_RUNTIME_OPS_CONFIG)

    const payload = JSON.stringify(runtimeConfig)
    await prisma.$executeRaw(
      Prisma.sql`
        INSERT INTO "GlobalRuntimeConfig" ("id", "config", "createdAt", "updatedAt")
        VALUES (${GLOBAL_RUNTIME_CONFIG_ID}, CAST(${payload} AS jsonb), NOW(), NOW())
      `
    )

    console.log('[seed:global-runtime] seeded GlobalRuntimeConfig from effective system config')
  } finally {
    await prisma.$disconnect()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
