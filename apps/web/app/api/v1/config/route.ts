import { NextRequest } from 'next/server'
import { z } from 'zod'
import { jsonContract, jsonError, toNumber } from '@/lib/server/api'
import {
  DEFAULT_SYSTEM_CONFIG,
  SystemConfigPatchSchema,
  SystemConfigSchema,
  applySystemConfigPatch,
  resolveSystemConfig
} from '@/lib/server/config'
import { prisma } from '@/lib/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ConfigDataSchema = z.object({
  copyProfileId: z.string().nullable(),
  updatedAt: z.string().nullable(),
  config: SystemConfigSchema,
  defaults: SystemConfigSchema
})

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const requestedProfileId = url.searchParams.get('copyProfileId')

    const copyProfile =
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
          })

    if (!copyProfile) {
      return jsonContract(ConfigDataSchema, {
        copyProfileId: null,
        updatedAt: null,
        config: DEFAULT_SYSTEM_CONFIG,
        defaults: DEFAULT_SYSTEM_CONFIG
      })
    }

    const resolvedConfig = resolveSystemConfig(copyProfile.config, toNumber(copyProfile.defaultRatio))

    return jsonContract(
      ConfigDataSchema,
      {
        copyProfileId: copyProfile.id,
        updatedAt: copyProfile.updatedAt.toISOString(),
        config: resolvedConfig,
        defaults: DEFAULT_SYSTEM_CONFIG
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
    })

    const updatedProfile = await prisma.copyProfile.findUnique({
      where: {
        id: profile.id
      },
      select: {
        id: true,
        config: true,
        defaultRatio: true,
        updatedAt: true
      }
    })

    const resolvedConfig = resolveSystemConfig(updatedProfile?.config, toNumber(updatedProfile?.defaultRatio))

    return jsonContract(ConfigDataSchema, {
      copyProfileId: updatedProfile?.id ?? profile.id,
      updatedAt: updatedProfile?.updatedAt.toISOString() ?? null,
      config: resolvedConfig,
      defaults: DEFAULT_SYSTEM_CONFIG
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
