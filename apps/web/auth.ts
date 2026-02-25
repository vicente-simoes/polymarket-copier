import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import { getWebAuthEnv } from '@/lib/server/auth-env'

const env = getWebAuthEnv()

function parseAllowedUsers(value: string): Set<string> {
  return new Set(
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0)
  )
}

function getGitHubLogin(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') {
    return null
  }

  const login = (profile as { login?: unknown }).login
  return typeof login === 'string' && login.trim().length > 0 ? login.trim().toLowerCase() : null
}

const allowedUsers = parseAllowedUsers(env.AUTH_GITHUB_ALLOWED_USERS)

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.AUTH_SECRET,
  trustHost: true,
  pages: {
    signIn: '/login',
    error: '/login'
  },
  session: {
    strategy: 'jwt'
  },
  providers: [
    GitHub({
      clientId: env.AUTH_GITHUB_ID,
      clientSecret: env.AUTH_GITHUB_SECRET
    })
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (!account || account.provider !== 'github') {
        return false
      }

      const login = getGitHubLogin(profile)
      if (!login) {
        return false
      }

      return allowedUsers.has(login)
    },
    async redirect({ url, baseUrl }) {
      if (url.startsWith('/')) {
        return `${baseUrl}${url}`
      }

      try {
        const parsed = new URL(url)
        if (parsed.origin === baseUrl) {
          return url
        }
      } catch {
        return baseUrl
      }

      return baseUrl
    }
  }
})
