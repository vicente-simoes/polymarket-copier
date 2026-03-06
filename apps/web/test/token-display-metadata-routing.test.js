const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')

const routeFiles = [
  'app/api/v1/copies/route.ts',
  'app/api/v1/trades/route.ts',
  'app/api/v1/overview/route.ts',
  'app/api/v1/portfolio/route.ts',
  'app/api/v1/leaders/[leaderId]/route.ts'
]

test('web token metadata routes use the centralized resolver', () => {
  for (const relativePath of routeFiles) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    assert.match(source, /resolveTokenDisplayMetadata/)
  }
})

test('web token metadata routes no longer contain duplicated historical lookup helpers', () => {
  const assertions = [
    ['app/api/v1/copies/route.ts', /resolveTokenMetadataByToken|extractMarketMetadataFromPayload|buildPolymarketEventPath/],
    ['app/api/v1/trades/route.ts', /resolveTradeTokenMetadata|extractMarketMetadataFromPayload|buildPolymarketEventPath/],
    ['app/api/v1/overview/route.ts', /resolveOverviewTokenMetadata|extractOverviewMarketMetadataFromPayload/],
    ['app/api/v1/portfolio/route.ts', /resolveMarketNamesByToken|extractMarketNameFromPayload/],
    ['app/api/v1/leaders/\[leaderId\]\/route.ts', /resolveLeaderDetailTokenMetadata|extractMarketMetadataFromPayload|buildPolymarketEventPath/]
  ]

  for (const [relativePath, pattern] of assertions) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    assert.doesNotMatch(source, pattern)
  }
})

test('centralized token metadata resolver uses TokenMetadata table with fallback queries', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib/server/token-display-metadata.ts'), 'utf8')
  assert.match(source, /prisma\.tokenMetadata\.findMany/)
  assert.match(source, /SELECT DISTINCT ON \("tokenId"\)/)
  assert.match(source, /token_metadata\.fallback_used/)
})

test('dashboard api routes memoize computed payloads', () => {
  const memoizedRoutes = [
    'app/api/v1/copies/route.ts',
    'app/api/v1/trades/route.ts',
    'app/api/v1/overview/route.ts',
    'app/api/v1/portfolio/route.ts',
    'app/api/v1/leaders/route.ts',
    'app/api/v1/leaders/[leaderId]/route.ts',
    'app/api/v1/status/route.ts'
  ]

  for (const relativePath of memoizedRoutes) {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
    assert.match(source, /memoizeAsync/)
  }
})

test('portfolio position detail page uses the combined detail endpoint', () => {
  const routeSource = fs.readFileSync(
    path.join(repoRoot, 'app/api/v1/portfolio/positions/[tokenId]/detail/route.ts'),
    'utf8'
  )
  const pageSource = fs.readFileSync(
    path.join(repoRoot, 'app/portfolio/positions/[tokenId]/page.tsx'),
    'utf8'
  )

  assert.match(routeSource, /position:\s*z/)
  assert.match(routeSource, /openAttempts/)
  assert.match(routeSource, /skippedAttempts/)
  assert.match(pageSource, /\/api\/v1\/portfolio\/positions\/\$\{encodeURIComponent\(tokenId\)\}\/detail/)
  assert.doesNotMatch(pageSource, /\/api\/v1\/copies\?section=/)
})
