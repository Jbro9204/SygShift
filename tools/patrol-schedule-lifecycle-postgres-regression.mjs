import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'
import { continuityPreservationSql, renderPatrolContinuityRelease } from './patrol-continuity-release.mjs'

// This runner never loads application configuration or contacts a hosted database.
assert.equal(process.versions.node, '24.19.0')
const arguments_ = process.argv.slice(2)
assert(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--release-rehearsal' && isAbsolute(arguments_[1])), 'Only --release-rehearsal <absolute Sygilant source root> is supported. No database connection arguments are accepted.')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const { bin, extension } = isolatedPostgresRuntime({ platform: process.platform, environment, override: process.env.PATROL_TEST_POSTGRES_BIN })
const directory = mkdtempSync(join(tmpdir(), 'sygshift-patrol-continuity-'))
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
const read = (path) => readFileSync(resolve(path), 'utf8').replaceAll('\r\n', '\n')
const extract = (text, name) => {
  const match = text.match(new RegExp(`create(?: or replace)? function ${name.replaceAll('.', '\\.')}\\([^]*?\\n\\$\\$;`, 'iu'))
  assert(match, `Missing canonical function ${name}`)
  return match[0]
}
const id = (number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const actor = id(1), guard = id(2), otherGuard = id(3), clientA = id(10), clientB = id(11), siteA = id(20), siteB = id(21), postA = id(30), postB = id(31)
const sourceSchedule = id(40), sourceShift = id(50), routeA = id(60), routeB = id(61), versionA = id(70), versionB = id(71), stopA = id(80), stopB = id(81), requirementA = id(90), requirementB = id(91), patrolA = id(100), obligationA = id(110), hitA = id(120)
const context = (who = actor, mfa = true) => `set fixture.actor='${who}'; set fixture.mfa='${mfa}';`
const enterprise = read('supabase/migrations/20260902110000_enterprise_patrol_operations.sql')
const tables = ['patrol_routes', 'patrol_route_versions', 'patrol_route_stops', 'patrol_stop_requirements', 'patrol_assignments', 'patrol_hit_obligations', 'patrol_makeup_assignments', 'patrol_hits', 'patrol_hit_evidence'].map((name) => {
  const match = enterprise.match(new RegExp(`create table public\\.${name} \\([^]*?\\n\\);`, 'u'))
  assert(match, name)
  return match[0]
}).join('\n')
const copyOnWrite = read('supabase/migrations/20261026151000_schedule_edit_copy_on_write.sql')
const setup = `
create schema private; create schema auth; create schema extensions;
create extension pgcrypto with schema extensions;
create role anon; create role authenticated; create role service_role;
create type public.schedule_status as enum ('draft','published','superseded','archived');
create table public.employees(id uuid primary key, first_name text, last_name text, status text, time_zone text);
create function private.current_employee_id() returns uuid language sql stable as $$select nullif(current_setting('fixture.actor',true),'')::uuid$$;
create function auth.uid() returns uuid language sql stable as $$select private.current_employee_id()$$;
create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')$$;
create function private.can_manage_schedule_drafts() returns boolean language sql stable as $$select private.current_employee_id()='${actor}'::uuid and current_setting('fixture.mfa',true)='true'$$;
create function public.has_effective_permission(code text) returns boolean language sql stable as $$select private.can_manage_schedule_drafts() or (private.current_employee_id() in ('${guard}'::uuid,'${otherGuard}'::uuid) and code in ('patrol.self.view','patrol.hits.complete','patrol.hits.extra'))$$;
create function private.employee_effective_permissions(employee_id uuid) returns text[] language sql stable as $$select case when employee_id='${actor}'::uuid then array['patrol.manage','patrol.operations.view','patrol.view','patrol.self.view'] else array['patrol.self.view'] end$$;
create table public.clients(id uuid primary key,display_name text,status text);
create table public.sites(id uuid primary key,client_id uuid references public.clients(id),name text,code text,active boolean,time_zone text,address_line_1 text,city text,region text,postal_code text);
create table public.posts(id uuid primary key,site_id uuid references public.sites(id),name text,active boolean,requires_armed boolean);
create table public.events(id uuid primary key,site_id uuid references public.sites(id),time_zone text);
create table public.schedules(id uuid primary key default gen_random_uuid(), week_starts_on date,revision integer,status public.schedule_status,previous_revision_id uuid references public.schedules(id),published_at timestamptz,published_by uuid,created_by uuid references public.employees(id),created_at timestamptz default now(),updated_at timestamptz default now());
create unique index schedules_one_published_week_unique on public.schedules(week_starts_on) where status='published';
create table public.shifts(id uuid primary key default gen_random_uuid(),schedule_id uuid references public.schedules(id),post_id uuid references public.posts(id),event_id uuid references public.events(id),starts_at timestamptz,ends_at timestamptz,time_zone text,headcount_required integer default 1,requires_armed boolean default false,is_open boolean default false,is_overtime boolean default false,notes text,work_type text default 'guard',payroll_category text default 'regular',time_zone_source text default 'site',time_zone_employee_id uuid,assignment_type text default 'standard',coverage_source_shift_id uuid,created_by uuid references public.employees(id),created_at timestamptz default now(),updated_at timestamptz default now(),canceled_at timestamptz,canceled_by uuid,cancellation_reason text);
create table public.shift_assignments(id uuid primary key default gen_random_uuid(),shift_id uuid references public.shifts(id),employee_id uuid references public.employees(id),status text,assigned_by uuid,assigned_at timestamptz default now(),confirmed_at timestamptz,canceled_at timestamptz,cancellation_reason text,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.schedule_assignment_overrides(id uuid primary key default gen_random_uuid(),shift_id uuid references public.shifts(id),employee_id uuid references public.employees(id),override_kind text,note text,created_by uuid,created_at timestamptz default now());
create table public.shift_requests(id uuid primary key,shift_id uuid,status text,decision_note text,decided_by uuid,decided_at timestamptz,updated_at timestamptz);
create table private.audit_events(id uuid primary key default gen_random_uuid(),auth_user_id uuid,employee_id uuid,schema_name text,table_name text,operation text,row_id text,old_record jsonb,new_record jsonb,created_at timestamptz default now());
create table private.schedule_shift_revision_links(draft_schedule_id uuid references public.schedules(id),source_schedule_id uuid references public.schedules(id),source_shift_id uuid references public.shifts(id),draft_shift_id uuid references public.shifts(id),created_by uuid references public.employees(id),created_at timestamptz default now(),primary key(draft_schedule_id,source_shift_id));
create function private.active_shift_assignment_count(target uuid) returns integer language sql stable as $$select count(*)::integer from public.shift_assignments where shift_id=target and status in ('assigned','confirmed','completed') and canceled_at is null$$;
${extract(read('supabase/migrations/20261026142017_schedule_draft_set_based_clone.sql'), 'private.normalize_schedule_duplicate_shift_blocks')}
create function public.has_valid_credential(employee_id uuid,credential text,service_date date) returns boolean language sql stable as $$select true$$;
create function public.get_weekly_schedule_payload(target date) returns jsonb language sql stable as $$select coalesce((select to_jsonb(s) from public.schedules s where week_starts_on=target and status='draft' order by revision desc limit 1),(select to_jsonb(s) from public.schedules s where week_starts_on=target and status='published' order by revision desc limit 1))$$;
${tables}
alter table public.patrol_route_stops add column client_id uuid references public.clients(id);
alter table public.patrol_hit_obligations add column source text not null default 'scheduled', add column recovery_hit_window_id uuid;
alter table public.patrol_hit_obligations add constraint patrol_hit_obligations_completed_hit_fk foreign key(completed_hit_id) references public.patrol_hits(id);
create table public.time_events(id uuid primary key,employee_id uuid,shift_id uuid references public.shifts(id),occurred_at timestamptz);
create table private.payroll_rows(id uuid primary key,employee_id uuid,hours numeric);
create table public.sygilant_reports(id uuid primary key,employee_id uuid,shift_id uuid references public.shifts(id),client_id uuid,site_id uuid,status text,content jsonb,assignment_id uuid references public.shift_assignments(id));
create table public.sygilant_report_versions(id uuid primary key,report_id uuid,content jsonb);
create table public.sygilant_report_evidence(id uuid primary key,report_id uuid,object_key text);
create function private.reconcile_patrol_obligations() returns void language plpgsql as $$begin return;end$$;
${extract(read('supabase/migrations/20260902120000_patrol_admin_mfa_boundary.sql'), 'private.patrol_can_manage')}
${extract(enterprise, 'private.patrol_note_is_meaningful')}
${extract(enterprise, 'public.save_patrol_hit')}
${read('supabase/migrations/20260928021235_vacancy_patrol_service_recovery.sql').match(/do \$patch_patrol_evidence_predicate\$[\s\S]*?\$patch_patrol_evidence_predicate\$;/u)[0]}
${extract(read('supabase/migrations/20260902214839_patrol_route_update_persistence.sql'), 'public.save_patrol_route')}
${extract(read('supabase/migrations/20260929143310_patrol_assignment_variable_ambiguity_repair.sql'), 'public.link_patrol_route_shift')}
${extract(enterprise, 'public.get_patrol_workspace')}
${read('supabase/migrations/20260928021235_vacancy_patrol_service_recovery.sql').match(/do \$patch_patrol_workspace\$[\s\S]*?\$patch_patrol_workspace\$;/u)[0]}
revoke all on function public.get_patrol_workspace() from public,anon;
revoke all on function public.save_patrol_route(jsonb) from public,anon;
revoke all on function public.link_patrol_route_shift(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_patrol_workspace() to authenticated;
grant execute on function public.save_patrol_route(jsonb) to authenticated;
grant execute on function public.link_patrol_route_shift(uuid,uuid,uuid) to authenticated;
${extract(copyOnWrite, 'private.materialize_schedule_draft_revision')}
${extract(copyOnWrite, 'public.ensure_schedule_draft')}
${extract(read('supabase/migrations/20261006130458_event_payroll_classification.sql'), 'private.copy_schedule_shift_block')}
revoke all on function private.copy_schedule_shift_block(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.normalize_schedule_duplicate_shift_blocks(uuid) from public,anon,authenticated,service_role;
revoke all on function public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamptz,uuid,boolean) from public,anon;
grant execute on function public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamptz,uuid,boolean) to authenticated;
${extract(read('supabase/migrations/20260802103000_scheduler_manual_notifications_and_week_copy.sql'), 'public.publish_schedule_draft')}
${read('supabase/migrations/20260820143000_overnight_occurrence_and_schedule_publication_integrity.sql').match(/do \$patch_full_schedule_publish\$[\s\S]*?\$patch_full_schedule_publish\$;/u)[0]}
${extract(read('supabase/migrations/20260731161500_employee_scoped_schedule_publish.sql'), 'public.publish_employee_schedule_slice')}
${read('supabase/migrations/20260820143000_overnight_occurrence_and_schedule_publication_integrity.sql').match(/do \$patch_employee_schedule_publish\$[\s\S]*?\$patch_employee_schedule_publish\$;/u)[0]}
${extract(read('supabase/migrations/20260925182312_enforce_schedule_dst_boundaries.sql'), 'public.replace_schedule_week_draft_from_revision')}
insert into public.employees values('${actor}','Synthetic','Manager','active','America/Denver'),('${guard}','Synthetic','Guard','active','America/Denver'),('${otherGuard}','Synthetic','Other','active','America/Denver');
insert into public.clients values('${clientA}','Synthetic Client A','active'),('${clientB}','Synthetic Client B','active');
insert into public.sites values('${siteA}','${clientA}','Site A','A',true,'America/Denver',null,null,null,null),('${siteB}','${clientB}','Site B','B',true,'America/Denver',null,null,null,null);
insert into public.posts values('${postA}','${siteA}','Post A',true,false),('${postB}','${siteB}','Post B',true,false);
`
let checks = 0
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks += 1 }
const rejected = (statement, state) => { sql(`do $test$ begin begin ${statement} raise exception 'Expected rejection did not occur'; exception when sqlstate '${state}' then null; end; end $test$;`); checks += 1 }
const seed = ({ completed = false, started = false, secondClient = false, recorded = true } = {}) => {
  sql(`truncate public.schedules,public.patrol_routes,public.time_events,private.payroll_rows,public.sygilant_reports,public.sygilant_report_versions,public.sygilant_report_evidence,private.audit_events restart identity cascade;
    ${context()}
    insert into public.schedules(id,week_starts_on,revision,status,created_by,published_at) values('${sourceSchedule}',current_date-extract(dow from current_date)::integer,1,'published','${actor}',now()-interval '2 days');
    insert into public.shifts(id,schedule_id,post_id,starts_at,ends_at,time_zone,created_by) values('${sourceShift}','${sourceSchedule}','${postA}',now()+interval '${started || completed ? '-2' : '1'} hours',now()+interval '${completed ? '-1' : '6'} hours','America/Denver','${actor}');
    insert into public.shift_assignments(shift_id,employee_id,status,assigned_by) values('${sourceShift}','${guard}','${completed ? 'completed' : 'confirmed'}','${actor}');
    insert into public.patrol_routes(id,code,name,status,created_by,updated_by) values('${routeA}','client-a','Client A route','active','${actor}','${actor}'),('${routeB}','client-b','Client B route','active','${actor}','${actor}');
    insert into public.patrol_route_versions(id,route_id,version_number,change_reason,created_by) values('${versionA}','${routeA}',1,'Synthetic fixture','${actor}'),('${versionB}','${routeB}',1,'Synthetic fixture','${actor}');
    update public.patrol_routes set current_version_id=case when id='${routeA}' then '${versionA}'::uuid else '${versionB}'::uuid end;
    insert into public.patrol_route_stops(id,route_version_id,sequence_number,location_label,site_id,post_id,client_id) values('${stopA}','${versionA}',1,'Site A','${siteA}','${postA}','${clientA}'),('${stopB}','${versionB}',1,'Site B','${siteB}','${postB}','${clientB}');
    insert into public.patrol_stop_requirements(id,stop_id,day_of_week,required_hits) select '${requirementA}','${stopA}',extract(dow from starts_at at time zone 'America/Denver')::smallint,1 from public.shifts where id='${sourceShift}';
    insert into public.patrol_stop_requirements(id,stop_id,day_of_week,required_hits) select '${requirementB}','${stopB}',extract(dow from starts_at at time zone 'America/Denver')::smallint,1 from public.shifts where id='${sourceShift}';
    insert into public.patrol_assignments(id,route_id,route_version_id,shift_id,employee_id,service_date,status,assigned_by) select '${patrolA}','${routeA}','${versionA}',id,'${guard}',(starts_at at time zone 'America/Denver')::date,'${completed ? 'completed' : 'active'}','${actor}' from public.shifts where id='${sourceShift}';
    insert into public.patrol_hit_obligations(id,assignment_id,stop_id,requirement_id,hit_number,due_start_at,due_end_at,status) select '${obligationA}','${patrolA}','${stopA}','${requirementA}',1,starts_at,ends_at,'${completed ? 'completed' : 'scheduled'}' from public.shifts where id='${sourceShift}';
    ${recorded ? `insert into public.patrol_hits(id,assignment_id,stop_id,obligation_id,classification,status,outcome,note,submitted_by,idempotency_key,submitted_at) values('${hitA}','${patrolA}','${stopA}','${obligationA}','required','${completed ? 'submitted' : 'draft'}','secure','Preserved original patrol evidence','${guard}','${id(121)}',${completed ? 'now()' : 'null'});
    ${completed ? `update public.patrol_hit_obligations set completed_hit_id='${hitA}' where id='${obligationA}';` : ''}
    insert into public.patrol_hit_evidence(hit_id,media_kind,status,object_key,original_filename,mime_type,byte_size,idempotency_key,uploaded_by) values('${hitA}','photo','stored','synthetic/original.jpg','original.jpg','image/jpeg',100,'${id(122)}','${guard}');
    insert into public.sygilant_reports values('${id(130)}','${guard}','${sourceShift}','${clientA}','${siteA}','approved','{"original":true}',null);
    insert into public.sygilant_report_versions values('${id(131)}','${id(130)}','{"immutable":true}');
    insert into public.sygilant_report_evidence values('${id(132)}','${id(130)}','synthetic/report-photo.jpg');
    insert into public.time_events values('${id(140)}','${guard}','${sourceShift}',now()-interval '1 hour');` : ''}
    insert into private.payroll_rows values('${id(141)}','${guard}',8.00);
    ${secondClient ? `insert into public.shifts(id,schedule_id,post_id,starts_at,ends_at,time_zone,created_by) select '${id(51)}',schedule_id,'${postB}',starts_at,ends_at,time_zone,created_by from public.shifts where id='${sourceShift}';
      insert into public.shift_assignments(shift_id,employee_id,status,assigned_by) values('${id(51)}','${otherGuard}','confirmed','${actor}');
      insert into public.patrol_assignments(id,route_id,route_version_id,shift_id,employee_id,service_date,status,assigned_by) select '${id(101)}','${routeB}','${versionB}',id,'${otherGuard}',(starts_at at time zone 'America/Denver')::date,'active','${actor}' from public.shifts where id='${id(51)}';
      insert into public.patrol_hit_obligations(id,assignment_id,stop_id,requirement_id,hit_number,due_start_at,due_end_at,status) select '${id(111)}','${id(101)}','${stopB}','${requirementB}',1,starts_at,ends_at,'scheduled' from public.shifts where id='${id(51)}';` : ''}`)
}
const protectedSnapshot = () => sql(`select jsonb_build_object(
  'routes',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_routes x),
  'routeVersions',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_route_versions x),
  'stops',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_route_stops x),
  'requirements',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_stop_requirements x),
  'sourceShifts',(select jsonb_agg(to_jsonb(x) order by id) from public.shifts x where schedule_id='${sourceSchedule}'),
  'sourceAssignments',(select jsonb_agg(to_jsonb(x) order by id) from public.shift_assignments x where shift_id in(select id from public.shifts where schedule_id='${sourceSchedule}')),
  'patrol',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_assignments x),
  'obligations',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_hit_obligations x),
  'hits',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_hits x),
  'evidence',(select jsonb_agg(to_jsonb(x) order by id) from public.patrol_hit_evidence x),
  'reports',(select jsonb_agg(to_jsonb(x) order by id) from public.sygilant_reports x),
  'versions',(select jsonb_agg(to_jsonb(x) order by id) from public.sygilant_report_versions x),
  'reportEvidence',(select jsonb_agg(to_jsonb(x) order by id) from public.sygilant_report_evidence x),
  'time',(select jsonb_agg(to_jsonb(x) order by id) from public.time_events x),
  'payroll',(select jsonb_agg(to_jsonb(x) order by id) from private.payroll_rows x))`)
const materialize = () => sql(context() + `select private.materialize_schedule_draft_revision((select week_starts_on from public.schedules where id='${sourceSchedule}'));`)
const newShiftFor = (draft, source = sourceShift) => sql(`select draft_shift_id from private.schedule_shift_revision_links where draft_schedule_id='${draft}' and source_shift_id='${source}';`)
const publish = (draft) => sql(context() + `select public.publish_schedule_draft('${draft}');`)
const bindings = (employee, shifts) => JSON.parse(sql(`set request.jwt.claim.role='service_role'; select public.service_get_patrol_reporting_bindings_v1('${employee}',array[${shifts.map((shift) => `'${shift}'::uuid`).join(',')}]::uuid[]);`))
const authorized = (shift, employee = guard, assignment = patrolA) => sql(`select private.patrol_assignment_shift_is_authorized_v1('${assignment}','${shift}','${employee}')`)
const retained = (shift, employee = guard, assignment = patrolA) => sql(`select private.patrol_retained_shift_is_authorized_v1('${assignment}','${shift}','${employee}')`)
const hitExpression = (hitId = null, key = id(121)) => `public.save_patrol_hit(${hitId ? `'${hitId}'::uuid` : 'null'},'${patrolA}','${stopA}','${obligationA}',null,'required','secure','Preserved original patrol evidence',null,'not_configured',null,null,null,null,'${key}',false)`
const resolutionExpression = (issue, employee = guard, reason = 'Verified current schedule change') => `public.reconcile_patrol_schedule_connection_v1('${issue}',${employee ? `'${employee}'::uuid` : 'null'},'${reason}')`
const reconcile = (issue, employee = guard, reason) => JSON.parse(sql(context() + `select ${resolutionExpression(issue, employee, reason)};`))
const unusedIssue = ({ removed = false } = {}) => {
  seed({ recorded: false })
  const draft = materialize(), copied = newShiftFor(draft)
  sql(removed ? `update public.shifts set canceled_at=now() where id='${copied}';` : `update public.shifts set starts_at=starts_at+interval '15 minutes' where id='${copied}';`)
  publish(draft)
  const issue = sql(`select id from private.patrol_schedule_continuity where target_schedule_id='${draft}' and assignment_id='${patrolA}'`)
  assert(issue, 'The synthetic changed publication must create a review issue')
  return { draft, copied, issue }
}
const nonWorkSnapshot = () => {
  const snapshot = JSON.parse(protectedSnapshot())
  delete snapshot.patrol
  delete snapshot.obligations
  return snapshot
}
const concurrentlyRun = (statement) => new Promise((yes, no) => {
  const child = spawn(join(bin, 'psql' + extension), connection, { env: environment, windowsHide: true, stdio: 'pipe' })
  let output = '', error = ''
  child.stdout.on('data', (chunk) => { output += chunk }); child.stderr.on('data', (chunk) => { error += chunk })
  const timer = setTimeout(() => child.kill(), 15_000)
  child.once('error', no); child.once('close', (code) => { clearTimeout(timer); code === 0 ? yes(output.trim()) : no(new Error(error)) })
  child.stdin.end(context() + statement)
})
const holdTransaction = async (statement) => {
  const child = spawn(join(bin, 'psql' + extension), connection, { env: environment, windowsHide: true, stdio: 'pipe' })
  let output = '', error = ''
  const ready = new Promise((yes, no) => {
    const timeout = setTimeout(() => { child.kill(); no(new Error('The isolated lock holder did not become ready.')) }, 10_000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('ISOLATED_LOCK_READY')) { clearTimeout(timeout); yes() }
    })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.once('error', (failure) => { clearTimeout(timeout); no(failure) })
    child.once('close', (code) => { if (!output.includes('ISOLATED_LOCK_READY')) { clearTimeout(timeout); no(new Error(error || `Lock holder exited ${code}`)) } })
  })
  child.stdin.write(`begin; ${statement}; select 'ISOLATED_LOCK_READY';\n`)
  await ready
  return () => new Promise((yes, no) => {
    const timeout = setTimeout(() => { child.kill(); no(new Error('The isolated lock holder did not exit.')) }, 10_000)
    child.once('close', (code) => { clearTimeout(timeout); code === 0 ? yes() : no(new Error(error || `Lock holder exited ${code}`)) })
    child.stdin.end('rollback;\n')
  })
}
const migrationBody = (source) => {
  assert.equal((source.match(/^begin;$/gmu) ?? []).length, 1, 'Expected one outer migration BEGIN')
  assert.equal((source.match(/^commit;$/gmu) ?? []).length, 1, 'Expected one outer migration COMMIT')
  const body = source.replace(/^begin;$/mu, '').replace(/^commit;$/mu, '')
  assert.equal((body.match(/^commit;$/gmu) ?? []).length, 0, 'Rollback rehearsal cannot commit')
  return body
}
let started = false, priorError
try {
  run('initdb', ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  startIsolatedPostgres({ data, directory, port, run, utc: true }); started = true
  sql(setup)
  sql(read('supabase/migrations/20261117182334_patrol_route_builder_integrity.sql'))
  const foundation = read('supabase/migrations/20261118133316_patrol_schedule_continuity.sql')
  const activation = read('supabase/migrations/20261118134218_activate_patrol_schedule_continuity.sql')
  const predecessor = sql("select md5(pg_get_functiondef('public.get_patrol_workspace()'::regprocedure))")
  sql(`begin;\n${migrationBody(foundation)}\n${migrationBody(activation)}\nrollback;`)
  check(sql("select to_regclass('private.patrol_schedule_continuity') is null"), 't', 'Combined migration rehearsal leaves no continuity table')
  check(sql("select md5(pg_get_functiondef('public.get_patrol_workspace()'::regprocedure))"), predecessor, 'Combined rehearsal restores the exact predecessor function')
  if (arguments_.length) {
    sql("create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]); insert into supabase_migrations.schema_migrations values('20000101000000','synthetic_prior',array['select 1']);")
    const manifest = JSON.parse(read('docs/reliability/patrol-continuity-release-2026-11-18.json'))
    const ledger = () => sql("select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]')) from supabase_migrations.schema_migrations m")
    const render = (filename, mode) => renderPatrolContinuityRelease({ file: resolve('supabase/migrations', filename), hubRoot: arguments_[1], manifest, mode, ledgerMd5: ledger() })
    const rehearsal = await render('20261118133316_patrol_schedule_continuity.sql', 'rehearsal')
    const rehearsalProof = JSON.parse(sql(rehearsal.sql))
    check(rehearsalProof.preservationPassed, true, 'Actual rendered foundation preservation proof passes in PostgreSQL')
    check(rehearsalProof.ledgerRows.length, 2, 'Foundation rehearsal records exactly one temporary ledger entry')
    check(sql("select to_regclass('private.patrol_schedule_continuity') is null"), 't', 'Rendered foundation rehearsal rolls back its schema')
    const activateFoundation = await render('20261118133316_patrol_schedule_continuity.sql', 'activate')
    check(JSON.parse(sql(activateFoundation.sql)).preservationPassed, true, 'Rendered foundation activation succeeds only in the isolated fixture')
    const activationRehearsal = await render('20261118134218_activate_patrol_schedule_continuity.sql', 'rehearsal')
    const activationProof = JSON.parse(sql(activationRehearsal.sql))
    check(activationProof.preservationPassed, true, 'Actual rendered activation preservation proof passes in PostgreSQL')
    check(activationProof.ledgerRows.length, 3, 'Activation rehearsal records its one temporary ledger entry')
    check(sql("select count(*) from pg_trigger where tgname='schedules_reconcile_patrol_continuity'"), '0', 'Rendered activation rehearsal rolls back its publication trigger')
  } else sql(foundation)
  check(sql("select count(*) from pg_trigger where tgname='schedules_reconcile_patrol_continuity'"), '0', 'Foundation alone does not activate publication behavior')
  sql(activation)
  check(sql("select to_regclass('private.patrol_schedule_continuity') is not null"), 't', 'The continuity ledger installs')
  for (const role of ['anon', 'authenticated', 'service_role']) {
    check(sql(`select has_table_privilege('${role}','private.patrol_schedule_continuity','select,insert,update,delete')`), 'f', 'Continuity ledger remains private')
  }
  check(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='private.patrol_schedule_continuity'::regclass"), 't', 'Continuity ledger uses forced RLS')
  for (const role of ['anon', 'authenticated']) {
    check(sql(`select has_function_privilege('${role}','public.service_get_patrol_reporting_bindings_v1(uuid,uuid[])','execute')`), 'f', 'Only the service boundary may read reporting bindings')
  }
  for (const signature of ['private.patrol_assignment_shift_is_authorized_v1(uuid,uuid,uuid)', 'private.patrol_effective_shift_id_v1(uuid)', 'private.patrol_predecessor_shift_ids_v1(uuid,uuid)', 'private.patrol_retained_shift_is_authorized_v1(uuid,uuid,uuid)']) {
    check(sql(`select has_function_privilege('service_role','${signature}','execute')`), 't', 'Shared SQL consumers retain the explicit service-only helper grant')
    for (const role of ['anon', 'authenticated']) check(sql(`select has_function_privilege('${role}','${signature}','execute')`), 'f', 'Clients cannot call private shared authorizers')
  }
  for (const role of ['anon', 'authenticated', 'service_role']) check(sql(`select has_function_privilege('${role}','private.patrol_assignment_needs_schedule_review_v1(uuid)','execute')`), 'f', 'Internal write-review guard is not exposed to callers')
  for (const role of ['anon', 'authenticated', 'service_role']) check(sql(`select has_table_privilege('${role}','private.patrol_schedule_resolution_receipts','select,insert,update,delete')`), 'f', 'Resolution receipts remain private')
  rejected(`perform public.service_get_patrol_reporting_bindings_v1('${guard}',array[]::uuid[]);`, '42501')
  rejected(`perform set_config('request.jwt.claim.role','service_role',true); perform public.service_get_patrol_reporting_bindings_v1(null,array[]::uuid[]);`, '22023')
  rejected(`perform set_config('request.jwt.claim.role','service_role',true); perform public.service_get_patrol_reporting_bindings_v1('${guard}',array_fill('${sourceShift}'::uuid,array[2001]));`, '22023')

  for (const state of [{}, { started: true }, { completed: true }]) {
    seed(state)
    const preserved = protectedSnapshot()
    const draft = materialize(), copied = newShiftFor(draft)
    check(Boolean(copied), true, 'Canonical materialization records exact lineage')
    check(sql('select count(*) from private.patrol_schedule_continuity'), '0', 'Drafting does not grant route access')
    check(authorized(copied), 'f', 'Unpublished draft is not authorized for patrol reports')
    publish(draft)
    check(sql(`select count(*) from private.patrol_schedule_continuity where assignment_id='${patrolA}' and target_shift_id='${copied}' and status='linked'`), '1', 'Unchanged publication creates one explicit alias')
    check(authorized(copied), 't', 'Published unchanged shift is authorized')
    check(authorized(id(999)), 'f', 'A valid alias never authorizes a different or nonexistent requested shift')
    check(authorized(copied, otherGuard), 'f', 'Another employee cannot use the alias')
    check(protectedSnapshot(), preserved, 'Publication preserves source work, punches, payroll, reports, and evidence')
    const rows = bindings(guard, [copied])
    check(rows.length, 1, 'One canonical assignment is returned')
    check(rows[0].id, patrolA, 'Same-week work keeps the original assignment')
    check(rows[0].shift_id, copied, 'Binding names the requested published shift')
    check(rows[0].route_version_id, versionA, 'Route version remains pinned')
    check(rows[0].continuity_status, 'linked', 'Reader describes the alias accurately')
    check(bindings(otherGuard, [copied]).length, 0, 'Reader excludes unrelated employee')
    rejected(context() + `perform public.publish_schedule_draft('${draft}');`, '23514')
    check(sql('select count(*) from private.patrol_schedule_continuity'), '1', 'Repeated publication creates no second alias')
    rejected(`update private.patrol_schedule_continuity set reason='altered';`, '42501')
    rejected(`delete from private.patrol_schedule_continuity;`, '42501')
    const secondDraft = materialize(), secondCopy = newShiftFor(secondDraft, copied)
    publish(secondDraft)
    check(authorized(secondCopy), 't', 'A second revision preserves the original canonical assignment')
    check(bindings(guard, [secondCopy])[0].id, patrolA, 'A chain of aliases never duplicates work')
    const chainRows = bindings(guard, [copied, secondCopy])
    check(chainRows.length, 2, 'Both middle and current revisions retain explicit report bindings')
    check(chainRows.every((row) => row.id === patrolA && row.current_shift_id === secondCopy && row.continuity_status === 'linked'), true, 'Retained middle revision resolves to the same current canonical work')
    check(chainRows.every((row) => row.predecessor_shift_ids.includes(sourceShift) && row.predecessor_shift_ids.includes(copied)), true, 'Binding metadata retains the original and middle predecessor IDs')
    check(authorized(copied), 'f', 'Strict current-work authorization does not relabel the superseded middle shift as current')
    check(retained(copied), 't', 'Retained report authorization accepts proven middle revision lineage')
    check(retained(copied, otherGuard), 'f', 'Retained predecessor access cannot cross employees')
    check(retained(id(999)), 'f', 'Retained predecessor access does not admit unknown shifts')
    check(protectedSnapshot(), preserved, 'Successive revisions preserve historical records')
  }

  seed({ recorded: false })
  const savedDraftRevision = materialize(), savedDraftShift = newShiftFor(savedDraftRevision)
  publish(savedDraftRevision)
  sql(`insert into public.sygilant_reports(id,employee_id,shift_id,client_id,site_id,status,content) values('${id(150)}','${guard}','${savedDraftShift}','${clientA}','${siteA}','draft','{"savedMiddleRevision":true}');`)
  const savedMiddleSnapshot = protectedSnapshot(), laterDraft = materialize(), laterShift = newShiftFor(laterDraft, savedDraftShift)
  publish(laterDraft)
  check(retained(savedDraftShift), 't', 'Saved report on the middle revision remains authorized after another publication')
  check(bindings(guard, [savedDraftShift])[0].current_shift_id, laterShift, 'Middle-revision saved draft resolves the current shift without editing its stored identity')
  check(sql(`select shift_id from public.sygilant_reports where id='${id(150)}'`), savedDraftShift, 'Stored draft keeps its original middle-revision shift ID')
  check(protectedSnapshot(), savedMiddleSnapshot, 'Publishing a third revision does not rewrite a middle-revision saved draft')
  sql(`update public.shifts set post_id='${postB}' where id='${savedDraftShift}';`)
  check(retained(savedDraftShift), 'f', 'A changed predecessor cannot qualify as the same retained occurrence')
  check(bindings(guard, [savedDraftShift]).length, 0, 'A changed superseded predecessor is excluded from report bindings')

  for (const review of [false, true]) {
    seed({ recorded: false })
    const draft = materialize(), copied = newShiftFor(draft)
    if (review) sql(`update public.shifts set starts_at=starts_at+interval '5 minutes' where id='${copied}';`)
    publish(draft)
    sql(`insert into public.patrol_assignments(id,route_id,route_version_id,shift_id,employee_id,service_date,status,assigned_by) select '${id(101)}','${routeB}','${versionB}',id,'${guard}',(starts_at at time zone 'America/Denver')::date,'active','${actor}' from public.shifts where id='${copied}';`)
    const routes = bindings(guard, [copied])
    check(routes.some((row) => row.id === id(101) && row.continuity_status === 'direct'), true, 'An explicit additional route remains available')
    check(routes.some((row) => row.id === patrolA && row.continuity_status === 'linked'), !review, 'Valid retained routes coexist with additional explicit routes; unresolved review rows do not masquerade as authorization')
    check(routes.length, review ? 1 : 2, 'Multiple legitimate route bindings are preserved without duplicating a review placeholder')
  }

  const alterations = [
    ['start time', (copied) => `update public.shifts set starts_at=starts_at+interval '5 minutes' where id='${copied}';`],
    ['end time', (copied) => `update public.shifts set ends_at=ends_at+interval '5 minutes' where id='${copied}';`],
    ['time zone', (copied) => `update public.shifts set time_zone='America/Chicago' where id='${copied}';`],
    ['property', (copied) => `update public.shifts set post_id='${postB}' where id='${copied}';`],
    ['armed requirement', (copied) => `update public.shifts set requires_armed=true where id='${copied}';`],
    ['replacement employee', (copied) => `update public.shift_assignments set employee_id='${otherGuard}' where shift_id='${copied}';`],
    ['removed employee', (copied) => `delete from public.shift_assignments where shift_id='${copied}';`],
    ['canceled employee', (copied) => `update public.shift_assignments set status='canceled',canceled_at=now() where shift_id='${copied}';`],
    ['canceled shift', (copied) => `update public.shifts set canceled_at=now() where id='${copied}';`],
  ]
  for (const [label, alter] of alterations) {
    seed()
    const preserved = protectedSnapshot(), draft = materialize(), copied = newShiftFor(draft)
    sql(alter(copied))
    publish(draft)
    check(sql(`select status from public.schedules where id='${draft}'`), 'published', `${label}: normal schedule publication succeeds`)
    check(authorized(copied), 'f', `${label}: old route work is not silently authorized`) 
    check(authorized(copied, otherGuard), 'f', `${label}: replacement employee does not inherit another employee's work`)
    check(sql(`select count(*) from private.patrol_schedule_continuity where assignment_id='${patrolA}' and target_schedule_id='${draft}' and status='review_required'`), '1', `${label}: explicit reconciliation result is retained`)
    check(bindings(guard, [copied]).some((row) => row.continuity_status === 'linked'), false, `${label}: reader never labels the change as connected`)
    check(protectedSnapshot(), preserved, `${label}: source evidence is not rewritten`)
  }

  seed({ secondClient: true })
  const clientPreserved = protectedSnapshot(), clientDraft = materialize(), copyA = newShiftFor(clientDraft), copyB = newShiftFor(clientDraft, id(51))
  publish(clientDraft)
  check(bindings(guard, [copyA, copyB]).map((row) => row.id), [patrolA], 'Client A guard receives no Client B assignment')
  check(bindings(otherGuard, [copyA, copyB]).map((row) => row.id), [id(101)], 'Client B guard receives only their own route')
  check(authorized(copyB, guard, id(101)), 'f', 'Cross-client alias cannot be used by another guard')
  check(authorized(copyB, guard, patrolA), 'f', 'A valid own assignment never authorizes another existing client shift')
  check(protectedSnapshot(), clientPreserved, 'Multiple clients remain isolated without report changes')

  for (const changed of [false, true]) {
    seed({ secondClient: true })
    const preserved = protectedSnapshot(), draft = materialize(), copied = newShiftFor(draft)
    if (changed) sql(`update public.shifts set starts_at=starts_at+interval '15 minutes' where id='${copied}';`)
    sql(context() + `select public.publish_employee_schedule_slice('${draft}','${guard}');`)
    const published = sql("select id from public.schedules where status='published'")
    const selectedShift = sql(`select s.id from public.shifts s join public.shift_assignments a on a.shift_id=s.id and a.employee_id='${guard}' and a.status<>'canceled' where s.schedule_id='${published}' and s.canceled_at is null`)
    const unselectedShift = sql(`select s.id from public.shifts s join public.shift_assignments a on a.shift_id=s.id and a.employee_id='${otherGuard}' and a.status<>'canceled' where s.schedule_id='${published}' and s.canceled_at is null`)
    check(Boolean(selectedShift), true, 'Employee-scoped publication retains the selected employee')
    check(authorized(unselectedShift, otherGuard, id(101)), 't', 'Employee-scoped publication preserves the unselected employee\'s route')
    check(authorized(selectedShift), changed ? 'f' : 't', 'Employee-scoped publication uses exact chained lineage and current times')
    check(bindings(guard, [selectedShift]).some((row) => row.id === patrolA && row.continuity_status === (changed ? 'review_required' : 'linked')), true, 'Employee-scoped route result is explicit')
    check(protectedSnapshot(), preserved, 'Employee-scoped publication preserves source work and client evidence')
  }

  seed()
  const untracedSchedule = id(49), untracedShift = id(59)
  sql(`insert into public.schedules(id,week_starts_on,revision,status,previous_revision_id,created_by) select '${untracedSchedule}',week_starts_on,2,'draft',id,'${actor}' from public.schedules where id='${sourceSchedule}';
    insert into public.shifts(id,schedule_id,post_id,starts_at,ends_at,time_zone,created_by) select '${untracedShift}','${untracedSchedule}',post_id,starts_at,ends_at,time_zone,created_by from public.shifts where id='${sourceShift}';
    insert into public.shift_assignments(shift_id,employee_id,status,assigned_by) values('${untracedShift}','${guard}','assigned','${actor}');`)
  publish(untracedSchedule)
  check(authorized(untracedShift), 'f', 'Identical times and property without explicit lineage never grant route scope')
  check(sql(`select count(*) from private.patrol_schedule_continuity where assignment_id='${patrolA}' and status='review_required'`), '1', 'Untraced copy becomes a visible reconciliation issue')

  seed()
  const revokedDraft = materialize(), revokedCopy = newShiftFor(revokedDraft)
  publish(revokedDraft)
  check(authorized(revokedCopy), 't', 'Linked employee initially has route scope')
  sql(`update public.shift_assignments set canceled_at=now(),status='canceled' where shift_id='${revokedCopy}' and employee_id='${guard}';`)
  check(authorized(revokedCopy), 'f', 'A stale alias cannot keep access after the employee assignment is canceled')
  check(bindings(guard, [revokedCopy]).length, 0, 'Fresh read removes canceled employee scope')

  seed()
  const pinnedDraft = materialize(), pinnedCopy = newShiftFor(pinnedDraft)
  publish(pinnedDraft)
  check(sql(context() + `select public.link_patrol_route_shift('${routeA}','${pinnedCopy}','${guard}');`), patrolA, 'Linking an existing valid alias returns its original work without duplicating obligations')
  sql(`insert into public.patrol_route_versions(id,route_id,version_number,change_reason,created_by) values('${id(72)}','${routeA}',2,'Future route version','${actor}'); update public.patrol_routes set current_version_id='${id(72)}' where id='${routeA}';`)
  rejected(context() + `perform public.link_patrol_route_shift('${routeA}','${pinnedCopy}','${guard}');`, 'PT409')
  check(bindings(guard, [pinnedCopy])[0].route_version_id, versionA, 'A newer route version does not silently replace retained work')
  check(sql('select count(*) from public.patrol_hit_obligations'), '1', 'Reviewing a newer route version does not duplicate obligations')

  seed({ recorded: false })
  const noSessionDraft = materialize(), noSessionCopy = newShiftFor(noSessionDraft)
  sql(`set fixture.actor=''; update public.schedules set status='superseded' where id='${sourceSchedule}'; update public.schedules set status='published',published_at=now(),published_by='${actor}' where id='${noSessionDraft}';`)
  check(authorized(noSessionCopy), 't', 'A trusted publisher with a recorded actor can preserve patrol work without browser session settings')
  seed({ recorded: false })
  sql('truncate public.patrol_routes cascade;')
  const staticDraft = materialize()
  sql(`set fixture.actor=''; update public.schedules set status='superseded' where id='${sourceSchedule}'; update public.schedules set status='published',published_at=now() where id='${staticDraft}';`)
  check(sql('select count(*) from private.patrol_schedule_continuity'), '0', 'An unrelated static publication does not require a patrol actor or create route links')

  seed({ recorded: false })
  sql(`insert into public.patrol_route_versions(id,route_id,version_number,change_reason,created_by) values('${id(72)}','${routeA}',2,'Second retained route version','${actor}');
    insert into public.patrol_assignments(id,route_id,route_version_id,shift_id,employee_id,service_date,status,assigned_by) select '${id(101)}','${routeA}','${id(72)}',shift_id,employee_id,service_date,'active',assigned_by from public.patrol_assignments where id='${patrolA}';`)
  const ambiguousDraft = materialize(), ambiguousCopy = newShiftFor(ambiguousDraft)
  publish(ambiguousDraft)
  check(sql(`select count(*) from private.patrol_schedule_continuity where target_shift_id='${ambiguousCopy}' and status='review_required'`), '2', 'Multiple retained versions of the same route require review instead of unioning access')
  check(authorized(ambiguousCopy), 'f', 'Ambiguous retained route roots do not authorize the copied shift')

  seed({ recorded: false })
  const reviewDraft = materialize(), reviewCopy = newShiftFor(reviewDraft)
  sql(`update public.shifts set starts_at=starts_at+interval '5 minutes' where id='${reviewCopy}';`)
  publish(reviewDraft)
  const laterReviewDraft = materialize(), laterReviewCopy = newShiftFor(laterReviewDraft, reviewCopy)
  publish(laterReviewDraft)
  check(authorized(laterReviewCopy), 'f', 'A further unchanged publication does not silently clear an unresolved earlier change')
  check(sql(`select reason from private.patrol_schedule_continuity where target_schedule_id='${laterReviewDraft}'`), 'prior_review', 'Unresolved review remains explicit across further revisions')

  seed({ recorded: false })
  sql(`insert into public.schedules(id,week_starts_on,revision,status,previous_revision_id,created_by) select '${untracedSchedule}',week_starts_on,2,'draft',id,'${actor}' from public.schedules where id='${sourceSchedule}';`)
  publish(untracedSchedule)
  check(sql(`select count(*) from private.patrol_schedule_continuity where target_schedule_id='${untracedSchedule}' and target_shift_id is null and status='review_required'`), '1', 'A missing exact target remains an explicit review item')
  const laterEmptyDraft = materialize()
  publish(laterEmptyDraft)
  check(sql(`select count(*) from private.patrol_schedule_continuity where target_schedule_id='${laterEmptyDraft}' and target_shift_id is null and status='review_required'`), '1', 'A later publication cannot discard an unresolved missing-target issue')
  check(sql(context() + 'select jsonb_array_length(private.patrol_schedule_continuity_issues_v1());'), '1', 'Operations still sees the missing-target issue on the current revision')

  seed()
  const blockedDraft = materialize(), blockedCopy = newShiftFor(blockedDraft)
  sql(`update public.shifts set starts_at=starts_at+interval '15 minutes' where id='${blockedCopy}';`)
  publish(blockedDraft)
  const savedBefore = protectedSnapshot()
  check(sql(context(guard) + `select ${hitExpression()};`), hitA, 'An exact accepted hit-save retry survives a later schedule review state')
  check(protectedSnapshot(), savedBefore, 'Accepted retry does not mutate the retained hit')
  rejected(context(guard) + `perform ${hitExpression(null, id(222))};`, 'PT409')
  rejected(context(otherGuard) + `perform ${hitExpression()};`, '42501')
  check(sql(context(guard) + `select ${hitExpression(hitA)};`), hitA, 'Existing hit drafts remain editable through the unchanged canonical save path')
  check(sql('select count(*) from public.patrol_hits'), '1', 'Review state and retries never duplicate hits')

  seed({ recorded: false })
  const workingDraft = materialize(), workingCopy = newShiftFor(workingDraft)
  publish(workingDraft)
  const firstHit = sql(context(guard) + `select ${hitExpression(null, id(222))};`)
  check(Boolean(firstHit), true, 'Valid same-week continuation allows a new patrol hit')
  check(sql(context(guard) + `select ${hitExpression(null, id(222))};`), firstHit, 'Valid continuation preserves existing hit retry behavior')
  check(sql(`select assignment_id from public.patrol_hits where id='${firstHit}'`), patrolA, 'New continuation evidence remains attached to canonical patrol work')

  seed()
  const rollbackBefore = sql('select jsonb_build_object(\'schedules\',(select count(*) from public.schedules),\'shifts\',(select count(*) from public.shifts),\'ledger\',(select count(*) from private.patrol_schedule_continuity))')
  sql(context() + `begin; select public.ensure_schedule_draft((select week_starts_on from public.schedules where id='${sourceSchedule}')); select public.publish_schedule_draft((select id from public.schedules where status='draft')); rollback;`)
  check(sql('select jsonb_build_object(\'schedules\',(select count(*) from public.schedules),\'shifts\',(select count(*) from public.shifts),\'ledger\',(select count(*) from private.patrol_schedule_continuity))'), rollbackBefore, 'Rollback restores schedules, shifts, and aliases together')

  seed()
  const futureBefore = protectedSnapshot()
  const futureWeek = sql(`select (week_starts_on+7)::text from public.schedules where id='${sourceSchedule}'`)
  sql(context() + `select public.replace_schedule_week_draft_from_revision('${sourceSchedule}','${futureWeek}',true,false);`)
  const futureDraft = sql(`select id from public.schedules where week_starts_on='${futureWeek}' and status='draft'`)
  publish(futureDraft)
  const futureShifts = sql(`select id from public.shifts where schedule_id='${futureDraft}' and canceled_at is null`).split('\n').filter(Boolean)
  check(futureShifts.length, 1, 'Actual week copy creates the expected future shift')
  check(bindings(guard, futureShifts).length, 0, 'A future week never inherits last week\'s patrol obligations')
  check(sql('select count(*) from private.patrol_schedule_continuity'), '0', 'Future-week copy is not treated as a same-work alias')
  check(protectedSnapshot(), futureBefore, 'Actual week copy preserves original reports, payroll, and patrol work')

  seed()
  const concurrentDraft = materialize(), concurrentCopy = newShiftFor(concurrentDraft)
  const concurrent = await Promise.allSettled([concurrentlyRun(`select public.publish_schedule_draft('${concurrentDraft}');`), concurrentlyRun(`select public.publish_schedule_draft('${concurrentDraft}');`)])
  check(concurrent.filter((result) => result.status === 'fulfilled').length, 1, 'Only one concurrent publication succeeds')
  check(concurrent.filter((result) => result.status === 'rejected' && result.reason.message.includes('Only an open schedule draft')).length, 1, 'The repeated publisher receives a clear rejection')
  check(sql(`select count(*) from private.patrol_schedule_continuity where target_shift_id='${concurrentCopy}' and status='linked'`), '1', 'Concurrent publication cannot duplicate the alias')
  check(sql('select count(*) from public.patrol_hit_obligations'), '1', 'Concurrent publication cannot duplicate patrol work')

  // Deliberate reconciliation is allowed only for future work with no record of use.
  const repair = unusedIssue(), nonWorkBefore = nonWorkSnapshot()
  rejected(context(guard) + `perform ${resolutionExpression(repair.issue)};`, '42501')
  rejected(context(actor, false) + `perform ${resolutionExpression(repair.issue)};`, '42501')
  rejected(context() + `perform ${resolutionExpression(repair.issue, guard, 'short')};`, '22023')
  rejected(context() + `perform ${resolutionExpression(repair.issue, otherGuard)};`, '22023')
  const repaired = reconcile(repair.issue)
  check(repaired.status, 'reconnected', 'Reviewed unused future work can be reconnected')
  check(typeof repaired.assignmentId === 'string' && repaired.assignmentId !== patrolA, true, 'A new occurrence receives new work identity')
  check(sql(`select status from public.patrol_assignments where id='${patrolA}'`), 'canceled', 'Only unused original work is retired')
  check(sql(`select status from public.patrol_hit_obligations where id='${obligationA}'`), 'waived', 'Unused original obligations are explicitly waived')
  check(sql(`select count(*) from public.patrol_hit_obligations where assignment_id='${repaired.assignmentId}'`), '1', 'New work receives exactly its route requirement')
  check(authorized(repair.copied, guard, repaired.assignmentId), 't', 'Reconnected current work is authorized')
  check(authorized(repair.copied), 'f', 'Retired work is no longer authorized')
  check(reconcile(repair.issue), repaired, 'Exact reconciliation retry returns its retained receipt')
  rejected(context() + `perform ${resolutionExpression(repair.issue, guard, 'Different reviewed change')};`, 'PT409')
  check(sql('select count(*) from private.patrol_schedule_resolution_receipts'), '1', 'Reconciliation creates one receipt')
  rejected("update private.patrol_schedule_resolution_receipts set reason='different';", '42501')
  rejected('delete from private.patrol_schedule_resolution_receipts;', '42501')
  check(nonWorkSnapshot(), nonWorkBefore, 'Reconciliation preserves source shifts, employee assignments, route definitions, payroll, reports and evidence')

  const closed = unusedIssue({ removed: true })
  rejected(context() + `perform ${resolutionExpression(closed.issue)};`, '22023')
  check(reconcile(closed.issue, null), { assignmentId: null, status: 'closed' }, 'Removed future shift can close unused work without inventing a replacement')
  check(sql('select count(*) from public.patrol_assignments'), '1', 'Closing removed work creates no assignment')

  const protectionCases = [
    ['patrol draft', `insert into public.patrol_hits(id,assignment_id,stop_id,obligation_id,classification,status,submitted_by,idempotency_key) values('${hitA}','${patrolA}','${stopA}','${obligationA}','required','draft','${guard}','${id(121)}');`],
    ['source time entry', `insert into public.time_events values('${id(140)}','${guard}','${sourceShift}',now());`],
    ['approved report', `insert into public.sygilant_reports(id,employee_id,shift_id,status) values('${id(130)}','${guard}','${sourceShift}','approved');`],
    ['report linked by employee assignment', `insert into public.sygilant_reports(id,employee_id,assignment_id,status) select '${id(130)}','${guard}',id,'draft' from public.shift_assignments where shift_id='${sourceShift}';`],
    ['started obligation', `update public.patrol_hit_obligations set due_start_at=now()-interval '1 minute' where id='${obligationA}';`],
    ['makeup history', `insert into public.patrol_makeup_assignments(obligation_id,assigned_patrol_assignment_id,assigned_to,reason,assigned_by) values('${obligationA}','${patrolA}','${guard}','Synthetic makeup history','${actor}');`],
  ]
  for (const [label, record] of protectionCases) {
    const target = unusedIssue()
    sql(record)
    const before = protectedSnapshot()
    rejected(context() + `perform ${resolutionExpression(target.issue)};`, 'PT409')
    check(protectedSnapshot(), before, `${label}: reconciliation refuses to rewrite recorded work`)
    check(sql('select count(*) from private.patrol_schedule_resolution_receipts'), '0', `${label}: refusal leaves no receipt`)
  }

  for (const state of [{ started: true, recorded: false }, { completed: true }]) {
    seed(state)
    const draft = materialize(), copied = newShiftFor(draft)
    sql(`update public.shifts set ends_at=ends_at+interval '5 minutes' where id='${copied}';`)
    publish(draft)
    const issue = sql(`select id from private.patrol_schedule_continuity where target_schedule_id='${draft}'`)
    const before = protectedSnapshot()
    rejected(context() + `perform ${resolutionExpression(issue)};`, 'PT409')
    check(protectedSnapshot(), before, 'Started or completed patrol work requires separate review and is preserved')
  }

  const simultaneous = unusedIssue()
  const resolutions = await Promise.all([concurrentlyRun(`select ${resolutionExpression(simultaneous.issue)};`), concurrentlyRun(`select ${resolutionExpression(simultaneous.issue)};`)])
  check(JSON.parse(resolutions[0]), JSON.parse(resolutions[1]), 'Concurrent exact reconciliation requests return the same result')
  check(sql('select count(*) from private.patrol_schedule_resolution_receipts'), '1', 'Concurrent reconciliation creates one immutable receipt')
  check(sql('select count(*) from public.patrol_assignments'), '2', 'Concurrent reconciliation creates only one replacement assignment')

  for (const reference of ['source_report', 'target_punch', 'assignment_report']) {
    const busy = unusedIssue()
    const sourceAssignment = sql(`select id from public.shift_assignments where shift_id='${sourceShift}'`)
    const statement = reference === 'source_report'
      ? `insert into public.sygilant_reports(id,employee_id,shift_id,status) values('${id(133)}','${guard}','${sourceShift}','draft')`
      : reference === 'target_punch'
        ? `insert into public.time_events values('${id(142)}','${guard}','${busy.copied}',now())`
        : `insert into public.sygilant_reports(id,employee_id,assignment_id,status) values('${id(133)}','${guard}','${sourceAssignment}','draft')`
    const before = protectedSnapshot()
    const release = await holdTransaction(statement)
    try {
      rejected(context() + `perform ${resolutionExpression(busy.issue)};`, 'PT409')
      check(sql('select count(*) from private.patrol_schedule_resolution_receipts'), '0', `${reference}: concurrent evidence cannot be retired by reconciliation`)
    } finally { await release() }
    check(protectedSnapshot(), before, `${reference}: busy failure and lock-holder rollback preserve all records`)
  }

  seed()
  sql("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations(version text primary key,name text,statements text[]); insert into supabase_migrations.schema_migrations values('20000101000000','synthetic_prior',array['select 1']) on conflict do nothing;")
  const ledgerMd5 = sql("select md5(coalesce(jsonb_agg(to_jsonb(m) order by version)::text,'[]')) from supabase_migrations.schema_migrations m")
  const preservationTarget = { version: '20990101000000', changed: [], added: [], relations: [], triggers: [] }
  const guardSql = continuityPreservationSql(preservationTarget, ledgerMd5)
  const verifyPreservation = "do $verify$ begin if (select snapshot from continuity_before) is distinct from pg_temp.continuity_snapshot() then raise exception 'Continuity preservation proof failed'; end if; end $verify$;"
  sql(`${guardSql}\n${verifyPreservation}\nrollback;`)
  checks += 1
  const assertTamperRejected = (mutation, label) => {
    const result = spawnSync(join(bin, 'psql' + extension), connection, { input: `${guardSql}\n${mutation}\n${verifyPreservation}\nrollback;`, encoding: 'utf8', env: environment, windowsHide: true, timeout: 45_000 })
    check(result.status !== 0 && result.stderr.includes('Continuity preservation proof failed'), true, label)
  }
  const baselineEmployee = sql(`select first_name from public.employees where id='${guard}'`)
  assertTamperRejected(`update public.employees set first_name='Unexpected change' where id='${guard}';`, 'Production preservation SQL rejects protected employee mutations')
  check(sql(`select first_name from public.employees where id='${guard}'`), baselineEmployee, 'Rejected preservation transaction rolls back the employee mutation')
  assertTamperRejected('create function public.unreviewed_continuity_function() returns integer language sql as $$select 1$$;', 'Production preservation SQL rejects an unreviewed function')
  check(sql("select to_regprocedure('public.unreviewed_continuity_function()') is null"), 't', 'Rejected unreviewed function leaves no artifact')
  assertTamperRejected('alter table public.employees enable row level security; create policy unreviewed_policy on public.employees to authenticated using (true);', 'Production preservation SQL rejects unreviewed security-policy changes')
  check(sql("select count(*) from pg_policy where polname='unreviewed_policy'"), '0', 'Rejected policy change leaves no artifact')
  assertTamperRejected("update supabase_migrations.schema_migrations set name='changed_prior';", 'Production preservation SQL rejects prior-ledger drift')
  check(sql("select name from supabase_migrations.schema_migrations where version='20000101000000'"), 'synthetic_prior', 'Rejected ledger change rolls back')
  console.log(JSON.stringify({ passed: true, checks, syntheticOnly: true, productionConnections: 0, renderedReleaseRehearsal: arguments_.length > 0,
    foundationSha256: createHash('sha256').update(foundation).digest('hex'),
    activationSha256: createHash('sha256').update(activation).digest('hex'), artifacts: directory }))
} catch (error) { priorError = error; throw error } finally { stopIsolatedPostgres({ data, run, started, priorError }) }
