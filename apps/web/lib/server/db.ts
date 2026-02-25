import { PrismaClient } from '@prisma/client'

declare global {
  // eslint-disable-next-line no-var
  var __copybotPrisma: PrismaClient | undefined
}

export const prisma = globalThis.__copybotPrisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalThis.__copybotPrisma = prisma
}
