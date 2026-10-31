import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { buildReliabilityActivation } from './prepare-reliability-activation.mjs'

const root = resolve(import.meta.dirname, '..')
const sygilant = process.env.SYGSHIFT_RELEASE_SYGILANT_ROOT
test('owner manifest and forward migration enumerate the same exact reviewed changes', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'docs/reliability/postgres-retry-safety.json'), 'utf8'))
  const migration = readFileSync(resolve(root, manifest.migration), 'utf8')
  assert.equal(manifest.functions.length, manifest.expectedFunctionCount)
  assert.equal(manifest.functions.reduce((sum, fn) => sum + fn.sites.length, 0), manifest.expectedRaiseCount)
  assert.equal(manifest.expectedFunctionCount, 7)
  assert.equal(manifest.expectedRaiseCount, 19)
  for (const fn of manifest.functions) {
    for (const value of [fn.identity, fn.beforeMd5, fn.afterMd5, fn.metadataMd5]) assert.ok(migration.includes(value))
    assert.ok(fn.sites.every((site) => site.original === 'serialization_failure' && site.replacement === "sqlstate 'PT409'"))
  }
  assert.match(migration, /if metadata_digest is distinct from target.metadata_md5/u)
  assert.match(migration, /if md5\(current_definition\) is distinct from target.before_md5/u)
})

test('cross-repository activation is a single atomic transaction with rollback by default', { skip: !sygilant || !existsSync(sygilant) }, async () => {
  const renderer = await import(new URL(`file:///${sygilant.replaceAll('\\', '/')}/scripts/render-supabase-migration-activation.mjs`))
  const args = { cwd: root, sygilantRoot: sygilant, sampleReportId: '00000000-0000-4000-8000-000000000001' }
  const rehearsal = await buildReliabilityActivation(args)
  const statements = renderer.splitAndTrimStatements(rehearsal.sql)
  assert.equal(statements.length, 7)
  assert.equal(statements.at(-1), 'rollback')
  assert.match(statements[0], /begin isolation level repeatable read/u)
  assert.match(rehearsal.sql, /actual_count <> 436/u)
  assert.match(rehearsal.sql, /<> 439/u)
  assert.match(rehearsal.sql, /protected_before is distinct from protected_after/u)
  const activation = await buildReliabilityActivation({ ...args, mode: 'activation' })
  assert.equal(renderer.splitAndTrimStatements(activation.sql).at(-1), 'commit')
  assert.equal(activation.migrations, 3)
})

test('activation requires explicit roots, valid sample identity and defined mode', async () => {
  await assert.rejects(buildReliabilityActivation({ cwd: root, sygilantRoot: 'relative', mode: 'activation' }), /Explicit owning roots/u)
  await assert.rejects(buildReliabilityActivation({ cwd: root, sygilantRoot: root, sampleReportId: "'; delete from employees; --" }), /UUID/u)
})
