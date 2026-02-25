import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(relativePath) {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

test('portrait-mobile table fallbacks exist for table-heavy pages', () => {
  const pages = [
    'app/leaders/page.tsx',
    'app/trades/page.tsx',
    'app/portfolio/page.tsx',
    'app/copies/page.tsx',
    'app/config/page.tsx'
  ]

  for (const page of pages) {
    const source = readWorkspaceFile(page)
    assert.match(source, /hidden md:block/)
    assert.match(source, /md:hidden/)
  }
})
