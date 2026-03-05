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
