import { z } from 'zod'

export const WebAuthEnvSchema = z.object({
  AUTH_SECRET: z.string().min(1),
  AUTH_GITHUB_ID: z.string().min(1),
  AUTH_GITHUB_SECRET: z.string().min(1),
  AUTH_GITHUB_ALLOWED_USERS: z.string().min(1),
  AUTH_URL: z.string().url().optional(),
  AUTH_TRUST_HOST: z.string().optional()
})

export type WebAuthEnv = z.infer<typeof WebAuthEnvSchema>

let cachedEnv: WebAuthEnv | null = null

export function getWebAuthEnv(input: NodeJS.ProcessEnv = process.env): WebAuthEnv {
  if (cachedEnv) {
    return cachedEnv
  }

  cachedEnv = WebAuthEnvSchema.parse(input)
  return cachedEnv
}
