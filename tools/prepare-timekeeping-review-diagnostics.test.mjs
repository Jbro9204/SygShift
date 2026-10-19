import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimekeepingDiagnostics } from './prepare-timekeeping-review-diagnostics.mjs'

test('rejects SQL injection, invalid dates, reversed ranges, and oversized ranges before writing files', () => {
  for (const [from, through] of [
    ["2026-10-04'; select 1; --", '2026-10-17'],
    ['2026-02-30', '2026-03-01'],
    ['2026-10-18', '2026-10-17'],
    ['2026-09-01', '2026-10-17'],
    [undefined, undefined],
  ]) assert.throws(() => buildTimekeepingDiagnostics(from, through), /observed, valid/)
})

test('requires every database probe to stay read-only, bounded, independent, and rollback-terminated', () => {
  const files = buildTimekeepingDiagnostics('2026-10-04', '2026-10-17')
  const probes = [...files].filter(([name]) => name.endsWith('.sql'))
  assert.equal(probes.length, 12)
  for (const [name, sql] of probes) {
    assert.equal((sql.match(/^begin read only;/gm) ?? []).length, 1, name)
    assert.equal((sql.match(/^rollback;/gm) ?? []).length, 1, name)
    assert.match(sql, /set local statement_timeout = '6s';/, name)
    assert.match(sql, /set local lock_timeout = '250ms';/, name)
    assert.match(sql, /set local idle_in_transaction_session_timeout = '10s';/, name)
    assert.match(sql, /rollback;\s*$/, name)
    assert.doesNotMatch(sql, /^\s*(?:commit|insert|update|delete|truncate|create|alter|drop|grant|revoke|copy)\b/gim, name)
    assert.doesNotMatch(sql, /select\s+(?:event|employee|account)\.\*/i, name)
  }
})

test('outputs aggregate timings and fingerprints without employee or event payloads', () => {
  const files = buildTimekeepingDiagnostics('2026-10-04', '2026-10-17')
  assert.match(files.get('110-review-allocation.sql'), /md5\(measured\.payload::text\) as payload_md5/)
  assert.match(files.get('110-review-allocation.sql'), /jsonb_array_length/)
  assert.doesNotMatch(files.get('110-review-allocation.sql'), /select\s+(?:\*|measured\.payload\s*,)/i)
  assert.match(files.get('README.txt'), /diagnostic impersonation, not proof of a real employee session/)
  assert.match(files.get('README.txt'), /EXPLAIN SELECT function\(\.\.\.\) shows only the outer/)
})
