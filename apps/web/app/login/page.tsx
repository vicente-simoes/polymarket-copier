import { redirect } from 'next/navigation'
import { auth, signIn } from '@/auth'

type RawSearchParams = Record<string, string | string[] | undefined>

interface LoginPageProps {
  searchParams?: RawSearchParams | Promise<RawSearchParams>
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value
}

async function resolveSearchParams(input: LoginPageProps['searchParams']): Promise<RawSearchParams> {
  if (!input) {
    return {}
  }

  if (isPromiseLike<RawSearchParams>(input)) {
    return input
  }

  return input
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : null
  }

  return null
}

function sanitizeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/')) {
    return '/'
  }

  if (value.startsWith('//')) {
    return '/'
  }

  return value
}

function errorMessage(error: string | null): string | null {
  if (error === 'AccessDenied') {
    return 'Your GitHub account is not allowlisted for this dashboard.'
  }

  if (error === 'Configuration') {
    return 'GitHub authentication is not configured correctly on the server.'
  }

  if (error) {
    return `Authentication failed: ${error}`
  }

  return null
}

export default async function LoginPage(props: LoginPageProps) {
  const searchParams = await resolveSearchParams(props.searchParams)
  const nextPath = sanitizeNextPath(firstParam(searchParams.next))
  const error = firstParam(searchParams.error)
  const session = await auth()

  if (session) {
    redirect(nextPath)
  }

  const message = errorMessage(error)

  async function signInWithGitHub() {
    'use server'

    await signIn('github', {
      redirectTo: nextPath
    })
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/4 top-16 h-64 w-64 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="absolute bottom-12 right-12 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl items-center px-4 py-10">
        <div className="grid w-full gap-6 md:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-3xl border border-white/10 bg-[#0D0D0D]/95 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur md:p-8">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">PolymarketSpy</p>
            <h1 className="mt-3 text-3xl font-semibold text-[#E7E7E7] md:text-4xl">Dashboard access</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-[#A1A1A1]">
              Sign in with GitHub to access the control and observability dashboard. Only allowlisted GitHub usernames can
              enter.
            </p>

            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-[#919191]">What you get</p>
              <ul className="mt-3 space-y-2 text-sm text-[#CFCFCF]">
                <li>Protected dashboard pages and API endpoints</li>
                <li>Public health endpoint stays available for probes</li>
                <li>Return-to-page redirect after successful login</li>
              </ul>
            </div>
          </section>

          <section className="rounded-3xl border border-white/10 bg-[#0D0D0D]/95 p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur md:p-8">
            <p className="text-xs uppercase tracking-[0.22em] text-[#919191]">Authentication</p>
            <h2 className="mt-3 text-xl font-semibold text-[#E7E7E7]">GitHub OAuth</h2>
            <p className="mt-2 text-sm leading-6 text-[#A1A1A1]">
              Continue with your GitHub account. Your GitHub username must be in the server allowlist.
            </p>

            {message ? (
              <div className="mt-5 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                {message}
              </div>
            ) : null}

            <form action={signInWithGitHub} className="mt-6">
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center rounded-xl border border-white/15 bg-white/[0.04] px-4 py-3 text-sm font-medium text-white transition hover:bg-white/[0.08]"
              >
                Continue with GitHub
              </button>
            </form>

            <p className="mt-4 text-xs leading-5 text-[#8A8A8A]">
              If access is denied, add your GitHub username to <code>AUTH_GITHUB_ALLOWED_USERS</code> and restart the web app.
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
