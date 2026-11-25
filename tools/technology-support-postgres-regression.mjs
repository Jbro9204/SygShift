import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

const environment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(?:PG|DATABASE_URL|SUPABASE_)/iu.test(key)))
const { bin, extension } = isolatedPostgresRuntime({ platform: process.platform, environment, override: process.env.SUPPORT_TEST_POSTGRES_BIN })
const directory = mkdtempSync(join(tmpdir(), 'sygshift-technology-support-'))
const data = join(directory, 'data')
const socket = net.createServer()
await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes) })
const port = socket.address().port
await new Promise((yes) => socket.close(yes))
const run = (name, args, options = {}) => {
  const result = spawnSync(join(bin, name + extension), args, {
    encoding: 'utf8', env: environment, windowsHide: true, timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024, ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}), ...options,
  })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout)
  return (result.stdout ?? '').trim()
}
const read = (file) => readFileSync(new URL('../supabase/' + file, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const migrations = {
  base: read('migrations/20260906125806_support_ticket_system.sql'),
  lifecycle: read('migrations/20260906172200_support_ticket_lifecycle_and_delivery.sql'),
  current: read('migrations/20260908143000_support_notification_routing_and_session_foundation.sql'),
  mfa: read('migrations/20261019233625_authorization_boundary_hardening.sql'),
  details: read('migrations/20260906190358_realtime_notification_delivery.sql'),
}
function sourceFunction(file, name) {
  const definitions = [...file.matchAll(/^create (?:or replace )?function ([\w.]+)\([\s\S]*?^\$(?:function)?\$\s*;/gimu)]
  const exact = definitions.filter((item) => item[1] === name)
  assert.equal(exact.length, 1, 'Could not isolate exactly one definition for ' + name)
  return exact[0][0].replace('target_ticket support_tickets)', 'target_ticket public.support_tickets)')
}
const schemaStart = migrations.base.indexOf('\ncreate table public.support_tickets (')
const schemaEnd = migrations.base.indexOf('\ncreate or replace function private.support_route_permission')
assert(schemaStart >= 0 && schemaEnd > schemaStart, 'Support source table definitions changed')
const migration = read('migrations/20261124231044_sygilant_technology_ticket_workspace.sql')
assert.match(migration, /^begin;[\s\S]*\bcommit;\s*$/iu)
const migrationBody = migration.replace(/^begin;/iu, '').replace(/\bcommit;\s*$/iu, '')
assert(!/^(?:begin|commit|rollback);/imu.test(migrationBody), 'Unexpected transaction control inside migration')
const sql = [
  "begin; set local statement_timeout = '30s';",
  read('tests/technology_support_fixtures.sql'),
  migrations.base.slice(schemaStart, schemaEnd),
  'alter table public.support_tickets add column submission_key uuid;',
  sourceFunction(migrations.base, 'private.support_route_permission'),
  sourceFunction(migrations.base, 'private.support_priority'),
  sourceFunction(migrations.mfa, 'private.support_can_view'),
  sourceFunction(migrations.mfa, 'private.support_can_manage'),
  ...['support_employee_can_view', 'support_employee_can_handle', 'support_notification_recipients', 'queue_support_ticket_notification']
    .map((name) => sourceFunction(migrations.current, 'private.' + name)),
  ...['submit_support_ticket', 'add_support_ticket_message', 'update_support_ticket', 'get_support_ticket_assignees']
    .map((name) => sourceFunction(migrations.current, 'public.' + name)),
  sourceFunction(migrations.lifecycle, 'public.get_support_workspace'),
  sourceFunction(migrations.details, 'public.read_support_ticket'),
  migrationBody,
  read('tests/technology_support_checks.sql'),
  "rollback; select to_regclass('private.sygilant_technology_ticket_action_receipts') is null;",
].join('\n')
let started = false
let priorError
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  startIsolatedPostgres({ data, directory, port, run, utc: true })
  started = true
  const result = run('psql', ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-'], { input: sql })
  const lines = result.split(/\r?\n/u)
  const outcome = JSON.parse(lines.findLast((line) => line.startsWith('{"checks"')))
  assert.equal(outcome.passed, true, JSON.stringify(outcome.failed))
  assert.equal(lines.at(-1), 't', 'Schema and all fixture data must roll back')
  console.log(JSON.stringify({ ...outcome, syntheticOnly: true, rolledBack: true, productionConnections: 0 }))
} catch (error) { priorError = error; throw error }
finally { stopIsolatedPostgres({ data, run, started, priorError }) }
