import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { normalizeMigrationBytes, prepareManualPasswordRelease } from './prepare-manual-password-release.mjs'

const hub = process.env.SYGSHIFT_RELEASE_SYGILANT_ROOT
const rendererPath = hub && join(hub, 'scripts/render-supabase-migration-activation.mjs')
const sourceIdentities = [
  ['shift', '20261109154616_password_change_requirements_and_verified_completion.sql'],
  ['hub', '20261109155422_password_change_session_projection.sql'],
  ['shift', '20261109182242_admin_chosen_password_next_login.sql'],
  ['hub', '20261109182407_individual_password_change_access_boundary.sql'],
]

test('normalizes CRLF without changing UTF-8 or SQL content', () => {
  const source = "begin;\r\nselect 'λ';\r\ncommit;\r\n"
  assert.equal(normalizeMigrationBytes(Buffer.from(source)), source.replaceAll('\r\n', '\n'))
})

test('rejects invalid, ambiguous, empty and oversized migration bytes', () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('\uFEFFbegin;commit;'),
    Buffer.from('begin;\u0000commit;'), Buffer.from('begin;\rcommit;'), Buffer.from('  '),
    Buffer.from('begin;select 1;commit'), Buffer.alloc(32 * 1024 * 1024 + 1)]) {
    assert.throws(() => normalizeMigrationBytes(bytes))
  }
})

test('rejects an untrusted ledger value or relative roots before reading source', async () => {
  await assert.rejects(prepareManualPasswordRelease({ ledgerMd5: "';commit;--" }), /production migration-ledger MD5/)
  await assert.rejects(prepareManualPasswordRelease({ ledgerMd5: 'a'.repeat(32), shiftRoot: 'relative', hubRoot: tmpdir(), outputDirectory: tmpdir() }), /explicit absolute path/)
})

async function fixture(t) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'manual-password-release-test-'))
  assert(isAbsolute(temporaryRoot) && resolve(temporaryRoot).startsWith(resolve(tmpdir())))
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }))
  const roots = { shift: join(temporaryRoot, 'shift'), hub: join(temporaryRoot, 'hub') }
  for (const root of Object.values(roots)) mkdirSync(join(root, 'supabase/migrations'), { recursive: true })
  mkdirSync(join(roots.hub, 'scripts'), { recursive: true })
  writeFileSync(join(roots.hub, 'scripts/render-supabase-migration-activation.mjs'), readFileSync(rendererPath))
  const source = "begin;\r\nset local lock_timeout='2s';\r\ndo $body$ begin perform 'begin; commit; rollback; λ'; end $body$;\r\ncommit;\r\n"
  for (const [owner, name] of sourceIdentities) writeFileSync(join(roots[owner], 'supabase/migrations', name), source)
  const options = { shiftRoot: roots.shift, hubRoot: roots.hub, outputDirectory: join(temporaryRoot, 'output'), ledgerMd5: 'a'.repeat(32) }
  const renderer = await import(pathToFileURL(join(roots.hub, 'scripts/render-supabase-migration-activation.mjs')).href)
  return { options, roots, source, renderer }
}

test('real activation renderer preserves all four ledgers in one atomic install or rollback',
  { skip: !rendererPath || !existsSync(rendererPath) }, async t => {
    const { options, source, renderer } = await fixture(t)
    const manifest = await prepareManualPasswordRelease(options)
    assert.equal(manifest.sources.length, 4)
    const normalized = normalizeMigrationBytes(Buffer.from(source))
    const expected = renderer.fingerprintMigration(normalized)
    assert(manifest.sources.every(item => item.sourceSha256 === expected.sourceHash && item.ledgerSha256 === expected.ledgerHash && item.statementCount === expected.statementCount))
    for (const [name, finalStatement] of [['install', 'commit'], ['rehearsal', 'rollback']]) {
      const sql = readFileSync(join(options.outputDirectory, `${name}.sql`), 'utf8')
      const statements = renderer.splitAndTrimStatements(sql)
      assert.equal(statements[0], 'begin')
      assert.equal(statements.at(-1), finalStatement)
      assert.equal(statements.filter(statement => /^(?:begin|commit|rollback)$/iu.test(statement)).length, 2)
      assert.equal(statements.filter(statement => /^insert into supabase_migrations\.schema_migrations/iu.test(statement)).length, 4)
      assert.equal(createHash('sha256').update(sql).digest('hex'), manifest[`${name}Sha256`])
      assert(sql.includes("md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]'))"))
      assert(sql.includes('private.assert_individual_password_boundary()'))
      assert(!sql.includes('scheduled_recovery_delivery_options'))
    }
    assert.deepEqual(JSON.parse(readFileSync(join(options.outputDirectory, 'manifest.json'), 'utf8')), manifest)
  })

test('refuses a nested source commit before any release artifacts are written',
  { skip: !rendererPath || !existsSync(rendererPath) }, async t => {
    const { options, roots } = await fixture(t)
    writeFileSync(join(roots.shift, 'supabase/migrations', sourceIdentities[0][1]), 'begin; select 1; commit; select 2; commit;')
    await assert.rejects(prepareManualPasswordRelease(options), /nested transaction control/)
    assert.equal(existsSync(options.outputDirectory), false)
  })

test('refuses invalid source bytes before release artifacts are written',
  { skip: !rendererPath || !existsSync(rendererPath) }, async t => {
    const { options, roots } = await fixture(t)
    writeFileSync(join(roots.hub, 'supabase/migrations', sourceIdentities[3][1]), Buffer.from([0xc3, 0x28]))
    await assert.rejects(prepareManualPasswordRelease(options), /encoded data was not valid/)
    assert.equal(existsSync(options.outputDirectory), false)
  })
