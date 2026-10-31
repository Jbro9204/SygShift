import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { correctionPermissionMigration, correctionPermissionSignature, timeCorrectionPermissionFixture } from './time-correction-permission-fixture.mjs'

// No environment connection string is read and no existing database is used.
// The sole database is created under this process's disposable local cluster.
const root = resolve(import.meta.dirname, '..')
const bin = process.env.POSTGRES_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin')
const extension = process.platform === 'win32' ? '.exe' : ''
assert(existsSync(join(bin, 'initdb' + extension)), 'Native isolated PostgreSQL binaries are required.')
const directory = mkdtempSync(join(tmpdir(), 'sygshift-time-correction-permission-'))
const data = join(directory, 'data')
mkdirSync(data)
const socket = net.createServer()
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
assert(port > 1024 && port !== 5432)
function run(name, args, options = {}) {
  const result = spawnSync(join(bin, name + extension), args, { encoding: 'utf8', windowsHide: true, timeout: 45_000, ...options })
  assert.equal(result.status, 0, `${name} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}
const database = 'sygshift_time_correction_fixture'
function sql(source) {
  return run('psql', ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-f', '-'], { input: source })
}
let started = false
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  writeFileSync(join(data, 'postgresql.auto.conf'), "unix_socket_directories = ''\n")
  started = true
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -c max_connections=10`, '-w', 'start'], { stdio: 'ignore' })
  run('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', database])
  const fixture = timeCorrectionPermissionFixture(root)
  sql(fixture.schema + fixture.functions + fixture.protection)
  const before = sql(`select md5(pg_get_functiondef('${correctionPermissionSignature}'::regprocedure));`).trim()
  assert.equal(before, 'f02c97cb8c2623ccbdc31b0d29646b22', 'Isolated definition differs from the verified production function.')
  const metadataSql = `select (to_jsonb(p) - 'prosrc')::text from pg_proc p where oid='${correctionPermissionSignature}'::regprocedure;`
  const beforeMetadata = sql(metadataSql).trim()
  const lifecycle = readFileSync(resolve(root, 'supabase/tests/time_correction_effective_permission_regression.sql'), 'utf8')
  const negative = spawnSync(join(bin, 'psql' + extension), ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At', '-f', '-'], { encoding: 'utf8', windowsHide: true, timeout: 45_000, input: `set sygshift.test_fixture = 'time_correction_permission_isolated';\n${lifecycle}` })
  assert.notEqual(negative.status, 0, 'The regression must fail against the actual old authorization guard.')
  assert.match(negative.stderr, /Correction permission\/MFA decision does not match the intended actor\./u)
  const migration = readFileSync(resolve(root, 'supabase/migrations', correctionPermissionMigration), 'utf8')
  sql(migration)
  const after = sql(`select md5(pg_get_functiondef('${correctionPermissionSignature}'::regprocedure));`).trim()
  assert.equal(after, '314077c4569f01d5fd2a76769d9c5d9d')
  assert.equal(sql(metadataSql).trim(), beforeMetadata, 'The correction function security metadata/ACL changed.')
  sql(migration)
  assert.equal(sql(metadataSql).trim(), beforeMetadata, 'Reapplying the repaired migration changed its metadata.')
  const start = Date.now()
  const output = sql(`set sygshift.test_fixture = 'time_correction_permission_isolated';\n${lifecycle}`)
  const rows = output.split(/\r?\n/u).filter((line) => /^(assigned_admin|direct_time|legacy_manual|deny_manage|both_permissions|no_permission|password_only|inactive_account|disabled_account)/u.test(line))
  assert.equal(rows.length, 18, 'All permission cohorts must exercise both correction and void.')
  const remaining = sql('select (select count(*) from public.employees),(select count(*) from public.time_events),(select count(*) from public.time_event_corrections),(select count(*) from public.time_event_maintenance_notes),(select count(*) from private.audit_events);').trim()
  assert.equal(remaining, '0|0|0|0|0', 'Every synthetic employee, punch, correction and audit row must roll back.')
  console.log(JSON.stringify({ passed: true, postgresEngine: run('postgres', ['--version']).trim(), beforeDefinitionMd5: before, afterDefinitionMd5: after, securityMetadataPreserved: true, migrationIdempotent: true, syntheticOnly: true, oldGuardReproduced: true, scenarios: rows.length, allSyntheticWritesRolledBack: true, lifecycleMs: Date.now() - start, artifacts: directory }))
} finally {
  if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
}
