import { z } from 'zod'

const PositiveNumberSchema = z.number().positive()

export const LeaderSettingsSchema = z
  .object({
    allowList: z.array(z.string().trim().min(1)).optional(),
    denyList: z.array(z.string().trim().min(1)).optional(),
    maxExposurePerLeaderUsd: PositiveNumberSchema.optional(),
    maxExposurePerMarketOutcomeUsd: PositiveNumberSchema.optional(),
    maxDailyNotionalTurnoverUsd: PositiveNumberSchema.optional(),
    maxSlippageBps: z.number().int().nonnegative().optional(),
    maxPricePerShareUsd: PositiveNumberSchema.nullable().optional(),
    minNotionalPerOrderUsd: PositiveNumberSchema.optional(),
    minDeltaNotionalUsd: PositiveNumberSchema.optional(),
    minDeltaShares: PositiveNumberSchema.optional()
  })
  .strict()

export type LeaderSettings = z.infer<typeof LeaderSettingsSchema>

export function normalizeLeaderSettings(value: unknown): LeaderSettings {
  const parsed = LeaderSettingsSchema.safeParse(value)
  if (!parsed.success) {
    return {}
  }
  return parsed.data
}
