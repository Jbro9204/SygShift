import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Synthetic only: no linked/production mode, credentials or application env.
assert.equal(process.versions.node, '24.19.0')
const extension = process.platform === 'win32' ? '.exe' : ''
const bin = resolve(process.env.TIME_OFF_TEST_POSTGRES_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(name)))
for (const name of ['initdb', 'pg_ctl', 'psql']) assert(existsSync(join(bin, name + extension)))
const directory = mkdtempSync(join(tmpdir(), 'sygshift-time-off-cancel-'))
const data = join(directory, 'data')
const socket = net.createServer()
await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes) })
const port = socket.address().port
await new Promise((yes, no) => socket.close(error => error ? no(error) : yes()))
assert(port > 1024 && port !== 5432)
const run = (name, args, options = {}) => {
  const result = spawnSync(join(bin, name + extension), args, { encoding: 'utf8', env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024, ...options })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout)
  return (result.stdout ?? '').trim()
}
const connection = ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-']
const sql = input => run('psql', connection, { input })
const source = readFileSync(resolve('supabase/migrations/20260928203430_rebuild_time_off_request_center.sql'), 'utf8')
const extract = name => {
  const start = source.indexOf(`create or replace function ${name}(`)
  assert(start >= 0, name)
  const end = source.indexOf('\n$$;', start)
  assert(end > start, name)
  return source.slice(start, end + 4)
}
const manager = '10000000-0000-4000-8000-000000000001'
const employee = '10000000-0000-4000-8000-000000000002'
const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const context = (actor = manager, mfa = true) => `set fixture.actor='${actor}';set fixture.mfa='${mfa}';`
const call = (n, note = 'Employee no longer needs leave.') => `select public.cancel_approved_time_off_request('${id(n)}','${note}');`
let checks = 0
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }
function reject(statement, code) {
  sql(`do $test$ begin begin ${statement} raise exception 'Expected rejection did not occur'; exception when sqlstate '${code}' then null; end;end $test$;`)
  checks += 1
}
const protectedSnapshot = () => JSON.parse(sql(`select jsonb_build_object('schedules',(select jsonb_agg(to_jsonb(t)) from public.schedules t),'shifts',(select jsonb_agg(to_jsonb(t)) from public.shifts t),'punches',(select jsonb_agg(to_jsonb(t)) from public.time_events t),'payrollBatches',(select jsonb_agg(to_jsonb(t)) from private.payroll_export_batches t),'payrollRows',(select jsonb_agg(to_jsonb(t)) from private.payroll_export_rows t),'hrCases',(select jsonb_agg(to_jsonb(t)) from private.hr_leave_cases t))`))
let started = false
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -c unix_socket_directories= -c max_connections=10 -c timezone=UTC -c statement_timeout=10000 -c lock_timeout=1000`, '-w', 'start'], { stdio: 'ignore' })
  started = true
  sql(readFileSync(resolve('tests/fixtures/time-off-cancellation-postgres.sql'), 'utf8'))
  for (const name of ['private.lock_employee_schedule_time_off', 'private.time_off_local_instant', 'private.time_off_window', 'public.withdraw_time_off_request', 'private.enforce_assignment_capacity_and_overlap']) sql(extract(name))
  sql('create trigger assignment_guard before insert or update on public.shift_assignments for each row execute function private.enforce_assignment_capacity_and_overlap();')
  const immutable = readFileSync(resolve('supabase/migrations/20260828180000_home_time_off_request_workflow.sql'), 'utf8').match(/create or replace function private\.protect_time_off_submission_snapshot\(\)[\s\S]*?\n\$\$;/u)?.[0]
  assert(immutable)
  sql(`${immutable}\ncreate trigger submission_immutable before update on public.time_off_requests for each row execute function private.protect_time_off_submission_snapshot();`)
  const definitions = sql("select jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) from pg_proc where oid in ('private.enforce_assignment_capacity_and_overlap()'::regprocedure,'public.withdraw_time_off_request(uuid)'::regprocedure,'public.get_request_center_payload()'::regprocedure)")
  const protectedBefore = protectedSnapshot()
  sql(readFileSync(resolve('supabase/migrations/20261105185646_approved_time_off_cancellation.sql'), 'utf8'))
  check(sql("select jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) from pg_proc where oid in ('private.enforce_assignment_capacity_and_overlap()'::regprocedure,'public.withdraw_time_off_request(uuid)'::regprocedure,'public.get_request_center_payload()'::regprocedure)"), definitions, 'Existing assignment, pending withdrawal and canonical read functions remain exact')
  for (const role of ['anon', 'service_role']) check(sql(`select has_function_privilege('${role}','public.cancel_approved_time_off_request(uuid,text)','execute')`), 'f')
  check(sql("select has_table_privilege('authenticated','private.time_off_request_cancellations','select,insert,update,delete')"), 'f')
  check(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='private.time_off_request_cancellations'::regclass"), 't')
  reject(context(manager, false) + call(1), '42501')
  reject(context(employee) + call(1), '42501')
  reject(context('10000000-0000-4000-8000-000000000005') + call(1), '42501')
  reject(context() + call(9), '42501')
  sql(`update private.fixture_accounts set disabled=true where employee_id='${manager}';`)
  reject(context() + call(1), '42501')
  sql(`update private.fixture_accounts set disabled=false where employee_id='${manager}';`)
  for (const n of [2, 3, 4, 5, 8]) reject(context() + call(n), '23514')
  reject(context() + call(1, '   '), '23514')
  reject(context() + call(1, 'x'.repeat(2001)), '23514')
  reject("insert into public.shift_assignments values('90000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','assigned');", '23514')
  const original = sql(`select to_jsonb(request)-'status'-'updated_at' from public.time_off_requests request where id='${id(1)}';`)
  check(sql(context() + call(1)), 't')
  check(sql(`select to_jsonb(request)-'status'-'updated_at' from public.time_off_requests request where id='${id(1)}';`), original, 'Submission and original approval are not rewritten')
  check(sql(context() + call(1)), 't', 'Exact retry is idempotent')
  check(sql("select count(*) from private.audit_events where operation='CANCEL_APPROVED'"), '1')
  reject(context() + call(1, 'Different later reason.'), '23514')
  sql("insert into public.shift_assignments values('90000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','assigned');")
  check(sql('select count(*) from public.shift_assignments'), '1', 'Existing guard permits a deliberate later assignment; cancellation did not create it')
  check(sql(context() + call(6)), 't', 'Future flex leave across the fall-back day can be canceled')
  check(sql(`select extract(epoch from upper(request_window)-lower(request_window))/3600 from private.time_off_request_cancellations where request_id='${id(6)}';`), '25.0000000000000000')
  check(sql(context(employee, false) + `select public.withdraw_time_off_request('${id(8)}');`), 't', 'Pending self-withdrawal still requires no management MFA')
  const ownPayload = JSON.parse(sql(context(employee, false) + 'select public.get_request_center_payload_v2();'))
  check(ownPayload.timeOff.every(row => row.employeeId === employee), true)
  check(ownPayload.timeOff.find(row => row.id === id(1)).cancellation.note, 'Employee no longer needs leave.')
  check(ownPayload.timeOff.find(row => row.id === id(1)).decisionNote, 'Original approval retained.')
  check(ownPayload.fixtureUnchanged, 'canonical payload')
  reject(`update private.time_off_request_cancellations set note='tampered' where request_id='${id(1)}';`, 'P0001')
  check(protectedSnapshot(), protectedBefore, 'Published schedules, shifts, punches, payroll and HR leave cases remain exact')
  const concurrent = () => new Promise((yes, no) => {
    const child = spawn(join(bin, 'psql' + extension), connection, { env: environment, windowsHide: true, stdio: 'pipe' })
    let output = ''; let error = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { error += value })
    const timeout = setTimeout(() => child.kill(), 15_000)
    child.once('error', no); child.once('close', code => { clearTimeout(timeout); code === 0 ? yes(output.trim()) : no(new Error(error)) })
    child.stdin.end(context() + call(12))
  })
  check(await Promise.all([concurrent(), concurrent()]), ['t', 't'])
  check(sql(`select count(*) from private.audit_events where operation='CANCEL_APPROVED' and row_id='${id(12)}';`), '1', 'Concurrent identical requests append one cancellation only')
  console.log(JSON.stringify({ passed: true, syntheticOnly: true, productionConnections: 0, checks, actualAssignmentGuard: true, concurrentRetryVerified: true, originalApprovalPreserved: true, protectedRecordsUnchanged: true, fixture: directory }))
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
}
