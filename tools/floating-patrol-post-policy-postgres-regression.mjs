import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const { bin, extension } = isolatedPostgresRuntime({ platform: process.platform, environment, override: process.env.PATROL_TEST_POSTGRES_BIN })
const directory = mkdtempSync(join(tmpdir(), 'sygshift-floating-post-'))
const data = join(directory, 'data')
const socket = net.createServer()
await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes) })
const port = socket.address().port
await new Promise((yes) => socket.close(yes))
const run = (name, args, options = {}) => {
  const result = spawnSync(join(bin, name + extension), args, { encoding: 'utf8', env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024, ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}), ...options })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout)
  return (result.stdout ?? '').trim()
}
const read = (path) => readFileSync(new URL('../supabase/' + path, import.meta.url), 'utf8').replaceAll('\r\n','\n')
function migration(filename) {
  const original = read('migrations/' + filename)
  assert.match(original, /\bbegin;[\s\S]*\bcommit;\s*$/iu)
  const body = original.replace(/^([\s\S]*?)\bbegin;/iu, '$1').replace(/\bcommit;\s*$/iu, '')
  assert(!/^(?:begin|commit|rollback);/imu.test(body), 'Unexpected migration transaction control.')
  return body
}
const sql = [
  "begin; set local statement_timeout='30s';",
  read('tests/floating_patrol_post_policy_fixtures.sql'),
  migration('20261121203920_floating_patrol_shift_scope.sql'),
  migration('20261124151311_floating_patrol_post_policy.sql'),
  read('tests/floating_patrol_post_policy_checks.sql'),
  "rollback; select to_regclass('private.floating_patrol_post_policies') is null;",
].join('\n')
let started = false
let priorError
try {
  run('initdb', ['-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C'])
  startIsolatedPostgres({ data, directory, port, run, utc: true })
  started = true
  const result = run('psql', ['-X','--no-password','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-qAt','-f','-'], { input:sql })
  const lines = result.split(/\r?\n/u)
  const outcome = JSON.parse(lines.findLast((line) => line.startsWith('{"checks"')))
  assert.equal(outcome.passed,true,JSON.stringify(outcome.failed))
  assert.equal(lines.at(-1),'t','Everything must roll back in the synthetic server.')
  console.log(JSON.stringify({ ...outcome, syntheticOnly:true, rolledBack:true, productionConnections:0 }))
} catch (error) { priorError = error; throw error }
finally { stopIsolatedPostgres({ data, run, started, priorError }) }
