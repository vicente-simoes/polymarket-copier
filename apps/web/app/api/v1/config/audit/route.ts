import { NextRequest } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { jsonContract, jsonError, paginationMeta, parsePagination } from '@/lib/server/api'
import { prisma } from '@/lib/server/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ConfigAuditDataSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      scope: z.enum(['GLOBAL', 'LEADER', 'COPY_PROFILE', 'SYSTEM']),
      scopeRefId: z.string().nullable(),
      copyProfileId: z.string().nullable(),
      changedBy: z.string().nullable(),
      changeType: z.enum(['CREATED', 'UPDATED', 'DELETED']),
      previousValue: z.record(z.string(), z.unknown()).nullable(),
      nextValue: z.record(z.string(), z.unknown()).nullable(),
      reason: z.string().nullable(),
      createdAt: z.string()
    })
  ),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().positive()
  })
})

const ConfigAuditScopeSchema = z.enum(['GLOBAL', 'LEADER', 'COPY_PROFILE', 'SYSTEM'])

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url)
    const pagination = parsePagination(url)
    const copyProfileId = url.searchParams.get('copyProfileId')?.trim()
    const parsedScope = ConfigAuditScopeSchema.safeParse(url.searchParams.get('scope'))
    const scope = parsedScope.success ? parsedScope.data : undefined

    const where: Prisma.ConfigAuditLogWhereInput = {
      ...(copyProfileId ? { copyProfileId } : {}),
      ...(scope ? { scope } : {})
    }

    const [total, rows] = await Promise.all([
      prisma.configAuditLog.count({
        where
      }),
      prisma.configAuditLog.findMany({
        where,
        orderBy: {
          createdAt: 'desc'
        },
        skip: pagination.skip,
        take: pagination.pageSize,
        select: {
          id: true,
          scope: true,
          scopeRefId: true,
          copyProfileId: true,
          changedBy: true,
          changeType: true,
          previousValue: true,
          nextValue: true,
          reason: true,
          createdAt: true
        }
      })
    ])

    return jsonContract(
      ConfigAuditDataSchema,
      {
        items: rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          scopeRefId: row.scopeRefId,
          copyProfileId: row.copyProfileId,
          changedBy: row.changedBy,
          changeType: row.changeType,
          previousValue: asObjectOrNull(row.previousValue),
          nextValue: asObjectOrNull(row.nextValue),
          reason: row.reason,
          createdAt: row.createdAt.toISOString()
        })),
        pagination: paginationMeta(pagination, total)
      },
      {
        cacheSeconds: 5
      }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonError(500, 'CONFIG_AUDIT_CONTRACT_FAILED', 'Config audit response failed contract validation.', {
        issues: error.issues
      })
    }
    return jsonError(500, 'CONFIG_AUDIT_FAILED', toErrorMessage(error))
  }
}

function asObjectOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
