import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { jsonContract, jsonError, toNumber } from '@/lib/server/api'
import {
  DEFAULT_RUNTIME_OPS_CONFIG,
  DEFAULT_SYSTEM_CONFIG,
  RuntimeOpsConfigSchema,
  SystemConfigPatchSchema,
  SystemConfigSchema,
  applyGlobalRuntimeOverrides,
  applyRuntimeOpsPatch,
  applySystemConfigPatch,
  equalGlobalRuntimeConfig,
  resolveEffectiveRuntimeOpsConfig,
  resolveGlobalRuntimeConfig,
  resolveSystemConfig,
  toGlobalRuntimeConfigValueWithOps,
  toRuntimeOpsConfigRecord
} from '@/lib/server/config'
import { prisma } from '@/lib/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const GLOBAL_RUNTIME_CONFIG_ID = 'global'

interface SqlClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
  $executeRaw(query: Prisma.Sql): Promise<number>
}

const ConfigDataSchema = z.object({
  copyProfileId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  config: SystemConfigSchema,
  defaults: SystemConfigSchema,
  runtimeOps: RuntimeOpsConfigSchema,
  runtimeOpsDefaults: RuntimeOpsConfigSchema
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const requestedProfileId = url.searchParams.get('copyProfileId')

    const [copyProfile, globalRuntimeRow] = await Promise.all([
      requestedProfileId
        ? await prisma.copyProfile.findUnique({
            where: {
              id: requestedProfileId
            },
            select: {
              id: true,
              config: true,
              defaultRatio: true,
              updatedAt: true
            }
          })
        : await prisma.copyProfile.findFirst({
            where: {
              status: {
                in: ['ACTIVE', 'PAUSED']
              }
            },
            orderBy: {
              createdAt: 'asc'
            },
            select: {
              id: true,
              config: true,
              defaultRatio: true,
              updatedAt: true
            }
          }),
      readGlobalRuntimeConfigRow(prisma)
    ])
    const globalRuntimeOverrides = resolveGlobalRuntimeConfig(globalRuntimeRow?.config)
    const runtimeOps = resolveEffectiveRuntimeOpsConfig(globalRuntimeOverrides.runtimeOps)

    if (!copyProfile) {
      return jsonContract(ConfigDataSchema, {
        copyProfileId: null,
        updatedAt: globalRuntimeRow?.updatedAt.toISOString() ?? null,
        config: applyGlobalRuntimeOverrides(DEFAULT_SYSTEM_CONFIG, globalRuntimeOverrides),
        defaults: DEFAULT_SYSTEM_CONFIG,
        runtimeOps,
        runtimeOpsDefaults: DEFAULT_RUNTIME_OPS_CONFIG
      })
    }

    const profileConfig = resolveSystemConfig(copyProfile.config, toNumber(copyProfile.defaultRatio))
    const resolvedConfig = applyGlobalRuntimeOverrides(profileConfig, globalRuntimeOverrides)

    return jsonContract(
      ConfigDataSchema,
      {
        copyProfileId: copyProfile.id,
        updatedAt: maxUpdatedAt(copyProfile.updatedAt, globalRuntimeRow?.updatedAt),
        config: resolvedConfig,
        defaults: DEFAULT_SYSTEM_CONFIG,
        runtimeOps,
        runtimeOpsDefaults: DEFAULT_RUNTIME_OPS_CONFIG
      },
      {
        cacheSeconds: 5
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'CONFIG_CONTRACT_FAILED', 'Config response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'CONFIG_READ_FAILED', toErrorMessage(error))
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const requestedProfileId = url.searchParams.get('copyProfileId')
    const body = SystemConfigPatchSchema.parse(await request.json())

    const profile =
      requestedProfileId
        ? await prisma.copyProfile.findUnique({
            where: {
              id: requestedProfileId
            },
            select: {
              id: true,
              config: true,
              defaultRatio: true
            }
          })
        : await prisma.copyProfile.findFirst({
            where: {
              status: {
                in: ['ACTIVE', 'PAUSED']
              }
            },
            orderBy: {
              createdAt: 'asc'
            },
            select: {
              id: true,
              config: true,
              defaultRatio: true
            }
          })

    if (!profile) {
      return jsonError(409, 'NO_COPY_PROFILE', 'Cannot update config because no copy profile exists yet.')
    }

    const previousConfig = resolveSystemConfig(profile.config, toNumber(profile.defaultRatio))
    const nextConfig = applySystemConfigPatch(previousConfig, body)

    await prisma.$transaction(async (tx) => {
      const previousGlobalRuntimeRow = await readGlobalRuntimeConfigRow(tx as unknown as SqlClient)
      const previousGlobalRuntime = previousGlobalRuntimeRow?.config
        ? resolveGlobalRuntimeConfig(previousGlobalRuntimeRow.config)
        : resolveGlobalRuntimeConfig(toGlobalRuntimeConfigValueWithOps(previousConfig, DEFAULT_RUNTIME_OPS_CONFIG))

      const previousRuntimeOps = resolveEffectiveRuntimeOpsConfig(previousGlobalRuntime.runtimeOps)
      const nextRuntimeOps = applyRuntimeOpsPatch(previousRuntimeOps, body.runtimeOps ?? {})
      const nextGlobalRuntimeConfig = toGlobalRuntimeConfigValueWithOps(nextConfig, nextRuntimeOps)
      const nextGlobalRuntime = resolveGlobalRuntimeConfig(nextGlobalRuntimeConfig)

      await tx.copyProfile.update({
        where: {
          id: profile.id
        },
        data: {
          defaultRatio: String(nextConfig.sizing.copyRatio),
          config: nextConfig
        }
      })

      if (body.applyRatioToExistingLeaders) {
        await tx.copyProfileLeader.updateMany({
          where: {
            copyProfileId: profile.id,
            status: {
              in: ['ACTIVE', 'PAUSED']
            }
          },
          data: {
            ratio: String(nextConfig.sizing.copyRatio)
          }
        })
      }

      await tx.configAuditLog.create({
        data: {
          scope: 'COPY_PROFILE',
          scopeRefId: profile.id,
          copyProfileId: profile.id,
          changedBy: body.changedBy ?? request.headers.get('x-user') ?? null,
          changeType: 'UPDATED',
          previousValue: previousConfig,
          nextValue: nextConfig,
          reason: body.reason ?? null
        }
      })

      await upsertGlobalRuntimeConfigRow(tx as unknown as SqlClient, nextGlobalRuntimeConfig)

      if (!equalGlobalRuntimeConfig(previousGlobalRuntime, nextGlobalRuntime)) {
        await tx.configAuditLog.create({
          data: {
            scope: 'GLOBAL',
            scopeRefId: GLOBAL_RUNTIME_CONFIG_ID,
            copyProfileId: null,
            changedBy: body.changedBy ?? request.headers.get('x-user') ?? null,
            changeType: 'UPDATED',
            previousValue: toJsonValue(
              toGlobalRuntimeConfigRecord({
                tradeDetectionEnabled: previousGlobalRuntime.tradeDetectionEnabled,
                userChannelWsEnabled: previousGlobalRuntime.userChannelWsEnabled,
                reconcileIntervalSeconds: previousGlobalRuntime.reconcileIntervalSeconds,
                runtimeOps: resolveEffectiveRuntimeOpsConfig(previousGlobalRuntime.runtimeOps)
              })
            ),
            nextValue: toJsonValue(
              toGlobalRuntimeConfigRecord({
                tradeDetectionEnabled: nextGlobalRuntime.tradeDetectionEnabled,
                userChannelWsEnabled: nextGlobalRuntime.userChannelWsEnabled,
                reconcileIntervalSeconds: nextGlobalRuntime.reconcileIntervalSeconds,
                runtimeOps: resolveEffectiveRuntimeOpsConfig(nextGlobalRuntime.runtimeOps)
              })
            ),
            reason: body.reason ?? null
          }
        })
      }
    })

    const [updatedProfile, globalRuntimeRow] = await Promise.all([
      prisma.copyProfile.findUnique({
        where: {
          id: profile.id
        },
        select: {
          id: true,
          config: true,
          defaultRatio: true,
          updatedAt: true
        }
      }),
      readGlobalRuntimeConfigRow(prisma)
    ])

    const profileConfig = updatedProfile
      ? resolveSystemConfig(updatedProfile.config, toNumber(updatedProfile.defaultRatio))
      : nextConfig
    const globalRuntimeOverrides = resolveGlobalRuntimeConfig(globalRuntimeRow?.config)
    const resolvedConfig = applyGlobalRuntimeOverrides(profileConfig, globalRuntimeOverrides)

    return jsonContract(ConfigDataSchema, {
      copyProfileId: updatedProfile?.id ?? profile.id,
      updatedAt: maxUpdatedAt(updatedProfile?.updatedAt, globalRuntimeRow?.updatedAt),
      config: resolvedConfig,
      defaults: DEFAULT_SYSTEM_CONFIG,
      runtimeOps: resolveEffectiveRuntimeOpsConfig(globalRuntimeOverrides.runtimeOps),
      runtimeOpsDefaults: DEFAULT_RUNTIME_OPS_CONFIG
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(400, 'INVALID_REQUEST_BODY', 'Request body failed validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'CONFIG_UPDATE_FAILED', toErrorMessage(error))
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function toGlobalRuntimeConfigRecord(config: {
  tradeDetectionEnabled?: boolean
  userChannelWsEnabled?: boolean
  reconcileIntervalSeconds?: number
  runtimeOps: ReturnType<typeof resolveEffectiveRuntimeOpsConfig>
}): Record<string, unknown> {
  return {
    masterSwitches: {
      ...(config.tradeDetectionEnabled !== undefined ? { tradeDetectionEnabled: config.tradeDetectionEnabled } : {}),
      ...(config.userChannelWsEnabled !== undefined ? { userChannelWsEnabled: config.userChannelWsEnabled } : {})
    },
    reconcile: {
      ...(config.reconcileIntervalSeconds !== undefined ? { intervalSeconds: config.reconcileIntervalSeconds } : {})
    },
    ...toRuntimeOpsConfigRecord(config.runtimeOps)
  }
}

function maxUpdatedAt(left: Date | null | undefined, right: Date | null | undefined): string | null {
  if (left && right) {
    return (left.getTime() >= right.getTime() ? left : right).toISOString()
  }
  return (left ?? right)?.toISOString() ?? null
}

async function readGlobalRuntimeConfigRow(client: SqlClient): Promise<{ config: unknown; updatedAt: Date } | null> {
  let rows: Array<{ config: Prisma.JsonValue | null; updatedAt: Date }>
  try {
    rows = await client.$queryRaw<Array<{ config: Prisma.JsonValue | null; updatedAt: Date }>>(
      Prisma.sql`
        SELECT "config", "updatedAt"
        FROM "GlobalRuntimeConfig"
        WHERE "id" = ${GLOBAL_RUNTIME_CONFIG_ID}
        LIMIT 1
      `
    )
  } catch {
    return null
  }
  const row = rows[0]
  if (!row) {
    return null
  }
  return {
    config: row.config,
    updatedAt: row.updatedAt
  }
}

async function upsertGlobalRuntimeConfigRow(client: SqlClient, config: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(config)
  await client.$executeRaw(
    Prisma.sql`
      INSERT INTO "GlobalRuntimeConfig" ("id", "config", "createdAt", "updatedAt")
      VALUES (${GLOBAL_RUNTIME_CONFIG_ID}, CAST(${payload} AS jsonb), NOW(), NOW())
      ON CONFLICT ("id")
      DO UPDATE SET
        "config" = CAST(${payload} AS jsonb),
        "updatedAt" = NOW()
    `
  )
}

function toJsonValue(value: Record<string, unknown>): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
