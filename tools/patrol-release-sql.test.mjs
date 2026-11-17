import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { patrolReleaseTargets, patrolSafetyQueries, renderPatrolRelease, validatePatrolSource } from './patrol-release-sql.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const shiftName = '20261117182334_patrol_route_builder_integrity.sql'
const shiftFile = join(root, 'supabase/migrations', shiftName)
const source = readFileSync(shiftFile, 'utf8').replaceAll('\r\n', '\n')

test('only exact reviewed sources are accepted, including normalized Windows newlines', () => {
  assert(validatePatrolSource(shiftFile, source).target)
  assert(validatePatrolSource(shiftFile, source.replaceAll('\n', '\r\n')).target)
  assert.throws(() => validatePatrolSource(shiftFile, `${source}\n-- drift\n`), /fingerprint/)
  assert.throws(() => validatePatrolSource(shiftFile, `\uFEFF${source}`), /encoding/)
  assert.throws(() => validatePatrolSource(shiftFile, source.replace('begin;', 'begin;\u0000')), /encoding/)
  assert.throws(() => validatePatrolSource('/tmp/arbitrary.sql', source), /Only the two/)
  assert.throws(() => validatePatrolSource('20261117181328_patrol_single_observations_v3.sql', source), /fingerprint/)
})

test('input paths, mode and baseline fingerprint fail closed before reading a renderer', async () => {
  const valid = { file: shiftFile, hubRoot: root, mode: 'rehearsal', ledgerMd5: 'a'.repeat(32) }
  await assert.rejects(renderPatrolRelease({ ...valid, file: 'relative.sql' }), /absolute/)
  await assert.rejects(renderPatrolRelease({ ...valid, mode: 'live' }), /Mode/)
  await assert.rejects(renderPatrolRelease({ ...valid, ledgerMd5: "'; commit;--" }), /MD5/)
  assert.throws(() => patrolSafetyQueries('arbitrary.sql', 'rehearsal', 'a'.repeat(32)), /Only the two/)
  assert.throws(() => patrolSafetyQueries(shiftName, 'live', 'a'.repeat(32)), /Mode/)
  assert.throws(() => patrolSafetyQueries(shiftName, 'activate', "';commit;--"), /MD5/)
})

for (const filename of Object.keys(patrolReleaseTargets)) {
  for (const mode of ['rehearsal', 'activate']) {
    test(`${mode}: bounded safety envelope for ${filename}`, () => {
      const { before, after, target } = patrolSafetyQueries(filename, mode, 'a'.repeat(32))
      // The native harnesses additionally exercise real parsing and activation.
      // These portable tests cover only the separately exported safety envelope.
      const sql = before + after
      assert(sql.startsWith('begin isolation level repeatable read;'))
      assert(sql.endsWith(mode === 'rehearsal' ? 'rollback;\n' : 'commit;\n'))
      assert.equal(sql.match(/^begin isolation level /gm)?.length, 1)
      assert.equal(sql.match(/^(?:commit|rollback);$/gm)?.length, 1)
      assert(sql.includes("set local lock_timeout='3s'"))
      assert(sql.includes("set local statement_timeout='30s'"))
      assert(!/set local (?:statement_timeout|lock_timeout)\s*=\s*'0'/iu.test(sql))
      assert(sql.includes(target.source) && sql.includes(target.ledger))
      assert(sql.includes('limit 128') && sql.includes('select count(*)'))
      assert(sql.includes("'changedFunctionSecurity'"))
      assert(sql.includes("'memberships'") && sql.includes("'defaultAcls'") && sql.includes("'triggers'"))
      assert(sql.includes('Protected record cohorts, counts, security catalog or prior migration history changed'))
      assert(sql.includes('rollback-requested-verify-command-completion') === (mode === 'rehearsal'))
      const proof = after.slice(after.indexOf("select jsonb_build_object('proof'"))
      assert(proof.includes("'ledgerRows'"))
      assert(!proof.includes('auth.users') && !proof.includes('patrol_route_stops'))
    })
  }
}

test('preservation exclusions are limited to the exact intended changes', () => {
  const hub = patrolSafetyQueries('20261117181328_patrol_single_observations_v3.sql', 'rehearsal', 'a'.repeat(32))
  const shift = patrolSafetyQueries(shiftName, 'rehearsal', 'a'.repeat(32))
  assert(hub.after.includes("'b1110000-','b1130000-'"))
  assert(hub.before.includes("coalesce(r.idempotency_key::text,'')"))
  assert(hub.before.includes('b1150000-'))
  assert(hub.after.includes('b1150000-'))
  assert(!hub.before.includes('b1140000-') && !hub.after.includes('b1140000-'))
  assert(shift.after.includes('Patrol receipts were exposed or unexpectedly populated'))
  assert(shift.before.includes("coalesce(c.oid=to_regclass('private.patrol_route_save_receipts'),false)"))
  assert(shift.before.includes('t.tgisinternal and t.tgconstraint in'))
  assert(!hub.after.includes('A private route writer is exposed'))
})
