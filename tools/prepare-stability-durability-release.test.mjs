import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import {
  buildReleaseSql,
  migrationFiles,
  regressionFiles,
  unwrapTransaction,
  validateGeneratedTransaction,
} from './prepare-stability-durability-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('transaction unwrapping ignores comments, quoted values, and PL/pgSQL boundaries', () => {
  const source = `-- before
/* outer /* nested */ comment */
begin;
select 'commit;', E'escaped\\\' rollback;', "begin;";
do $body$
begin
  perform 'rollback;';
  /* commit; */
end;
$body$;
commit;
-- after
`
  const body = unwrapTransaction(source, 'commit', 'fixture')
  assert.match(body, /do \$body\$/u)
  assert.match(body, /perform 'rollback;'/u)
  assert.doesNotMatch(body, /^\s*begin\s*;/iu)
  assert.doesNotMatch(body, /commit;\s*$/iu)
})

test('transaction unwrapping rejects extra top-level transaction boundaries', () => {
  assert.throws(
    () => unwrapTransaction('begin; select 1; commit; begin; select 2; commit;', 'commit', 'fixture'),
    /exactly one outer BEGIN/u,
  )
  assert.throws(
    () => unwrapTransaction('begin; select 1; rollback;', 'commit', 'fixture'),
    /expected final COMMIT/u,
  )
})

test('rehearsal contains the exact allowlists inside one rollback-only transaction', () => {
  const sql = buildReleaseSql({ root, rehearsal: true })
  validateGeneratedTransaction(sql, 'rollback')
  assert.equal(migrationFiles.length, 21)
  assert.equal(regressionFiles.length, 14)
  for (const fileName of migrationFiles) assert.match(sql, new RegExp(`-- Migration: ${fileName}`))
  for (const fileName of regressionFiles) assert.match(sql, new RegExp(`-- Regression: ${fileName}`))
  assert.doesNotMatch(sql, /insert into supabase_migrations\.schema_migrations/iu)
  assert.match(sql, /pg_advisory_xact_lock/iu)
  assert.match(sql, /Candidate migration version\(s\) already registered/iu)
})

test('production bundle registers every exact migration and omits regressions', () => {
  const sql = buildReleaseSql({ root, rehearsal: false })
  validateGeneratedTransaction(sql, 'commit')
  for (const fileName of migrationFiles) {
    const version = fileName.slice(0, 14)
    const name = fileName.slice(15, -4)
    assert.match(sql, new RegExp(`'${version}',\\s*'${name}'`, 'u'))
  }
  for (const fileName of regressionFiles) assert.doesNotMatch(sql, new RegExp(`-- Regression: ${fileName}`))
  assert.equal((sql.match(/insert into supabase_migrations\.schema_migrations/giu) ?? []).length, 21)
})

test('generated validation refuses hidden extra top-level boundaries', () => {
  assert.throws(
    () => validateGeneratedTransaction('begin; select 1; commit; rollback;', 'rollback', 'fixture'),
    /one outer BEGIN/u,
  )
})
