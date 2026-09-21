import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

const guard = resolve(import.meta.dirname, '..', 'tools', 'validate-static-asset-contract.mjs')
const fixtures: string[] = []

function fixture(options: Readonly<{ assetsDirectory?: string; builtEntrypoint?: string; includeBuiltAsset?: boolean }> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sygshift-static-assets-'))
  fixtures.push(root)
  const assetsDirectory = options.assetsDirectory ?? './dist/client/'
  const builtEntrypoint = options.builtEntrypoint ?? '/assets/index-test.js'
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'dist', 'client', 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/src/main.tsx"></script>')
  writeFileSync(join(root, 'src', 'main.tsx'), 'export {}')
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ assets: { directory: assetsDirectory } }))
  writeFileSync(join(root, 'dist', 'client', 'index.html'), `<script type="module" src="${builtEntrypoint}"></script>`)
  if (options.includeBuiltAsset !== false) writeFileSync(join(root, 'dist', 'client', builtEntrypoint.slice(1)), 'export {}')
  return root
}

function runGuard(root: string) {
  const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: 'utf8' })
  return { output: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status ?? 1 }
}

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop()!, { force: true, recursive: true })
})

describe('static asset build guard', () => {
  it('runs as part of the production build handoff', () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    expect(packageJson.scripts?.build).toContain('check:static-assets')
  })

  it('accepts the Vite client entrypoint only when Wrangler serves that build directory', () => {
    const result = runGuard(fixture())
    expect(result.status).toBe(0)
    expect(result.output).toContain('Static asset contract passed')
  })

  it('fails before deploy when Wrangler serves a directory other than Vite client output', () => {
    const result = runGuard(fixture({ assetsDirectory: './dist/wrong/' }))
    expect(result.status).toBe(1)
    expect(result.output).toContain('wrangler assets.directory must be ./dist/client/')
  })

  it('fails before deploy when Vite index.html references a missing client entrypoint asset', () => {
    const result = runGuard(fixture({ includeBuiltAsset: false }))
    expect(result.status).toBe(1)
    expect(result.output).toContain('Vite client module entrypoint /assets/index-test.js is missing')
  })
})
