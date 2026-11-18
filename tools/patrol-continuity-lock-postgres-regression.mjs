import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { continuityPreservationSql } from './patrol-continuity-release.mjs'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

assert.equal(process.versions.node, '24.19.0')
assert.equal(process.argv.length, 2, 'This local-only regression accepts no connection arguments.')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const { bin, extension } = isolatedPostgresRuntime({ platform: process.platform, environment, override: process.env.PATROL_TEST_POSTGRES_BIN })
const directory = mkdtempSync(join(tmpdir(), 'sygshift-continuity-lock-'))
const data = join(directory, 'data')
const socket = net.createServer()
await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes) })
const port = socket.address().port
await new Promise((yes) => socket.close(yes))
const run = (name, args, options = {}) => {
  const result = spawnSync(join(bin, name + extension), args, { encoding: 'utf8', env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024, ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}), ...options })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout)
  return (result.stdout ?? '').trim()
}
const connection = ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-']
const sql = (input) => run('psql', connection, { input })
const digest = () => sql("select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]')) from supabase_migrations.schema_migrations m")
const target = { version: '20990101000000', changed: [], added: [], relations: [], triggers: [] }
const launch = (input, keepOpen = false) => {
  const child = spawn(join(bin, 'psql' + extension), connection, { env: environment, windowsHide: true, stdio: 'pipe' })
  let output = '', error = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { error += chunk })
  const done = new Promise((yes, no) => {
    const timeout = setTimeout(() => child.kill(), 15_000)
    child.once('error', no)
    child.once('close', (code) => { clearTimeout(timeout); yes({ code, output: output.trim(), error }) })
  })
  if (keepOpen) child.stdin.write(input)
  else child.stdin.end(input)
  return { child, done, output: () => output }
}
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 2_500
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(message)
}
let checks = 0, started = false, priorError
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1 }
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  startIsolatedPostgres({ data, directory, port, run, utc: true }); started = true
  sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]); insert into supabase_migrations.schema_migrations values('20000101000000','original',array['select 1']);")
  const original = digest()
  const before = continuityPreservationSql(target, original)
  sql(`${before}\nrollback;`)
  checks += 1

  for (const commit of [true, false]) {
    const writer = launch("begin; insert into supabase_migrations.schema_migrations values('20000102000000','concurrent',array['select 2']); select 'WRITER_READY';\n", true)
    let reader
    try {
      await waitFor(() => writer.output().includes('WRITER_READY'), 'The isolated ledger writer did not become ready')
      reader = launch(`set application_name='continuity_lock_reader';\n${continuityPreservationSql(target, original)}\nselect 'READER_ACCEPTED'; rollback;`)
      await waitFor(() => sql("select exists(select 1 from pg_stat_activity where application_name='continuity_lock_reader' and wait_event_type='Lock')") === 't', 'The release guard did not wait for the ledger writer')
      checks += 1
      writer.child.stdin.end(`${commit ? 'commit' : 'rollback'};\n`)
      check((await writer.done).code, 0, 'The isolated writer finishes cleanly')
      const result = await reader.done
      if (commit) {
        check(result.code !== 0 && result.error.includes('Migration predecessor changed'), true, 'After waiting, release guard sees the newly committed ledger and rejects its stale predecessor')
        check(result.output.includes('READER_ACCEPTED'), false, 'Stale repeatable-read state never accepts the changed ledger')
        sql("delete from supabase_migrations.schema_migrations where version='20000102000000';")
      } else {
        check(result.code, 0, 'A rolled-back writer leaves the expected predecessor valid')
        check(result.output.includes('READER_ACCEPTED'), true, 'The guard proceeds only after the rollback is visible')
      }
      check(digest(), original, 'The fixture ledger returns to its original contents')
    } finally {
      if (writer.child.exitCode === null) { writer.child.stdin.end('rollback;\n'); await writer.done }
      if (reader && reader.child.exitCode === null) { reader.child.kill(); await reader.done }
    }
  }
  console.log(JSON.stringify({ passed: true, checks, syntheticOnly: true, productionConnections: 0, freshLedgerAfterLock: true, artifacts: directory }))
} catch (error) { priorError = error; throw error } finally { stopIsolatedPostgres({ data, run, started, priorError }) }
