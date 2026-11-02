import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildOwnershipManifest, readSourceTree } from './database-migration-ownership.mjs'
import { authBanCompatibilitySql, requireDatabaseReleaseBaseline } from './database-release-gate.mjs'
import { executeProductionRelease, parseProductionReleaseArguments } from './release-production.mjs'
import { retrySafetyCatalogSql } from './postgres-retry-safety.mjs'

function fixture(t, ledger = [{ version: '11', name: 'one', statements: ["select 'PRIVATE_LEDGER_BODY'"] }]) {
  const folder = mkdtempSync(join(tmpdir(), 'sygshift-database-gate-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const cwd = join(folder, 'SygShift')
  const sygilant = join(folder, 'Sygilant')
  for (const root of [cwd, sygilant]) mkdirSync(join(root, 'supabase/migrations'), { recursive: true })
  for (const root of [cwd, sygilant]) {
    mkdirSync(join(root, 'docs/reliability'), { recursive: true })
    writeFileSync(join(root, 'docs/reliability/postgres-retry-safety.json'), JSON.stringify({ formatVersion: 1, immutableHistoricalSources: [], runtimeExceptions: [], functions: [] }))
  }
  const docs = join(cwd, 'docs/work-orders/2026-10-19-overnight')
  mkdirSync(docs, { recursive: true })
  writeFileSync(join(docs, 'migration-source-ownership-decisions.json'), '{}')
  const sourceFile = join(cwd, 'supabase/migrations/11_one.sql')
  writeFileSync(sourceFile, 'select 1;\n')
  const sources = [...readSourceTree(cwd, 'SygShift'), ...readSourceTree(sygilant, 'Sygilant')]
  const baselinePath = join(docs, 'reviewed-v2.json')
  writeFileSync(baselinePath, JSON.stringify(buildOwnershipManifest({ ledgerRows: ledger, sources, capturedAt: 'reviewed', ledgerSha256: 'captured' })))
  const calls = []
  const options = {
    cwd, supabaseOrigin: 'https://eqkdfrbwtioiqtjsyglg.supabase.co',
    environment: { SYGSHIFT_RELEASE_MIGRATION_BASELINE: baselinePath, SYGSHIFT_RELEASE_SYGILANT_ROOT: sygilant, SYGSHIFT_RELEASE_CANARY_PASSWORD: 'CANARY_SECRET' },
  }
  const run = async (args, runOptions) => {
    calls.push({ args, runOptions })
    return { stdout: args[0] === 'dlx' ? JSON.stringify({ rows: args.includes(retrySafetyCatalogSql) ? [] : args.includes(authBanCompatibilitySql) ? [{ non_finite_ban_count: '0' }] : ledger }) : 'docs/reviewed-v2.json\n', stderr: '' }
  }
  return { options, calls, run, ledger, sourceFile, baselinePath }
}

test('gate captures the fresh explicit production ledger and exposes only nonsecret acceptance metadata', async (t) => {
  const f = fixture(t)
  const result = await requireDatabaseReleaseBaseline(f.options, { run: f.run })
  assert.equal(result.accepted, true)
  assert.equal(result.freshProductionLedger, true)
  assert.equal(result.claimsHistoryEquivalence, false)
  assert.equal(result.bulkMigrationPushAuthorized, false)
  assert.equal(f.calls.length, 5)
  assert.deepEqual(f.calls[0].args.slice(0, 4), ['exec', 'git', 'ls-files', '--error-unmatch'])
  assert.deepEqual(f.calls[1].args.slice(0, 6), ['exec', 'git', 'diff', '--quiet', 'HEAD', '--'])
  assert.deepEqual(f.calls[2].args, ['dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', 'eqkdfrbwtioiqtjsyglg', 'select version,name,statements from supabase_migrations.schema_migrations order by version', '-o', 'json'])
  assert.equal(f.calls[2].runOptions.timeoutMs, 45_000)
  assert.equal(f.calls[2].runOptions.env.SYGSHIFT_RELEASE_CANARY_PASSWORD, undefined)
  assert.equal(result.retrySafetyVerified, true)
  assert.equal(result.authBanTimestampsVerified, true)
  assert.deepEqual(f.calls[4].args, ['dlx', 'supabase@2.121.0', 'db', 'query', '--linked', '--project-ref', 'eqkdfrbwtioiqtjsyglg', authBanCompatibilitySql, '-o', 'json'])
  assert.equal(f.calls[4].runOptions.timeoutMs, 10_000)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LEDGER_BODY|CANARY_SECRET/u)
})

test('Auth compatibility query is a count-only read that accepts finite and NULL ban states', async (t) => {
  const f = fixture(t)
  assert.equal(authBanCompatibilitySql, 'select pg_catalog.count(*)::text as non_finite_ban_count from auth.users where banned_until is not null and not pg_catalog.isfinite(banned_until)')
  assert.doesNotMatch(authBanCompatibilitySql, /\b(?:insert|update|delete|alter|create|set|email|encrypted_password|raw_user_meta_data)\b/iu)
  for (const banState of ['2126-11-02T12:00:00.000Z', '2026-01-01T12:00:00.000Z', null]) {
    const run = (args, options) => args.includes(authBanCompatibilitySql)
      ? Promise.resolve({ stdout: JSON.stringify({ rows: [{ non_finite_ban_count: banState === null || Number.isFinite(Date.parse(banState)) ? '0' : '1' }] }) })
      : f.run(args, options)
    const result = await requireDatabaseReleaseBaseline(f.options, { run })
    assert.equal(result.authBanTimestampsVerified, true)
  }
})

test('positive and negative infinite ban timestamps both refuse release without identity output', async (t) => {
  const f = fixture(t)
  for (const incompatibleState of ['infinity', '-infinity']) {
    const run = (args, options) => args.includes(authBanCompatibilitySql)
      ? Promise.resolve({ stdout: JSON.stringify({ rows: [{ non_finite_ban_count: incompatibleState.endsWith('infinity') ? '1' : '0' }] }) })
      : f.run(args, options)
    await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run }), (error) => {
      assert.match(error.message, /Auth compatibility gate refused.*non-finite account ban timestamps/u)
      assert.doesNotMatch(error.message, /PRIVATE_LEDGER_BODY|CANARY_SECRET/u)
      return true
    })
  }
})

