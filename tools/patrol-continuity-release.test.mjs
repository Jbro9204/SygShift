import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { continuityPreservationSql, validateContinuityReleaseTarget } from './patrol-continuity-release.mjs'

const source = 'begin;\nselect 1;\ncommit;\n'
const target = { file: '20261118133316_patrol_schedule_continuity.sql', version: '20261118133316', name: 'patrol_schedule_continuity', owner: 'SygShift',
  sourceHash: createHash('sha256').update(source).digest('hex'), ledgerHash: 'a'.repeat(64), changed: [], added: [], relations: [], triggers: [] }

test('accepts only exact known identity and normalized reviewed source', () => {
  assert.equal(validateContinuityReleaseTarget(target.file, source, target), source)
  assert.equal(validateContinuityReleaseTarget(target.file, source.replaceAll('\n', '\r\n'), target), source)
  assert.throws(() => validateContinuityReleaseTarget('unreviewed.sql', source, target))
  assert.throws(() => validateContinuityReleaseTarget(target.file, source+'select 2;', target))
  assert.throws(() => validateContinuityReleaseTarget(target.file, source, { ...target, version: '20261118133317' }))
})

test('requires valid ledger evidence before preparing any SQL', () => {
  for (const invalid of ['', 'not-a-checksum', "'; commit; --"]) assert.throws(() => continuityPreservationSql(target, invalid))
})

test('checks business rows and independent security catalogs without returning private row data', () => {
  const sql = continuityPreservationSql(target, '1'.repeat(32))
  for (const name of ['auth.users','auth.sessions','public.shifts','public.time_events','public.patrol_hits','public.sygilant_report_evidence','private.payroll_export_rows']) assert(sql.includes(name), name)
  for (const name of ['pg_policy','pg_auth_members','pg_default_acl','changedFunctionSecurity','priorLedger']) assert(sql.includes(name), name)
  assert(sql.includes('set transaction isolation level repeatable read'))
  assert(sql.indexOf('lock table supabase_migrations.schema_migrations') < sql.indexOf('do $predecessor$'))
  assert(sql.includes('limit 128'))
  assert(sql.includes("$query$select md5(coalesce(string_agg(hash,'' order by n),''))"))
  assert.doesNotMatch(sql, /(?:delete from|update public|insert into public|commit;)/iu)
})

test('only declared new relations and functions are excluded from the existing catalog comparison', () => {
  const sql = continuityPreservationSql({ ...target, relations: ['private.reviewed_table'], changed: ['public.reviewed_reader()'], added: [{ signature: 'private.reviewed_helper()', roles: [] }], triggers: ['public.schedules.reviewed_trigger'] }, '2'.repeat(32))
  assert(sql.includes("array['private.reviewed_table']::text[]"))
  assert(sql.includes("array['public.reviewed_reader()','private.reviewed_helper()']::text[]"))
  assert(sql.includes("array['public.schedules.reviewed_trigger']::text[]"))
})
