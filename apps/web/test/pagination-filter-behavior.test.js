import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

test('query builders encode pagination and filter params for dashboard pages', () => {
  const source = readWorkspaceFile('lib/dashboard/query-builders.ts')
  assert.match(source, /pageSize/)
  assert.match(source, /buildLeadersQuery/)
  assert.match(source, /buildTradesQuery/)
  assert.match(source, /buildCopiesQuery/)
  assert.match(source, /buildPortfolioQuery/)
  assert.match(source, /params\.set\('page'/)
  assert.match(source, /params\.set\('pageSize'/)
  assert.match(source, /appendIfPresent\(params, 'search'/)
  assert.match(source, /params\.set\('status'/)
  assert.match(source, /params\.set\('source'/)
  assert.match(source, /appendIfPresent\(params, 'tokenId'/)
})

test('pages use shared query builders instead of ad-hoc query string construction', () => {
  const checks = [
    { path: 'app/leaders/page.tsx', builder: 'buildLeadersQuery' },
    { path: 'app/trades/page.tsx', builder: 'buildTradesQuery' },
    { path: 'app/copies/page.tsx', builder: 'buildCopiesQuery' },
    { path: 'app/portfolio/page.tsx', builder: 'buildPortfolioQuery' }
  ]

  for (const check of checks) {
    const source = readWorkspaceFile(check.path)
    assert.match(source, new RegExp(check.builder))
    assert.match(source, /pageSize: 50/)
  }
})

test('table-driven pages keep explicit pagination controls in the UI', () => {
  const pages = [
    'app/leaders/page.tsx',
    'app/trades/page.tsx',
    'app/copies/page.tsx',
    'app/portfolio/page.tsx',
    'app/config/page.tsx'
  ]

  for (const page of pages) {
    const source = readWorkspaceFile(page)
    assert.match(source, /PaginationControls/)
  }
})