test('Auth compatibility lookup failure and timeout fail closed without exposing CLI output', async (t) => {
  const f = fixture(t)
  for (const failure of ['query failure', 'timeout']) {
    const run = async (args, options) => {
      if (!args.includes(authBanCompatibilitySql)) return f.run(args, options)
      assert.equal(options.timeoutMs, 10_000)
      throw new Error(`${failure}: PRIVATE_LEDGER_BODY CANARY_SECRET`)
    }
    await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run }), (error) => {
      assert.match(error.message, /Auth compatibility gate could not verify/u)
      assert.doesNotMatch(error.message, /PRIVATE_LEDGER_BODY|CANARY_SECRET/u)
      return true
    })
  }
})

test('Auth compatibility lookup rejects malformed, missing, or untrusted count responses', async (t) => {
  const f = fixture(t)
  const invalidResults = [
    'PRIVATE_LEDGER_BODY CANARY_SECRET',
    '{}',
    JSON.stringify({ rows: [] }),
    JSON.stringify({ rows: [null] }),
    JSON.stringify({ rows: [{ non_finite_ban_count: '0' }, { non_finite_ban_count: '0' }] }),
    JSON.stringify({ rows: [{ non_finite_ban_count: 0 }] }),
    JSON.stringify({ rows: [{ non_finite_ban_count: '-1' }] }),
    JSON.stringify({ rows: [{ non_finite_ban_count: 'NaN' }] }),
    JSON.stringify({ rows: [{ non_finite_ban_count: '0', identity: 'PRIVATE_LEDGER_BODY' }] }),
  ]
  for (const stdout of invalidResults) {
    const run = (args, options) => args.includes(authBanCompatibilitySql) ? Promise.resolve({ stdout }) : f.run(args, options)
    await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run }), (error) => {
      assert.match(error.message, /Auth compatibility gate could not verify/u)
      assert.doesNotMatch(error.message, /PRIVATE_LEDGER_BODY|CANARY_SECRET/u)
      return true
    })
  }
})

test('unsafe effective runtime definitions block release even with an unchanged migration ledger', async (t) => {
  const f = fixture(t)
  const run = async (args, options) => args.includes(retrySafetyCatalogSql)
    ? { stdout: JSON.stringify({ rows: [{ identity: 'public.unsafe()', body: "begin raise sqlstate '40001'; end;", definition_md5: 'bad' }] }) }
    : f.run(args, options)
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run }), /retry-safety gate refused/u)
})

