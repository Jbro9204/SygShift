import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Never consumes application credentials or connects to a linked database.
assert.equal(process.versions.node, '24.19.0')
const extension = process.platform === 'win32' ? '.exe' : ''
const bin = resolve(process.env.TIME_OFF_TEST_POSTGRES_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(name)))
for (const name of ['initdb', 'pg_ctl', 'psql']) assert(existsSync(join(bin, name + extension)))
const directory = mkdtempSync(join(tmpdir(), 'sygshift-time-off-early-return-'))
const data = join(directory, 'data')
const socket = net.createServer()
await new Promise((yes, no) => { socket.once('error', no); socket.listen(0, '127.0.0.1', yes) })
const port = socket.address().port
await new Promise((yes, no) => socket.close(error => error ? no(error) : yes()))
assert(port > 1024 && port !== 5432)
const run = (name, args, options = {}) => {
  const result = spawnSync(join(bin, name + extension), args, { encoding: 'utf8', env: environment, windowsHide: true, timeout: 45_000, maxBuffer: 8 * 1024 * 1024, ...options })
  assert.equal(result.status, 0, result.error?.message ?? result.stderr ?? result.stdout)
  return (result.stdout ?? '').trim()
}
const connection = ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-']
const sql = input => run('psql', connection, { input })
const read = path => readFileSync(resolve(path), 'utf8').replaceAll('\r\n', '\n')
const extract = (path, name) => {
  const source = read(path)
  const start = source.indexOf(`create or replace function ${name}(`)
  assert(start >= 0, name)
  const end = source.indexOf('\n$$;', start)
  assert(end > start, name)
  return source.slice(start, end + 4)
}
const base = 'supabase/migrations/20260928203430_rebuild_time_off_request_center.sql'
const manager = '10000000-0000-4000-8000-000000000001'
const id = n => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const employee = n => `11000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const context = (actor = manager, mfa = true) => `set fixture.actor='${actor}';set fixture.mfa='${mfa}';`
const call = (n, note = 'Employee returned early; make future coverage available.') => `select public.end_approved_time_off_now('${id(n)}','${note}');`
let checks = 0
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks += 1 }
const reject = (statement, code) => {
  sql(`do $test$ begin begin ${statement} raise exception 'Expected rejection did not occur'; exception when sqlstate '${code}' then null; end;end $test$;`)
  checks += 1
}
const snapshot = () => JSON.parse(sql(`select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(t) order by id) from public.time_off_requests t),'schedules',(select jsonb_agg(to_jsonb(t) order by id) from public.schedules t),'shifts',(select jsonb_agg(to_jsonb(t) order by id) from public.shifts t),'punches',(select jsonb_agg(to_jsonb(t) order by id) from public.time_events t),'payrollBatches',(select jsonb_agg(to_jsonb(t) order by id) from private.payroll_export_batches t),'payrollRows',(select jsonb_agg(to_jsonb(t) order by id) from private.payroll_export_rows t),'hrCases',(select jsonb_agg(to_jsonb(t) order by id) from private.hr_leave_cases t))`))
let started = false
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1 -c unix_socket_directories= -c max_connections=10 -c timezone=UTC -c statement_timeout=10000 -c lock_timeout=1000`, '-w', 'start'], { stdio: 'ignore' })
  started = true
  sql(read('tests/fixtures/time-off-cancellation-postgres.sql'))
  sql(read('tests/fixtures/time-off-early-return-postgres.sql'))
  for (const name of ['private.lock_employee_schedule_time_off', 'private.time_off_local_instant', 'private.time_off_window', 'public.withdraw_time_off_request', 'private.enforce_assignment_capacity_and_overlap', 'public.submit_time_off_request_v2']) sql(extract(base, name))
  sql(extract('supabase/migrations/20260929133936_salaried_shift_presence_consistency_repair.sql', 'private.salaried_shift_assignment_has_approved_time_off'))
  sql(extract('supabase/migrations/20260906162426_attendance_reporting_and_classification.sql', 'private.get_attendance_events'))
  sql(extract('supabase/migrations/20260825190000_maintenance_release_controls.sql', 'private.enforce_maintenance_feature_write'))
  sql(extract('supabase/migrations/20260925182312_enforce_schedule_dst_boundaries.sql', 'public.replace_schedule_week_draft_from_revision'))
  sql(read('supabase/migrations/20260930195833_schedule_week_copy_timezone_lookup_cache.sql'))
  sql(read('supabase/migrations/20260930201111_schedule_week_copy_approved_time_off_skip.sql'))
  sql('create trigger assignment_guard before insert or update on public.shift_assignments for each row execute function private.enforce_assignment_capacity_and_overlap();')
  const immutable = extract('supabase/migrations/20260828180000_home_time_off_request_workflow.sql', 'private.protect_time_off_submission_snapshot')
  sql(`${immutable}\ncreate trigger submission_immutable before update on public.time_off_requests for each row execute function private.protect_time_off_submission_snapshot();`)
  sql(read('supabase/migrations/20261105185646_approved_time_off_cancellation.sql'))
  const preserved = sql("select jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) from pg_proc where oid in ('public.cancel_approved_time_off_request(uuid,text)'::regprocedure,'public.get_request_center_payload_v2()'::regprocedure,'public.withdraw_time_off_request(uuid)'::regprocedure,'public.get_request_center_payload()'::regprocedure,'private.get_timekeeping_review_base(date,date)'::regprocedure)")
  const before = snapshot()
  const unchangedAttendance = sql('select private.get_attendance_events(current_date-2,current_date+2);')
  const consumers = ['private.enforce_assignment_capacity_and_overlap()', 'private.salaried_shift_assignment_has_approved_time_off(uuid)', 'public.submit_time_off_request_v2(text,date,date,time,time,date,text)', 'public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)', 'private.get_attendance_events(date,date)']
  const metadata = consumers.map(signature => sql(`select jsonb_build_object('owner',proowner,'acl',proacl,'security',prosecdef,'config',proconfig,'volatility',provolatile) from pg_proc where oid='${signature}'::regprocedure`))
  sql(read('supabase/migrations/20261106172037_approved_time_off_early_return.sql'))
  check(snapshot(), before, 'Installing the migration changes no protected records')
  check(sql('select private.get_attendance_events(current_date-2,current_date+2);'), unchangedAttendance, 'Unchanged requests retain the exact pre-migration attendance projection')
  check(sql("select jsonb_object_agg(oid::regprocedure::text,md5(pg_get_functiondef(oid))) from pg_proc where oid in ('public.cancel_approved_time_off_request(uuid,text)'::regprocedure,'public.get_request_center_payload_v2()'::regprocedure,'public.withdraw_time_off_request(uuid)'::regprocedure,'public.get_request_center_payload()'::regprocedure,'private.get_timekeeping_review_base(date,date)'::regprocedure)"), preserved, 'Full cancellation, pending withdrawal, old payloads and financial source stay exact')
  consumers.forEach((signature, index) => check(sql(`select jsonb_build_object('owner',proowner,'acl',proacl,'security',prosecdef,'config',proconfig,'volatility',provolatile) from pg_proc where oid='${signature}'::regprocedure`), metadata[index], `Preserved catalog metadata: ${signature}`))
  for (const role of ['anon', 'service_role']) check(sql(`select has_function_privilege('${role}','public.end_approved_time_off_now(uuid,text)','execute')`), 'f')
  for (const role of ['anon', 'authenticated', 'service_role']) check(sql(`select has_table_privilege('${role}','private.time_off_request_early_returns','select,insert,update,delete')`), 'f')
  check(sql("select has_function_privilege('authenticated','private.effective_time_off_window(uuid,tstzrange)','execute')"), 'f')
  check(sql("select has_function_privilege('authenticated','private.time_off_cancellation_context(uuid,uuid,timestamptz)','execute')"), 'f')
  check(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='private.time_off_request_early_returns'::regclass"), 't')
  reject(context(manager, false) + call(101), '42501')
  reject(context(employee(101)) + call(101), '42501')
  reject(context() + call(109), '42501')
  sql(`update private.fixture_accounts set disabled=true where employee_id='${manager}';`)
  reject(context() + call(101), '42501')
  sql(`update private.fixture_accounts set disabled=false where employee_id='${manager}';`)
  for (const n of [102, 103, 104, 105, 106, 107, 108, 110, 113]) reject(context() + call(n), '23514')
  sql(`update public.time_off_requests set status='pending' where id='${id(112)}';`)
  reject(context() + call(112), '23514')
  sql(`update public.time_off_requests set status='approved' where id='${id(112)}';`)
  reject(context() + call(101, '   '), '23514')
  reject(context() + call(101, 'x'.repeat(2001)), '23514')
  sql("insert into public.maintenance_windows values('Synthetic maintenance','read_only',clock_timestamp()+interval '1 hour','scheduled',clock_timestamp()-interval '1 hour',array['requests']);")
  reject(context() + call(101), '42501')
  sql('delete from public.maintenance_windows;')
  check(sql('select count(*) from private.time_off_request_early_returns'), '0', 'Every denial is atomic with no receipt')
  const futureShift = `insert into public.shifts(id,schedule_id,starts_at,ends_at,headcount_required) values('71000000-0000-4000-8000-000000000101','60000000-0000-4000-8000-000000000001',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '9 hours',1);`
  sql(futureShift)
  const assignment = `insert into public.shift_assignments values('91000000-0000-4000-8000-000000000101','71000000-0000-4000-8000-000000000101','${employee(101)}','assigned');`
  reject(assignment, '23514')
  check(sql(context() + call(101)), 't')
  const after = snapshot()
  check(after.requests, before.requests, 'Early return preserves every request field and approval exactly')
  for (const key of ['schedules', 'punches', 'payrollBatches', 'payrollRows', 'hrCases']) check(after[key], before[key], `${key} untouched`)
  check(sql(`select ended_at>=recorded_at-interval '1 second' and ended_at=recorded_at and lower(retained_window)=lower(original_window) and upper(retained_window)=lower(released_window) and upper(released_window)=upper(original_window) from private.time_off_request_early_returns where request_id='${id(101)}';`), 't', 'Server cutoff partitions the original window exactly with no gap or overlap')
  check(sql(`select private.effective_time_off_window(request_id,original_window) && tstzrange(ended_at,ended_at+interval '1 hour','[)') from private.time_off_request_early_returns where request_id='${id(101)}';`), 'f', 'The exact return instant belongs only to the available suffix')
  check(sql(`select private.effective_time_off_window(request_id,original_window) && tstzrange(ended_at-interval '1 microsecond',ended_at,'[)') from private.time_off_request_early_returns where request_id='${id(101)}';`), 't', 'The entire pre-return prefix stays protected')
  check(sql(context() + call(101)), 't', 'Exact retry returns existing result')
  reject(context() + call(101, 'Different reason'), '23514')
  check(sql(`select count(*) from private.audit_events where operation='END_APPROVED_NOW' and row_id='${id(101)}';`), '1')
  sql(assignment)
  sql(`update public.employees set employment_type='salary' where id='${employee(101)}';`)
  check(sql(`select private.salaried_shift_assignment_has_approved_time_off('91000000-0000-4000-8000-000000000101');`), 'f', 'Scheduling helper respects the released future even after a later classification change')
  sql(`update public.employees set employment_type='hourly' where id='${employee(101)}';`)
  sql(`insert into public.shifts(id,schedule_id,starts_at,ends_at,headcount_required) values('71000000-0000-4000-8000-000000000102','60000000-0000-4000-8000-000000000001',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',1);`)
  reject(`insert into public.shift_assignments values('91000000-0000-4000-8000-000000000102','71000000-0000-4000-8000-000000000102','${employee(101)}','assigned');`, '23514')
  sql(`insert into public.shifts(id,schedule_id,starts_at,ends_at,headcount_required)
    select '71000000-0000-4000-8000-000000000103','60000000-0000-4000-8000-000000000001',ended_at-interval '1 hour',ended_at+interval '1 hour',1
    from private.time_off_request_early_returns where request_id='${id(101)}';`)
  reject(`insert into public.shift_assignments values('91000000-0000-4000-8000-000000000103','71000000-0000-4000-8000-000000000103','${employee(101)}','assigned');`, '23514')
  check(sql(`select count(*) from jsonb_array_elements(private.get_attendance_events(current_date+1,current_date+1)) e where e->>'id'='${id(101)}';`), '0', 'Released days do not show approved leave in attendance')
  check(sql(`select count(*) from jsonb_array_elements(private.get_attendance_events(current_date-1,current_date-1)) e where e->>'id'='${id(101)}';`), '1', 'Retained history still appears in attendance')
  const ownPayload = JSON.parse(sql(context(employee(101), false) + 'select public.get_request_center_payload_v3();'))
  check(ownPayload.timeOff.every(row => row.employeeId === employee(101)), true)
  check(ownPayload.timeOff[0].status, 'approved')
  check(ownPayload.timeOff[0].cancellationContext.phase, 'ended_early')
  check(ownPayload.timeOff[0].earlyReturn.note, 'Employee returned early; make future coverage available.')
  check(ownPayload.fixtureUnchanged, 'canonical payload')
  const managerPayload = JSON.parse(sql(context() + 'select public.get_request_center_payload_v3();'))
  check(managerPayload.timeOff.find(row => row.id === id(107)).cancellationContext.canCancel, true)
  check(managerPayload.timeOff.find(row => row.id === id(104)).cancellationContext.canEndNow, false)
  const receiptZone = sql(`select time_zone from private.time_off_request_early_returns where request_id='${id(101)}';`)
  sql(`update public.employees set time_zone='America/Los_Angeles' where id='${employee(101)}';`)
  check(sql(context() + `select (public.get_request_center_payload_v3()->'timeOff') @> '[{"id":"${id(101)}","earlyReturn":{"timeZone":"${receiptZone}"}}]'::jsonb;`), 't', 'Later employee-zone changes do not move historical request boundaries')
  sql(`update public.employees set time_zone='America/New_York' where id='${employee(101)}';`)
  reject(`update private.time_off_request_early_returns set note='tampered' where request_id='${id(101)}';`, 'P0001')
  reject(`delete from private.time_off_request_early_returns where request_id='${id(101)}';`, 'P0001')
  reject(`select private.effective_time_off_window('${id(101)}',tstzrange(now()-interval '1 day',now()+interval '1 day','[)'));`, '23514')
  const submitted = sql(context(employee(101), false) + `select public.submit_time_off_request_v2('unpaid_time_off',current_date+1,current_date+1,null,null,null,'Future released day');`)
  check(/^[0-9a-f-]{36}$/u.test(submitted), true, 'Employee can request the released future without losing the prior record')
  const concurrent = () => new Promise((yes, no) => {
    const child = spawn(join(bin, 'psql' + extension), connection, { env: environment, windowsHide: true, stdio: 'pipe' })
    let output = ''; let error = ''
    child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { error += value })
    const timeout = setTimeout(() => child.kill(), 15_000)
    child.once('error', no); child.once('close', code => { clearTimeout(timeout); code === 0 ? yes(output.trim()) : no(new Error(error)) })
    child.stdin.end(context() + call(111))
  })
  check(await Promise.all([concurrent(), concurrent()]), ['t', 't'])
  check(sql(`select count(*) from private.audit_events where operation='END_APPROVED_NOW' and row_id='${id(111)}';`), '1', 'Concurrent retries produce one receipt and one audit event')
  sql(`update public.employees set employment_type='flex' where id='${employee(112)}';`)
  check(sql(context() + call(112)), 't', 'Known unpaid flex leave is supported without changing financial records')
  // Exact DST range arithmetic is tested independently of today's server clock.
  check(sql("select extract(epoch from upper(private.time_off_window('2027-11-07','2027-11-07',null,null,'America/New_York'))-lower(private.time_off_window('2027-11-07','2027-11-07',null,null,'America/New_York')))/3600;"), '25.0000000000000000')
  check(sql("select extract(epoch from upper(private.time_off_window('2027-03-14','2027-03-14',null,null,'America/New_York'))-lower(private.time_off_window('2027-03-14','2027-03-14',null,null,'America/New_York')))/3600;"), '23.0000000000000000')
  for (const signature of consumers) check(sql(`select strpos(pg_get_functiondef('${signature}'::regprocedure),'private.effective_time_off_window(')>0;`), 't', `Effective prefix routed: ${signature}`)
  console.log(JSON.stringify({ passed: true, syntheticOnly: true, productionConnections: 0, checks, actualAssignmentGuard: true, actualSubmissionOverlap: true, actualAttendanceProjection: true, copySourceContractVerified: true, fullCopyExecution: false, concurrentRetryVerified: true, originalApprovalPreserved: true, fixture: directory }))
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
}
