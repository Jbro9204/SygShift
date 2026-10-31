import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

// This integration test never connects to the configured application database.
// It creates an isolated, loopback-only PostgreSQL cluster with synthetic rows.
const postgresBin = process.env.RETRY_TEST_POSTGRES_BIN
const postgrestBin = process.env.RETRY_TEST_POSTGREST_BIN
assert(postgresBin && postgrestBin, 'Set RETRY_TEST_POSTGRES_BIN and RETRY_TEST_POSTGREST_BIN to pinned local binaries')
const directory = mkdtempSync(join(tmpdir(), 'sygshift-retry-contract-'))
const data = join(directory, 'data')
const databasePort = Number(process.env.RETRY_TEST_PG_PORT || 55439)
const httpPort = Number(process.env.RETRY_TEST_HTTP_PORT || 55440)
assert(databasePort !== 5432 && databasePort > 1024 && httpPort > 1024 && httpPort !== databasePort)
const extension = process.platform === 'win32' ? '.exe' : ''
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options })
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}
const sql = (source) => run(join(postgresBin, `psql${extension}`), [
  '-X', '-h', '127.0.0.1', '-p', String(databasePort), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At', '-c', source,
])
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
const base = `http://127.0.0.1:${httpPort}`
let api
let databaseStarted = false
async function stopApi() {
  const child = api
  api = null
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  let timer
  try {
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
    child.kill()
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated PostgREST did not stop within five seconds')), 5_000)
    })])
  } finally { clearTimeout(timer) }
}
try {
  mkdirSync(data)
  run(join(postgresBin, `initdb${extension}`), ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  // Distribution packages can default to a protected global Unix-socket
  // directory. This private fixture uses TCP loopback only on every platform.
  writeFileSync(join(data, 'postgresql.auto.conf'), "unix_socket_directories = ''\n")
  try {
    run(join(postgresBin, `pg_ctl${extension}`), ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${databasePort} -h 127.0.0.1 -c max_connections=20`, '-w', 'start'])
  } catch (error) {
    let log = ''
    try { log = readFileSync(join(directory, 'postgres.log'), 'utf8') } catch { /* report original startup failure */ }
    throw new Error(`${error.message}\nIsolated PostgreSQL startup log:\n${log.slice(-8_000)}`, { cause: error })
  }
  databaseStarted = true
  sql(`
    create role retry_test_authenticator login noinherit;
    create role retry_test_user nologin;
    grant retry_test_user to retry_test_authenticator;
    create schema api;
    create table api.synthetic_record (id integer primary key, row_version integer not null, body text not null);
    insert into api.synthetic_record values (1, 5, 'unchanged synthetic source');
    create function api.revision_conflict() returns void language plpgsql as $$
    begin raise sqlstate 'PT409' using message = 'This report changed. Reload before saving.'; end $$;
    create function api.pending_evidence() returns void language plpgsql as $$
    begin raise sqlstate 'PT409' using message = 'Evidence is still processing.'; end $$;
    create function api.critical_access_probe() returns jsonb language sql stable as $$
      select jsonb_build_object('verified', true, 'row_version', row_version) from api.synthetic_record where id=1
    $$;
    grant usage on schema api to retry_test_user;
    grant select on api.synthetic_record to retry_test_user;
    grant execute on all functions in schema api to retry_test_user;
    alter role retry_test_user set statement_timeout = '2s';
  `)
  const configuration = join(directory, 'postgrest.conf')
  writeFileSync(configuration, `db-uri = "postgres://retry_test_authenticator@127.0.0.1:${databasePort}/postgres"\ndb-schemas = "api"\ndb-anon-role = "retry_test_user"\ndb-pool = 4\ndb-pool-acquisition-timeout = 3\nserver-host = "127.0.0.1"\nserver-port = ${httpPort}\nlog-level = "error"\n`)
  const apiLog = openSync(join(directory, 'postgrest.log'), 'a')
  api = spawn(postgrestBin, [configuration], { windowsHide: true, stdio: ['ignore', apiLog, apiLog] })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (api.exitCode !== null) throw new Error('PostgREST exited before readiness; inspect the local test log')
    try { ready = (await fetch(`${base}/`, { signal: AbortSignal.timeout(500) })).ok } catch { /* wait for actual readiness */ }
    if (ready) break
    await delay(100)
  }
  assert(ready, 'The isolated PostgREST service did not become ready')
  const sourceBefore = sql('select row_to_json(r) from api.synthetic_record r')
  const rollbackBefore = Number(sql("select xact_rollback from pg_stat_database where datname='postgres'"))
  const timings = []
  const probeTimings = []
  async function request(path, expectedStatus, timingsList) {
    const start = performance.now()
    const response = await fetch(`${base}/rpc/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5_000) })
    const body = await response.json()
    timingsList.push(performance.now() - start)
    assert.equal(response.status, expectedStatus)
    if (expectedStatus === 409) assert.equal(body.code, 'PT409')
    else assert.equal(body.verified, true)
  }
  // Many deterministic conflicts must finish, release their pooled connections,
  // and leave unrelated authenticated database work available.
  for (let batch = 0; batch < 20; batch += 1) {
    await Promise.all([
      request('revision_conflict', 409, timings), request('pending_evidence', 409, timings),
      request('revision_conflict', 409, timings), request('critical_access_probe', 200, probeTimings),
    ])
  }
  assert.equal(Number(sql("select count(*) from pg_stat_activity where usename='retry_test_authenticator' and state='active'")), 0)
  // Close the local API pool so each backend flushes its final statistics. An
  // early statistics snapshot alone can conceal an unflushed retry counter.
  await stopApi()
  let rollbackAfter = rollbackBefore
  for (let attempt = 0; attempt < 50; attempt += 1) {
    rollbackAfter = Number(sql("select xact_rollback from pg_stat_database where datname='postgres'"))
    if (rollbackAfter - rollbackBefore >= timings.length) break
    await delay(100)
  }
  const rollbackDelta = rollbackAfter - rollbackBefore
  assert(rollbackDelta >= timings.length && rollbackDelta <= timings.length + 5,
    `Expected about one rollback per rejected request, not a retry loop: ${rollbackDelta}`)
  assert.equal(sql('select row_to_json(r) from api.synthetic_record r'), sourceBefore)
  assert.equal(Number(sql("select count(*) from pg_stat_activity where usename='retry_test_authenticator' and state='active'")), 0)
  const result = {
    passed: true, capturedAt: new Date().toISOString(), postgres: run(join(postgresBin, `postgres${extension}`), ['--version']).trim(),
    postgrest: run(postgrestBin, ['--version']).trim(), syntheticOnly: true, databasePool: 4,
    rejectedRequests: timings.length, criticalProbes: probeTimings.length, rollbackDelta,
    maxConflictMs: Math.round(Math.max(...timings)), maxCriticalProbeMs: Math.round(Math.max(...probeTimings)),
    originalSyntheticRecordPreserved: true, lingeringActiveRequests: 0, artifacts: directory,
  }
  const output = process.env.RETRY_TEST_RESULT
  if (output) writeFileSync(resolve(output), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
} finally {
  try {
    await stopApi()
  } finally {
    if (databaseStarted) run(join(postgresBin, `pg_ctl${extension}`), ['-D', data, '-m', 'fast', '-w', 'stop'])
  }
}