test('missing configuration and wrong target fail before any CLI or release command', async (t) => {
  const f = fixture(t)
  await assert.rejects(requireDatabaseReleaseBaseline({ ...f.options, environment: {} }, { run: f.run }), /explicit absolute/u)
  await assert.rejects(requireDatabaseReleaseBaseline({ ...f.options, supabaseOrigin: 'https://other.supabase.co' }, { run: f.run }), /reviewed production/u)
  assert.equal(f.calls.length, 0)
})

test('legacy and untracked baselines fail closed', async (t) => {
  const f = fixture(t)
  const baseline = JSON.parse(readFileSync(f.baselinePath, 'utf8'))
  writeFileSync(f.baselinePath, JSON.stringify({ ...baseline, formatVersion: 1 }))
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run: f.run }), /reviewed v2 baseline/u)
  assert.equal(f.calls.length, 0)
  writeFileSync(f.baselinePath, JSON.stringify(baseline))
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run: async () => { throw new Error('Untracked') } }), /must be tracked/u)
})

test('forged modified or staged baseline is rejected before querying production or releasing', async (t) => {
  const f = fixture(t)
  for (const change of ['unstaged', 'staged']) {
    const calls = []
    const run = async (args) => {
      calls.push(args)
      if (args.includes('diff')) throw new Error(`Forged ${change} baseline differs from HEAD`)
      if (args[0] === 'dlx') assert.fail('A modified baseline must never query production')
      return { stdout: 'tracked baseline' }
    }
    await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run }), /differs from committed HEAD/u)
    assert.equal(calls.length, 2)
  }
})

test('fresh same-version SQL changes and changed owning sources refuse release', async (t) => {
  const f = fixture(t)
  const changed = async (args, options) => args[0] === 'dlx'
    ? { stdout: JSON.stringify({ rows: [{ ...f.ledger[0], statements: ['select 2'] }] }) }
    : f.run(args, options)
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run: changed }), /statement-array checksum changed/u)
  writeFileSync(f.sourceFile, 'select 3;\n')
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run: f.run }), /Owning-source checksum changed/u)
})

test('CLI failure and invalid output withhold private result text', async (t) => {
  const f = fixture(t)
  const failure = async (args, options) => {
    if (args[0] === 'dlx') throw new Error('PRIVATE_LEDGER_BODY CANARY_SECRET')
    return f.run(args, options)
  }
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run: failure }), (error) => {
    assert.match(error.message, /could not capture the fresh production ledger/u)
    assert.doesNotMatch(error.message, /PRIVATE_LEDGER_BODY|CANARY_SECRET/u)
    return true
  })
  const invalid = async (args, options) => args[0] === 'dlx' ? { stdout: 'PRIVATE_LEDGER_BODY' } : f.run(args, options)
  await assert.rejects(requireDatabaseReleaseBaseline(f.options, { run: invalid }), /invalid production ledger/u)
})

test('strict reconciliation still refuses an unchanged reviewed NULL statement array', async (t) => {
  const f = fixture(t, [{ version: '11', name: 'one', statements: null }])
  await assert.rejects(requireDatabaseReleaseBaseline({ ...f.options, requireReconciled: true }, { run: f.run }), /Empty applied statement array/u)
})

test('normal deploy entry runs migration gate before release, including dry-run, and never releases after refusal', async () => {
  const calls = []
  const options = { dryRun: true }
  const result = await executeProductionRelease(options, {
    migrationGate: async (received) => { assert.equal(received, options); calls.push('gate'); return { accepted: true, freshProductionLedger: true, appliedMigrations: 371 } },
    release: async (received) => { assert.equal(received, options); calls.push('release'); return 'dry_run_result' },
  })
  assert.equal(result, 'dry_run_result')
  assert.deepEqual(calls, ['gate', 'release'])
  for (const migrationGate of [async () => { throw new Error('Drift refused') }, async () => ({ accepted: false })]) {
    await assert.rejects(executeProductionRelease(options, {
      migrationGate, release: async () => { assert.fail('Release must not run after a failed migration gate') },
    }), /Drift refused|mandatory database release gate/u)
  }
  assert.throws(() => parseProductionReleaseArguments(['--tag=reviewed', '--skip-migration-gate']), /Unsupported release argument/u)
})
