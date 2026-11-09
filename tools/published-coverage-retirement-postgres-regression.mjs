import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'

// Isolated native PostgreSQL only. Never reads application credential files.
assert.equal(process.versions.node, '24.19.0')
const extension = process.platform === 'win32' ? '.exe' : ''
const bin = resolve(process.env.COVERAGE_TEST_POSTGRES_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/lib/postgresql/18/bin'))
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const directory = mkdtempSync(join(tmpdir(), 'sygshift-coverage-retirement-'))
const data = join(directory, 'data')
const listener = net.createServer()
await new Promise((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes) })
const port = listener.address().port
await new Promise((yes, no) => listener.close(error => error ? no(error) : yes()))
assert(port > 1024 && port !== 5432)
const run = (name, args, input) => {
  const result = spawnSync(join(bin, name + extension), args, { input, encoding: 'utf8', env: environment, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}
const connection = ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-']
const sql = source => run('psql', connection, source)
const read = path => readFileSync(resolve(path), 'utf8').replaceAll('\r\n', '\n')
const extract = (path, name) => {
  const source = read(path)
  const start = source.indexOf(`create or replace function ${name}(`)
  assert(start >= 0)
  const end = source.indexOf('\n$$;', start)
  assert(end > start)
  return source.slice(start, end + 4)
}
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const call = n => `select private.retire_call_off_live_artifacts('${id(300+n)}','shift_ended_unfilled','The coverage window ended unfilled.','2026-11-08T14:00:00Z',null);`
let checks = 0
const check = (actual, expected, name) => { assert.deepEqual(actual, expected, name); checks += 1 }
const reject = statement => {
  sql(`do $test$ begin begin ${statement} raise exception 'Expected immutable rejection did not occur'; exception when raise_exception then if sqlerrm not like 'Published schedule records are immutable%' then raise; end if; end; end $test$;`)
  checks += 1
}
const snapshot = table => sql(`select coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]') from ${table} t;`)
function seed(n, status, assigned = false, generated = true) {
  sql(`insert into public.schedules values('${id(n)}','${status}');
    insert into public.shifts(id,schedule_id,starts_at,ends_at,is_open,coverage_source_shift_id) values
      ('${id(100+n)}','${id(n)}','2026-11-08T01:00:00Z','2026-11-08T13:00:00Z',true,${generated ? `'${id(200+n)}'` : 'null'});
    insert into public.call_off_reports(id,shift_id) values('${id(300+n)}','${id(100+n)}');
    insert into public.shift_coverage_cases(id,call_off_report_id,coverage_shift_id,status,coverage_mode,replacement_assignment_id)
      values('${id(400+n)}','${id(300+n)}','${id(100+n)}','${assigned ? 'assigned' : 'open_pool'}','${assigned ? 'assigned_guard' : 'open_pool'}',${assigned ? `'${id(500+n)}'` : 'null'});
    insert into public.operational_alerts(id,related_record_type,related_record_id,active,lifecycle_state)
      values('${id(600+n)}','call_off_report','${id(300+n)}',true,'active_operations');`)
}
let started = false
try {
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
  run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c timezone=UTC`, '-w', 'start'])
  started = true
  sql(`create role anon; create role authenticated; create role service_role;
    create schema private;
    create type public.schedule_status as enum('draft','published','superseded');
    create table public.schedules(id uuid primary key,status public.schedule_status);
    create table public.shifts(id uuid primary key,schedule_id uuid,starts_at timestamptz,ends_at timestamptz,is_open boolean,canceled_at timestamptz,canceled_by uuid,cancellation_reason text,updated_at timestamptz,coverage_source_shift_id uuid);
    create table public.shift_assignments(id uuid primary key,shift_id uuid,status text);
    create table public.call_off_reports(id uuid primary key,shift_id uuid,announcement_id uuid,duplicate_of_call_off_report_id uuid);
    create table public.shift_coverage_cases(id uuid primary key,call_off_report_id uuid,coverage_shift_id uuid,status text,coverage_mode text,replacement_assignment_id uuid,announcement_id uuid,resolved_by uuid,resolved_at timestamptz,updated_at timestamptz);
    create table public.shift_coverage_case_actions(id bigint generated always as identity,coverage_case_id uuid,action text,actor_id uuid,reason text,before_record jsonb,after_record jsonb);
    create table public.operational_alerts(id uuid primary key,related_record_type text,related_record_id uuid,active boolean,lifecycle_state text,live_until_at timestamptz,lifecycle_evaluated_at timestamptz,cleared_at timestamptz,cleared_by uuid,clear_source text,cleared_reason text);
    create table public.employee_notifications(id uuid primary key,source_type text,source_id uuid,action_required boolean,resolved_at timestamptz,expires_at timestamptz);
    create table private.shift_coverage_notification_waves(id uuid primary key,coverage_case_id uuid,status text,processed_at timestamptz,updated_at timestamptz,last_error text);
    create table public.announcements(id uuid primary key,expires_at timestamptz,published_at timestamptz,updated_at timestamptz);
    create table public.shift_requests(id uuid primary key,shift_id uuid,status text,decided_by uuid,decided_at timestamptz,decision_note text,updated_at timestamptz);
    create table private.employee_push_deliveries(id uuid primary key,notification_id uuid,completed_at timestamptz,outcome text);
    create table public.employee_notification_email_deliveries(id uuid primary key,notification_id uuid,delivered_at timestamptz,failed_at timestamptz,last_error text);
    create table private.notification_outbox(id uuid primary key,message_type text,aggregate_type text,aggregate_id uuid,delivered_at timestamptz,failed_at timestamptz,last_error text);
    create table public.time_events(id uuid primary key,occurred_at timestamptz);
    create table private.payroll_rows(id uuid primary key,minutes integer);
    insert into public.time_events values('${id(1)}','2026-11-08T13:00:00Z');
    insert into private.payroll_rows values('${id(1)}',720);`)
  sql(extract('supabase/migrations/202607030005_request_and_calloff_workflow.sql', 'private.protect_published_schedule_child'))
  sql(extract('supabase/migrations/20261005123949_call_off_alert_lifecycle_retirement.sql', 'private.retire_call_off_live_artifacts'))
  sql('create trigger published_guard before update or delete on public.shifts for each row execute function private.protect_published_schedule_child();')
  check(sql("select md5(prosrc) from pg_proc where oid='private.retire_call_off_live_artifacts(uuid,text,text,timestamptz,uuid)'::regprocedure"), 'c0d8d7de4ec4eb11c00ee7a979ddc4ca', 'Actual prior source exactly matches reviewed production body')
  seed(1, 'published')
  seed(2, 'draft')
  seed(3, 'published', true)
  seed(4, 'published')
  seed(5, 'published', false, false)
  sql(`insert into public.shift_assignments values('${id(504)}','${id(104)}','confirmed');`)
  reject(`perform private.retire_call_off_live_artifacts('${id(301)}','shift_ended_unfilled','The coverage window ended unfilled.','2026-11-08T14:00:00Z',null);`)
  const tables = ['public.schedules','public.shifts','public.shift_assignments','public.call_off_reports','public.shift_coverage_cases','public.shift_coverage_case_actions','public.operational_alerts','public.time_events','private.payroll_rows']
  const before = Object.fromEntries(tables.map(table => [table, snapshot(table)]))
  const guardBefore = sql("select pg_get_functiondef('private.protect_published_schedule_child()'::regprocedure)")
  sql(read('supabase/migrations/20261109203718_published_coverage_retirement_immutability.sql'))
  check(Object.fromEntries(tables.map(table => [table, snapshot(table)])), before, 'Installing code changes no business records')
  check(sql("select pg_get_functiondef('private.protect_published_schedule_child()'::regprocedure)"), guardBefore, 'Published guard remains byte-for-byte unchanged')
  const priorPublished = JSON.parse(sql(`select to_jsonb(s) from public.shifts s where id='${id(101)}'`))
  const publishedResult = JSON.parse(sql(call(1)))
  check(publishedResult.coverageShiftClosedCount, 1, 'Published vacancy closes through permitted is_open change')
  const nextPublished = JSON.parse(sql(`select to_jsonb(s) from public.shifts s where id='${id(101)}'`))
  check(nextPublished.is_open, false, 'Published vacancy no longer advertised')
  for (const key of Object.keys(priorPublished).filter(key => !['is_open','updated_at'].includes(key))) check(nextPublished[key], priorPublished[key], `Published field preserved: ${key}`)
  check(sql(`select status from public.shift_coverage_cases where id='${id(401)}'`), 'closed', 'Lifecycle case closes')
  check(sql(`select reason from public.shift_coverage_case_actions where coverage_case_id='${id(401)}'`), 'The coverage window ended unfilled.', 'Retirement reason remains in audit history')
  check(sql(`select active::text from public.operational_alerts where id='${id(601)}'`), 'false', 'Stale alert retires')
  const actionCount = snapshot('public.shift_coverage_case_actions')
  check(JSON.parse(sql(call(1))).coverageShiftClosedCount, 0, 'Published retry makes no extra shift change')
  check(snapshot('public.shift_coverage_case_actions'), actionCount, 'Published retry appends no duplicate close action')
  check(JSON.parse(sql(call(2))).coverageShiftClosedCount, 1, 'Draft retirement retains cancellation behavior')
  check(sql(`select canceled_at='2026-11-08T14:00:00Z'::timestamptz and cancellation_reason='Call-off lifecycle retirement: The coverage window ended unfilled.' and not is_open from public.shifts where id='${id(102)}'`), 't', 'Draft cancellation fields retained')
  for (const n of [3,4,5]) {
    const preserved = sql(`select to_jsonb(s) from public.shifts s where id='${id(100+n)}'`)
    check(JSON.parse(sql(call(n))).coverageShiftClosedCount, 0, `Protected replacement/source skipped: ${n}`)
    check(sql(`select to_jsonb(s) from public.shifts s where id='${id(100+n)}'`), preserved, `Protected replacement/source unchanged: ${n}`)
  }
  for (const table of ['public.schedules','public.shift_assignments','public.call_off_reports','public.time_events','private.payroll_rows']) check(snapshot(table), before[table], `Preserved ${table}`)
  reject(`update public.shifts set starts_at=starts_at+interval '1 hour' where id='${id(101)}';`)
  // Exact-source fences refuse replay and do not introduce a second replacement.
  const replay = spawnSync(join(bin, 'psql'+extension), connection, { input: read('supabase/migrations/20261109203718_published_coverage_retirement_immutability.sql'), encoding:'utf8',env:environment,windowsHide:true })
  check(replay.status !== 0, true, 'Migration replay fails closed')
  console.log(JSON.stringify({ passed:true, syntheticOnly:true, productionConnections:0, checks, priorPublishedFailureReproduced:true, publishedGuardPreserved:true, publishedAndDraftRetirement:true, assignedReplacementsPreserved:true, retriesIdempotent:true }))
} finally {
  if (started || existsSync(join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'])
}
