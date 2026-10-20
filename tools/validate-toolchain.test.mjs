import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { validateToolchain } from './validate-toolchain.mjs'

test('accepts the exact reviewed Node and pnpm release toolchain', () => {
  assert.deepEqual(validateToolchain({
    nodeVersion: 'v24.19.0',
    pnpmUserAgent: 'pnpm/11.25.0 npm/? node/v24.19.0 win32 x64',
  }), [])
})

test('rejects a Node runtime that can diverge from the reviewed release environment', () => {
  assert.match(
    validateToolchain({ nodeVersion: 'v22.18.0', pnpmUserAgent: 'pnpm/11.25.0 npm/? node/v22.18.0 linux x64' }).join('\n'),
    /requires Node\.js 24\.19\.0/,
  )
})

test('rejects a missing or mismatched pnpm release toolchain', () => {
  assert.match(
    validateToolchain({ nodeVersion: 'v24.19.0', pnpmUserAgent: 'pnpm/11.19.0 npm/? node/v24.19.0 linux x64' }).join('\n'),
    /requires pnpm 11\.25\.0/,
  )
  assert.match(
    validateToolchain({ nodeVersion: 'v24.19.0', pnpmUserAgent: null }).join('\n'),
    /requires pnpm 11\.25\.0/,
  )
})

test('repository metadata pins the same exact reviewed toolchain as the runtime validator', async () => {
  const packageJson = JSON.parse(await readFile(resolve(process.cwd(), 'package.json'), 'utf8'))
  assert.equal(packageJson.packageManager, 'pnpm@11.25.0')
  assert.deepEqual(packageJson.engines, {
    node: '24.19.0',
    pnpm: '11.25.0',
  })
})
