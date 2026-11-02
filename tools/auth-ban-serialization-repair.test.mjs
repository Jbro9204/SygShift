import assert from 'node:assert/strict'
import test from 'node:test'
import { authBanRepairBusinessRelations, authBanRepairManifestSha256, renderAuthBanSerializationRepairSql, validateAuthBanRepairManifest } from './auth-ban-serialization-repair.mjs'
import { validateGeneratedTransaction } from './sql-transaction-boundary.mjs'

const capturedAt = '2026-11-02T12:00:00.000Z'
const fixture = () => ({ formatVersion: 1, targetProject: 'eqkdfrbwtioiqtjsyglg', requestId: '10000000-0000-4000-8000-000000000001', capturedAt,
  replacementBannedUntil: new Date(Date.parse(capturedAt) + 876_000 * 3_600_000).toISOString(), reason: 'Normalize a provider-incompatible ban without restoring access.', expectedCount: 1,
  affectedRows: [{ authUserId: '20000000-0000-4000-8000-000000000001', fullRowSha256: 'a'.repeat(64), protectedRowSha256: 'b'.repeat(64), accountRowSha256: 'c'.repeat(64), employeeRowSha256: 'd'.repeat(64), centralAuthorityRowSha256: 'e'.repeat(64) }],
  businessFingerprints: Object.fromEntries(authBanRepairBusinessRelations.map((relation) => [relation, { rows: 1, sha256: 'f'.repeat(64) }])) })

test('repair rendering defaults to one complete rollback-only transaction and never executes SQL', () => {
  const sql = renderAuthBanSerializationRepairSql(fixture())
  validateGeneratedTransaction(sql, 'rollback')
  assert.match(sql, /set transaction isolation level repeatable read/)
  assert.match(sql, /lock_timeout='2s'/); assert.match(sql, /statement_timeout='5s'/)
  assert.match(sql, /for update nowait/); assert.match(sql, /disabled_at is not null for share nowait/)
  assert.doesNotMatch(sql, /create (?:or replace )?(?:table|function)|alter table|supabase_migrations[^;]+(?:insert|update)/iu)
})

test('activation is an explicit separate single outer commit', () => {
  validateGeneratedTransaction(renderAuthBanSerializationRepairSql(fixture(), { mode: 'activation' }), 'commit')
  assert.throws(() => renderAuthBanSerializationRepairSql(fixture(), { mode: 'live' }))
})

test('exact cohort and all protected row fingerprints are required', () => {
  for (const patch of [{ expectedCount: 2 }, { affectedRows: [] }, { targetProject: 'other' }, { requestId: 'invalid' }]) assert.throws(() => validateAuthBanRepairManifest({ ...fixture(), ...patch }))
  for (const key of ['fullRowSha256', 'protectedRowSha256', 'accountRowSha256', 'employeeRowSha256', 'centralAuthorityRowSha256']) {
    const input = fixture(); input.affectedRows[0][key] = 'not-a-hash'; assert.throws(() => validateAuthBanRepairManifest(input))
  }
})

test('finite expiration is captured once at exactly canonical 876000 hours', () => {
  for (const value of ['infinity', '-infinity', '2030-01-01T00:00:00.000Z']) assert.throws(() => validateAuthBanRepairManifest({ ...fixture(), replacementBannedUntil: value }))
  assert.match(renderAuthBanSerializationRepairSql(fixture()), /replacement<clock_timestamp\(\)\+interval '875999 hours'/)
})

test('idempotent receipt is validated before the original infinity/full-row precondition', () => {
  const sql = renderAuthBanSerializationRepairSql(fixture())
  assert.ok(sql.indexOf('if receipt_count=1') < sql.indexOf('select count(*) into affected_count'))
  assert.match(sql, /receipt\.new_record is distinct from expected_after/)
  assert.match(sql, /observed_auth\.banned_until is distinct from replacement/)
  assert.match(sql, /already applied; no change/)
  assert.equal((sql.match(/update auth\.users set banned_until=replacement/gu) ?? []).length, 1)
})

test('preservation fences exact transaction-local writes without scanning business history or the whole audit ledger', () => {
  const sql = renderAuthBanSerializationRepairSql(fixture())
  assert.match(sql, /from pg_stat_xact_user_tables where n_tup_ins<>0 or n_tup_upd<>0 or n_tup_del<>0/)
  assert.match(sql, /'inserted',0,'updated',1,'deleted',0/)
  assert.match(sql, /'inserted',1,'updated',0,'deleted',0/)
  assert.match(sql, /Transaction write-footprint postflight/)
  for (const relation of authBanRepairBusinessRelations) assert.doesNotMatch(sql, new RegExp(`from ${relation.replaceAll('.', '\\.')}`, 'u'))
  assert.doesNotMatch(sql, /from supabase_migrations\.schema_migrations/)
  assert.doesNotMatch(sql, /select count\(\*\) (?:into \w+ )?from private\.audit_events;/)
  assert.doesNotMatch(sql, new RegExp('f'.repeat(64), 'u'))
  assert.match(sql, /is distinct from others_before/)
  assert.match(sql, /returning \* into strict receipt/)
})

test('audit stores only minimal ban repair evidence and no credential record', () => {
  const sql = renderAuthBanSerializationRepairSql(fixture())
  assert.match(sql, /AUTH_BAN_SERIALIZATION_REPAIR/)
  assert.match(sql, /"banned_until":"infinity"/)
  assert.match(sql, /manifestSha256/)
  assert.doesNotMatch(sql, /encrypted_password|refresh_token|user_metadata/)
  assert.match(sql, /to_jsonb\(observed_auth\)-'banned_until'/)
})

test('manifest hash is canonical and reason is SQL-escaped without changing data', () => {
  const input = fixture(); input.reason = "Retain the account's independent disabled state."
  const sql = renderAuthBanSerializationRepairSql(input)
  assert.match(sql, /account''s/)
  assert.equal(authBanRepairManifestSha256(input), authBanRepairManifestSha256(JSON.parse(JSON.stringify(input))))
  assert.equal(validateAuthBanRepairManifest(input).reason, input.reason)
})

test('a reason cannot terminate the generated SQL block', () => {
  const input = fixture()
  input.reason = 'Do not accept $auth_ban_serialization_repair$ inside the operator reason.'
  assert.throws(() => renderAuthBanSerializationRepairSql(input), /block delimiter/u)
})
