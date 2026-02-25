import { NextResponse } from 'next/server'
import { auth } from '@/auth'

const PUBLIC_FILE_REGEX = /\/[^/]+\.[^/]+$/

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    return true
  }

  if (pathname === '/api/health') {
    return true
  }

  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    return true
  }

  if (pathname.startsWith('/_next/')) {
    return true
  }

  if (PUBLIC_FILE_REGEX.test(pathname)) {
    return true
  }

  return false
}

function unauthorizedApiResponse() {
  return NextResponse.json(
    {
      apiVersion: 'v1',
      generatedAt: new Date().toISOString(),
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required.',
        details: {}
      }
    },
    {
      status: 401,
      headers: {
        'Cache-Control': 'no-store'
      }
    }
  )
}

function redirectToLogin(requestUrl: URL, pathname: string, search: string) {
  const nextPath = `${pathname}${search}` || '/'
  const url = new URL('/login', requestUrl)
  url.searchParams.set('next', nextPath.startsWith('/') ? nextPath : '/')
  return NextResponse.redirect(url)
}

export default auth((req) => {
  const pathname = req.nextUrl.pathname

  if (isPublicPath(pathname)) {
    return NextResponse.next()
  }

  const isProtectedApi = pathname === '/api/v1' || pathname.startsWith('/api/v1/')
  const isProtectedPage = !pathname.startsWith('/api/')

  if (!isProtectedApi && !isProtectedPage) {
    return NextResponse.next()
  }

  if (req.auth) {
    return NextResponse.next()
  }

  if (isProtectedApi) {
    return unauthorizedApiResponse()
  }

  return redirectToLogin(req.nextUrl, pathname, req.nextUrl.search)
})

export const config = {
  matcher: ['/((?!_next/static|_next/image|_next/webpack-hmr).*)']
}
