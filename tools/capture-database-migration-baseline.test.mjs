import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { captureDatabaseMigrationBaseline, parseCaptureArguments } from './capture-database-migration-baseline.mjs'

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'sygshift-baseline-capture-'))
  t.after(() => rmSync(folder, { force: true, recursive: true }))
  const sygshiftRoot = join(folder, 'SygShift')
  const sygilantRoot = join(folder, 'Sygilant')
  for (const root of [sygshiftRoot, sygilantRoot]) mkdirSync(join(root, 'supabase', 'migrations'), { recursive: true })
  writeFileSync(join(sygshiftRoot, 'supabase', 'migrations', '11_one.sql'), 'select 1;\n')
  writeFileSync(join(sygilantRoot, 'supabase', 'migrations', '22_two.sql'), 'select 2;\n')
  const decisions = join(sygshiftRoot, 'docs', 'work-orders', '2026-10-19-overnight', 'migration-source-ownership-decisions.json')
  mkdirSync(join(decisions, '..'), { recursive: true })
  writeFileSync(decisions, '{}')
  const output = join(sygshiftRoot, 'docs', 'release', 'pre-activation-v2.json')
  const ledger = {
    rows: [
      { name: 'one', statements: ["select 'PRIVATE_LEDGER_BODY'"], version: '11' },
      { name: 'two', statements: ['select 2'], version: '22' },
    ],
  }
  const calls = []
  const run = async (args, options) => {
    calls.push({ args, options })
    return { stderr: '', stdout: JSON.stringify(ledger) }
  }
  return { calls, ledger, output, run, sygilantRoot, sygshiftRoot }
}

test('captures the fixed production ledger into a format-v2 cross-repository checksum manifest', async (t) => {
  const f = fixture(t)
  const result = await captureDatabaseMigrationBaseline({
    environment: { SYGSHIFT_RELEASE_CANARY_PASSWORD: 'CANARY_SECRET' },
    output: f.output,
    sygilantRoot: f.sygilantRoot,
    sygshiftRoot: f.sygshiftRoot,
  }, {
    now: () => new Date('2026-10-24T12:00:00.000Z'),
    run: f.run,
  })

  assert.equal(result.formatVersion, 2)
  assert.equal(result.appliedMigrations, 2)
  assert.equal(result.sygshiftSources, 1)
  assert.equal(result.sygilantSources, 1)
  assert.equal(result.bulkMigrationPushAuthorized, false)
  assert.equal(result.claimsHistoryEquivalence, false)
  assert.deepEqual(f.calls[0].args, [
    'dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', 'eqkdfrbwtioiqtjsyglg',
    'select version,name,statements from supabase_migrations.schema_migrations order by version', '-o', 'json',
  ])
  assert.equal(f.calls[0].options.timeoutMs, 45_000)
  assert.equal(f.calls[0].options.env.SYGSHIFT_RELEASE_CANARY_PASSWORD, undefined)

  const manifestText = readFileSync(f.output, 'utf8')
  const manifest = JSON.parse(manifestText)
  assert.equal(manifest.capturedAt, '2026-10-24T12:00:00.000Z')
  assert.equal(manifest.entries[0].owner, 'SygShift')
  assert.equal(manifest.entries[1].owner, 'Sygilant')
  assert.doesNotMatch(manifestText, /PRIVATE_LEDGER_BODY|CANARY_SECRET/u)
})

test('refuses overwrite, cross-tree output, and a shared owning tree before querying production', async (t) => {
  const f = fixture(t)
  mkdirSync(join(f.output, '..'), { recursive: true })
  writeFileSync(f.output, '{}')
  await assert.rejects(captureDatabaseMigrationBaseline({
    output: f.output,
    sygilantRoot: f.sygilantRoot,
    sygshiftRoot: f.sygshiftRoot,
  }, { run: f.run }), /already exists/u)
  await assert.rejects(captureDatabaseMigrationBaseline({
    output: join(f.sygilantRoot, 'outside.json'),
    sygilantRoot: f.sygilantRoot,
    sygshiftRoot: f.sygshiftRoot,
  }, { run: f.run }), /inside the SygShift repository/u)
  await assert.rejects(captureDatabaseMigrationBaseline({
    output: join(f.sygshiftRoot, 'new.json'),
    sygilantRoot: f.sygshiftRoot,
    sygshiftRoot: f.sygshiftRoot,
  }, { run: f.run }), /separate owning source tree/u)
  assert.equal(f.calls.length, 0)
})

test('withholds CLI and invalid-ledger content and does not create an evidence file', async (t) => {
  const f = fixture(t)
  const failure = async () => { throw new Error('PRIVATE_LEDGER_BODY') }
  await assert.rejects(captureDatabaseMigrationBaseline({
    output: f.output,
    sygilantRoot: f.sygilantRoot,
    sygshiftRoot: f.sygshiftRoot,
  }, { run: failure }), (error) => {
    assert.match(error.message, /could not read/u)
    assert.doesNotMatch(error.message, /PRIVATE_LEDGER_BODY/u)
    return true
  })
  const invalid = async () => ({ stdout: 'PRIVATE_LEDGER_BODY' })
  await assert.rejects(captureDatabaseMigrationBaseline({
    output: f.output,
    sygilantRoot: f.sygilantRoot,
    sygshiftRoot: f.sygshiftRoot,
  }, { run: invalid }), /invalid production ledger/u)
  assert.throws(() => readFileSync(f.output), /ENOENT/u)
})

test('argument parser requires explicit roots/output and rejects bypass-shaped options', () => {
  assert.deepEqual(parseCaptureArguments([
    '--sygshift-root', 'C:\\SygShift', '--sygilant-root', 'C:\\Sygilant', '--output', 'C:\\SygShift\\baseline.json',
  ]), {
    output: 'C:\\SygShift\\baseline.json',
    ownershipDecisions: undefined,
    sygilantRoot: 'C:\\Sygilant',
    sygshiftRoot: 'C:\\SygShift',
  })
  assert.throws(() => parseCaptureArguments(['--sygshift-root', 'x']), /Missing --sygilant-root/u)
  assert.throws(() => parseCaptureArguments([
    '--sygshift-root', 'x', '--sygilant-root', 'y', '--output', 'z', '--skip-verification', 'yes',
  ]), /Unknown option/u)
})
