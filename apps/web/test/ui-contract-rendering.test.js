import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

test('dashboard pages handle loading/error/empty API contract states', () => {
  const pages = [
    'app/leaders/page.tsx',
    'app/trades/page.tsx',
    'app/portfolio/page.tsx',
    'app/copies/page.tsx',
    'app/status/page.tsx',
    'app/config/page.tsx'
  ]

  for (const page of pages) {
    const source = readWorkspaceFile(page)
    assert.match(source, /LoadingState/)
    assert.match(source, /ErrorState/)
    assert.match(source, /EmptyState/)
  }
})

test('api routes use contract envelope helpers', () => {
  const routes = [
    'app/api/v1/overview/route.ts',
    'app/api/v1/leaders/route.ts',
    'app/api/v1/trades/route.ts',
    'app/api/v1/portfolio/route.ts',
    'app/api/v1/copies/route.ts',
    'app/api/v1/config/route.ts',
    'app/api/v1/status/route.ts'
  ]

  for (const route of routes) {
    const source = readWorkspaceFile(route)
    assert.match(source, /jsonContract\(/)
    assert.match(source, /jsonError\(/)
  }
})

test('copies route and page expose live attempting diagnostics', () => {
  const routeSource = readWorkspaceFile('app/api/v1/copies/route.ts')
  assert.match(routeSource, /includeDepth:\s*true/)
  assert.match(routeSource, /liveLeaderPriceUsd/)
  assert.match(routeSource, /livePriceLimitKind/)
  assert.match(routeSource, /liveDepthSufficient/)

  const pageSource = readWorkspaceFile('app/copies/page.tsx')
  assert.match(pageSource, /Leader \/ Mid/)
  assert.match(pageSource, /Cap\/Floor/)
  assert.match(pageSource, /Depth within limit/)
  assert.match(pageSource, /Depth sufficient:/)
})
