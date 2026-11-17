import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import net from 'node:net'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

assert.equal(process.versions.node, '24.19.0')
const arguments_ = process.argv.slice(2)
assert(arguments_.length === 0 || (arguments_.length === 2 && arguments_[0] === '--release-rehearsal' && isAbsolute(arguments_[1])), 'Use only --release-rehearsal <absolute Sygilant root>')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const { bin, extension } = isolatedPostgresRuntime({ platform: process.platform, environment, override: process.env.PATROL_TEST_POSTGRES_BIN })
const directory = mkdtempSync(join(tmpdir(), 'sygshift-route-builder-'))
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
const connection = ['-X','--no-password','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-qAt','-f','-']
const sql = (input) => run('psql', connection, { input })
const read = (path) => readFileSync(resolve(path), 'utf8').replaceAll('\r\n','\n')
const enterprise = read('supabase/migrations/20260902110000_enterprise_patrol_operations.sql')
const extract = (text, name) => {
  const match = text.match(new RegExp(`create or replace function ${name.replaceAll('.', '\\.')}\\([^]*?\\n\\$\\$;`, 'iu'))
  assert(match, name); return match[0]
}
const tables = ['patrol_routes','patrol_route_versions','patrol_route_stops','patrol_stop_requirements','patrol_assignments','patrol_hit_obligations','patrol_makeup_assignments','patrol_hits','patrol_hit_evidence'].map((name) => {
  const match=enterprise.match(new RegExp(`create table public\\.${name} \\([^]*?\\n\\);`, 'u'))
  assert(match,name);return match[0]
}).join('\n')
const manager='10000000-0000-4000-8000-000000000001'
const guard='10000000-0000-4000-8000-000000000002'
const assignmentManager='10000000-0000-4000-8000-000000000003'
const site='20000000-0000-4000-8000-000000000001'
const siteOnly='20000000-0000-4000-8000-000000000002'
const otherSite='20000000-0000-4000-8000-000000000003'
const inactiveSite='20000000-0000-4000-8000-000000000004'
const inactiveClientSite='20000000-0000-4000-8000-000000000005'
const noClientSite='20000000-0000-4000-8000-000000000006'
const post='30000000-0000-4000-8000-000000000001'
const otherPost='30000000-0000-4000-8000-000000000002'
const client='40000000-0000-4000-8000-000000000001'
const inactiveClient='40000000-0000-4000-8000-000000000002'
const shift='50000000-0000-4000-8000-000000000001'
const candidateShift='50000000-0000-4000-8000-000000000002'
const context=(actor=manager,mfa=true)=>`set fixture.actor='${actor}';set fixture.mfa='${mfa}';`
const literal=(value)=>`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`
const id=(n)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const route=(key=id(1),changes={})=>({ id:null, expectedVersionId:null,idempotencyKey:key,code:'synthetic-route',name:'Synthetic patrol route',requiresArmed:false,status:'active',timeZone:'America/Denver',effectiveFrom:null,effectiveThrough:null,changeReason:'Verified test route configuration',stops:[{stableKey:id(2),locationLabel:'Synthetic property',siteId:siteOnly,postId:null,addressLine1:'1 Test Street',city:'Test',region:'CO',postalCode:null,latitude:null,longitude:null,geofenceRadiusMeters:null,instructions:null,allowPhotos:true,allowVideos:true,requireEvidence:false,evidenceInstructions:null,standardVideoLimitSeconds:180,incidentVideoLimitSeconds:900,requirements:[{dayOfWeek:1,label:'Monday patrol',requiredHits:2,status:'active',windowStart:null,windowEnd:null,minimumSpacingMinutes:null,sequenceRequired:false}]}],...changes})
const save=(payload)=>`select public.save_patrol_route(${literal(payload)});`
const setup=`create schema private;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
create role anon;create role authenticated;create role service_role;
create table public.employees(id uuid primary key,first_name text,last_name text,status text);
create table private.fixture_accounts(id uuid primary key,manager boolean,active boolean,assignment_only boolean default false);
create function private.current_employee_id() returns uuid language sql stable as $$select id from private.fixture_accounts where id=nullif(current_setting('fixture.actor',true),'')::uuid and active$$;
create function auth.uid() returns uuid language sql stable as $$select private.current_employee_id()$$;
create function public.has_effective_permission(code text) returns boolean language sql stable as $$select coalesce((select case when code='patrol.self.view' then not assignment_only when code='patrol.assignments.manage' then (manager or assignment_only) and current_setting('fixture.mfa',true)='true' else manager and current_setting('fixture.mfa',true)='true' end from private.fixture_accounts where id=private.current_employee_id()),false)$$;
create table public.clients(id uuid primary key,display_name text,status text);
create table public.sites(id uuid primary key,client_id uuid references public.clients(id),name text,code text,active boolean,time_zone text,address_line_1 text,city text,region text,postal_code text);
create table public.posts(id uuid primary key,site_id uuid references public.sites(id),name text,active boolean,requires_armed boolean);
create table public.schedules(id uuid primary key,status text,week_starts_on date,revision integer,published_at timestamptz);
create table public.shifts(id uuid primary key,schedule_id uuid references public.schedules(id),post_id uuid references public.posts(id),starts_at timestamptz,ends_at timestamptz,time_zone text,requires_armed boolean,canceled_at timestamptz);
create table public.shift_assignments(id uuid primary key,shift_id uuid references public.shifts(id),employee_id uuid references public.employees(id),status text,canceled_at timestamptz);
create table private.audit_events(auth_user_id uuid,employee_id uuid,schema_name text,table_name text,operation text,row_id text,new_record jsonb);
create table public.time_events(id uuid primary key);create table private.payroll_rows(id uuid primary key);
${tables}
alter table public.patrol_hit_obligations add column source text not null default 'scheduled',add column recovery_hit_window_id uuid;
create function private.reconcile_patrol_obligations() returns void language plpgsql as $$begin return;end$$;
${extract(read('supabase/migrations/20260902120000_patrol_admin_mfa_boundary.sql'),'private.patrol_can_manage')}
${extract(read('supabase/migrations/20260902214839_patrol_route_update_persistence.sql'),'public.save_patrol_route')}
${extract(read('supabase/migrations/20260929143310_patrol_assignment_variable_ambiguity_repair.sql'),'public.link_patrol_route_shift')}
${extract(enterprise,'public.get_patrol_workspace')}
${read('supabase/migrations/20260928021235_vacancy_patrol_service_recovery.sql').match(/do \$patch_patrol_workspace\$[\s\S]*?\$patch_patrol_workspace\$;/u)[0]}
revoke all on function public.get_patrol_workspace() from public,anon;
revoke all on function public.save_patrol_route(jsonb) from public,anon;
revoke all on function public.link_patrol_route_shift(uuid,uuid,uuid) from public,anon;
grant execute on function public.get_patrol_workspace() to authenticated;
grant execute on function public.save_patrol_route(jsonb) to authenticated;
grant execute on function public.link_patrol_route_shift(uuid,uuid,uuid) to authenticated;
insert into public.employees values('${manager}','Synthetic','Manager','active'),('${guard}','Synthetic','Guard','active'),('${assignmentManager}','Synthetic','Assignment manager','active');
insert into private.fixture_accounts values('${manager}',true,true,false),('${guard}',false,true,false),('${assignmentManager}',false,true,true);
insert into public.clients values('${client}','Active test client','active'),('${inactiveClient}','Inactive test client','paused');
insert into public.sites values
('${site}','${client}','With active post','ONE',true,'America/Denver',null,null,null,null),
('${siteOnly}','${client}','No active post','TWO',true,'America/Denver',null,null,null,null),
('${otherSite}','${client}','Other property','THREE',true,'America/Denver',null,null,null,null),
('${inactiveSite}','${client}','Inactive property','FOUR',false,'America/Denver',null,null,null,null),
('${inactiveClientSite}','${inactiveClient}','Inactive client property','FIVE',true,'America/Denver',null,null,null,null),
('${noClientSite}',null,'Unlinked property','SIX',true,'America/Denver',null,null,null,null);
insert into public.posts values('${post}','${site}','Active post',true,false),('${otherPost}','${otherSite}','Other post',true,false);
insert into public.schedules values('60000000-0000-4000-8000-000000000001','published','2026-11-15',1,'2026-11-13T12:00Z');
insert into public.shifts values('${shift}','60000000-0000-4000-8000-000000000001','${post}',date_trunc('week',now())+interval '15 hours',date_trunc('week',now())+interval '23 hours','America/Denver',false,null);
insert into public.shifts values('${candidateShift}','60000000-0000-4000-8000-000000000001','${post}',now()+interval '1 hour',now()+interval '2 hours','America/Denver',false,null);
insert into public.shift_assignments values('70000000-0000-4000-8000-000000000001','${shift}','${guard}','assigned',null),('70000000-0000-4000-8000-000000000002','${candidateShift}','${guard}','assigned',null);`
let checks=0
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks+=1}
function rejected(statement,state){sql(`do $test$ begin begin ${statement} raise exception 'Expected rejection did not occur';exception when sqlstate '${state}' then null;end;end $test$;`);checks+=1}
let started=false, priorError
try {
  run('initdb',['-D',data,'-U','postgres','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C'])
  startIsolatedPostgres({data,directory,port,run,utc:true});started=true
  sql(setup)
  if (arguments_.length) {
    const { renderPatrolRelease } = await import('./patrol-release-sql.mjs')
    const supplementalTables = ['auth.users','auth.identities','auth.mfa_factors','auth.sessions',
      'public.profiles','public.employee_access_roles','public.role_permissions','public.permission_catalog',
      'private.payroll_export_batches','private.payroll_export_rows','private.payroll_rules','private.payroll_batch_assignments',
      'public.sygilant_reports','public.sygilant_report_versions','public.sygilant_report_evidence',
      'public.sygilant_document_templates','public.sygilant_document_template_versions','public.sygilant_document_template_decisions',
      'public.sygilant_audit_events']
    sql(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
      insert into supabase_migrations.schema_migrations select lpad(value::text,14,'0'),'synthetic_'||value,array['select '||value] from generate_series(1,463) value;
      ${supplementalTables.map(table => `create table ${table}(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now());insert into ${table} default values;`).join('\n')}`)
    const before = sql("select jsonb_build_object('writer',md5(pg_get_functiondef('public.save_patrol_route(jsonb)'::regprocedure)),'ledger',(select md5(jsonb_agg(to_jsonb(m) order by version)::text) from supabase_migrations.schema_migrations m))")
    const ledgerMd5 = sql('select md5(jsonb_agg(to_jsonb(m) order by version)::text) from supabase_migrations.schema_migrations m')
    const rendered = await renderPatrolRelease({ file: resolve('supabase/migrations/20261117182334_patrol_route_builder_integrity.sql'), hubRoot: arguments_[1], mode: 'rehearsal', ledgerMd5 })
    const execution = spawnSync(join(bin,'psql'+extension),connection,{input:rendered.sql,encoding:'utf8',env:environment,windowsHide:true,timeout:45_000})
    if (execution.status !== 0) {
      const diagnosticSql = rendered.sql.replace('do $patrol_postflight$', `select jsonb_build_object('catalogDiff', (select jsonb_agg(jsonb_build_object('key',item.key,'before',item.value,'after',pg_temp.patrol_release_snapshot()->'catalog'->item.key)) from jsonb_each((select snapshot->'catalog' from patrol_release_before)) item where item.value is distinct from pg_temp.patrol_release_snapshot()->'catalog'->item.key));\ndo $patrol_postflight$`)
      const diagnostic = spawnSync(join(bin,'psql'+extension),connection,{input:diagnosticSql,encoding:'utf8',env:environment,windowsHide:true,timeout:45_000})
      assert.fail(`${execution.stderr}\nSynthetic diagnostic: ${diagnostic.stdout}`)
    }
    const proof = JSON.parse(execution.stdout.trim())
    check(proof.proof.protectedCohortsAndCatalogEqual,true,'Generated release conservation checks pass natively')
    check(proof.ledgerRows.length,464,'Generated rehearsal records exactly one transient migration')
    check(sql("select to_regclass('private.patrol_route_save_receipts') is null"),'t','Generated release rolled back receipt relation')
    check(sql("select to_regprocedure('private.save_patrol_route_version_body_v1(jsonb)') is null"),'t','Generated release rolled back private writer')
    check(sql("select jsonb_build_object('writer',md5(pg_get_functiondef('public.save_patrol_route(jsonb)'::regprocedure)),'ledger',(select md5(jsonb_agg(to_jsonb(m) order by version)::text) from supabase_migrations.schema_migrations m))"),before,'Generated release rolled back exact writer and ledger')
    const altered = rendered.sql.replace('do $patrol_postflight$', `update public.employees set first_name='Unexpected' where id='${manager}';\ndo $patrol_postflight$`)
    const rejectedChange = spawnSync(join(bin,'psql'+extension),connection,{input:altered,encoding:'utf8',env:environment,windowsHide:true,timeout:45_000})
    check(rejectedChange.status!==0&&rejectedChange.stderr.includes('Protected record cohorts, counts, security catalog or prior migration history changed'),true,'Generated conservation check rejects a changed employee')
    check(sql(`select first_name from public.employees where id='${manager}'`),'Synthetic','Rejected generated rehearsal restores employee')
    const stale = await renderPatrolRelease({ file: resolve('supabase/migrations/20261117182334_patrol_route_builder_integrity.sql'), hubRoot: arguments_[1], mode: 'rehearsal', ledgerMd5: '0'.repeat(32) })
    const rejectedLedger = spawnSync(join(bin,'psql'+extension),connection,{input:stale.sql,encoding:'utf8',env:environment,windowsHide:true,timeout:45_000})
    check(rejectedLedger.status!==0&&rejectedLedger.stderr.includes('The migration ledger changed since preflight'),true,'Generated release refuses a stale ledger fingerprint')
  }
  const migration=read('supabase/migrations/20261117182334_patrol_route_builder_integrity.sql')
  const originalSave=extract(read('supabase/migrations/20260902214839_patrol_route_update_persistence.sql'),'public.save_patrol_route')
  sql(originalSave.replace('begin\n','begin\n  -- Unexpected installed writer change.\n'))
  const guarded=spawnSync(join(bin,'psql'+extension),connection,{input:migration,encoding:'utf8',env:environment,windowsHide:true,timeout:45_000})
  check(guarded.status!==0&&guarded.stderr.includes('The exact reviewed patrol writers changed'),true,'Changed source writer fails closed')
  check(sql("select to_regclass('private.patrol_route_save_receipts') is null"),'t','Failed migration leaves no partial receipt table')
  sql(originalSave)
  sql(migration)
  const protectedSnapshot="select jsonb_build_object('shifts',(select jsonb_agg(to_jsonb(x) order by x.id) from public.shifts x),'assignments',(select jsonb_agg(to_jsonb(x) order by x.id) from public.shift_assignments x),'time',(select count(*) from public.time_events),'payroll',(select count(*) from private.payroll_rows))"
  const protectedBefore=sql(protectedSnapshot)
  for(const role of ['anon','authenticated','service_role'])check(sql(`select has_table_privilege('${role}','private.patrol_route_save_receipts','select,insert,update,delete')`),'f','Private receipts')
  check(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='private.patrol_route_save_receipts'::regclass"),'t','Receipt RLS')
  for(const role of ['anon','authenticated','service_role'])check(sql(`select has_function_privilege('${role}','private.save_patrol_route_version_body_v1(jsonb)','execute')`),'f','No internal writer bypass')
  rejected(context(guard)+save(route()),'42501');rejected(context(manager,false)+save(route()),'42501')
  rejected(context()+save({...route(),idempotencyKey:undefined}),'22023')
  for(const [label,change] of [['unlinked',{siteId:null}],['inactive',{siteId:inactiveSite}],['inactive-client',{siteId:inactiveClientSite}],['no-client',{siteId:noClientSite}],['wrong-post',{siteId:site,postId:otherPost}],['no-requirements',{requirements:[]}]]){
    const payload=route(id(100+checks));payload.stops[0]={...payload.stops[0],...change};rejected(context()+save(payload),'22023')
  }
  const catalog=JSON.parse(sql(context()+"select public.get_patrol_workspace()->'locations';"))
  check(catalog.some((row)=>row.siteId===siteOnly&&row.postId===null&&row.clientId===client),true,'Site-only property is available')
  check(catalog.length,3,'Only active properties with active clients')
  check(JSON.parse(sql(context(guard,false)+"select public.get_patrol_workspace()->'locations';")).length,0,'Guard sees no manager location catalog')
  check(JSON.parse(sql(context(assignmentManager)+"select public.get_patrol_workspace()->'actor';")).canManageAssignments,true,'Latest predecessor admits assignment-only manager')
  check(JSON.parse(sql(context(assignmentManager)+"select public.get_patrol_workspace()->'locations';")).length,0,'Assignment-only manager gains no route property catalog')
  rejected(context(assignmentManager)+save(route(id(12))),'42501')
  const candidateAvailable=()=>JSON.parse(sql(context()+"select public.get_patrol_workspace()->'scheduleCandidates';")).some((candidate)=>candidate.shiftId===candidateShift)
  check(candidateAvailable(),true,'Current published assignment is available')
  sql(`update public.shift_assignments set canceled_at=clock_timestamp() where shift_id='${candidateShift}';`)
  check(candidateAvailable(),false,'Canceled employee assignment is not offered')
  sql(`update public.shift_assignments set canceled_at=null where shift_id='${candidateShift}';update public.shifts set canceled_at=clock_timestamp() where id='${candidateShift}';`)
  check(candidateAvailable(),false,'Canceled shift is not offered')
  sql(`update public.shifts set canceled_at=null where id='${candidateShift}';update public.posts set active=false where id='${post}';`)
  check(candidateAvailable(),false,'Inactive post is not offered')
  sql(`update public.posts set active=true where id='${post}';`)
  sql("insert into public.schedules values('60000000-0000-4000-8000-000000000002','published','2026-11-15',2,'2026-11-14T12:00Z');")
  check(candidateAvailable(),false,'Superseded published revision is not offered')
  sql("delete from public.schedules where id='60000000-0000-4000-8000-000000000002';")
  check(candidateAvailable(),true,'Only the candidate projection changes; current assignment remains')
  const payload=route();const routeId=sql(context()+save(payload));check(sql(context()+save(payload)),routeId,'Exact retry')
  check(sql('select count(*) from public.patrol_route_versions'),'1','One version after retry')
  check(sql('select count(*) from private.patrol_route_save_receipts'),'1','One receipt after retry')
  rejected(context()+save({...payload,name:'Different payload'}),'PT409')
  const version=sql(`select current_version_id from public.patrol_routes where id='${routeId}'`)
  const update=route(id(3),{id:routeId,expectedVersionId:version,name:'Updated route'})
  check(sql(context()+save(update)),routeId,'Update retains route identity')
  rejected(context()+save({...update,idempotencyKey:id(4),name:'Stale update'}),'PT409')
  check(sql(context()+save(update)),routeId,'Retry survives changed current version')
  rejected("update private.patrol_route_save_receipts set request_checksum=repeat('0',64);",'42501')
  const draft=route(id(5),{code:'incomplete-draft',status:'draft'});draft.stops[0].siteId=null;draft.stops[0].requirements=[]
  const draftId=sql(context()+save(draft));check(Boolean(draftId),true,'Incomplete draft retained honestly')
  const link=`select public.link_patrol_route_shift('${routeId}','${shift}','${guard}');`
  rejected(context(guard)+link,'42501');rejected(context(manager,false)+link,'42501')
  const assignmentId=sql(context()+link);check(sql(context()+link),assignmentId,'Link retry retains identity')
  check(sql(context(assignmentManager)+link),assignmentId,'Assignment-only manager keeps authorized link retry')
  check(JSON.parse(sql(context()+"select public.get_patrol_workspace()->'assignments';"))[0].obligations.every((obligation)=>obligation.source==='scheduled'&&obligation.recoveryHitWindowId===null),true,'Recovery metadata from latest predecessor remains present')
  check(sql('select count(*) from public.patrol_hit_obligations'),'2','Expected weekday obligations')
  sql(`update public.shift_assignments set canceled_at=clock_timestamp() where shift_id='${shift}';`)
  rejected(context()+link,'22023')
  sql(`update public.shift_assignments set canceled_at=null where shift_id='${shift}';`)
  sql(`update public.shifts set canceled_at=clock_timestamp() where id='${shift}';`)
  rejected(context()+link,'22023')
  check(JSON.parse(sql(context()+"select public.get_patrol_workspace()->'assignments';")).some((assignment)=>assignment.id===assignmentId),true,'Existing assignment history remains visible when shift is canceled')
  sql(`update public.shifts set canceled_at=null where id='${shift}';`)
  sql(`update public.shift_assignments set employee_id='${manager}' where shift_id='${shift}';`)
  rejected(context()+link,'22023')
  sql(`update public.shift_assignments set employee_id='${guard}' where shift_id='${shift}';`)
  sql(`update public.posts set active=false where id='${post}';`)
  rejected(context()+link,'22023')
  sql(`update public.posts set active=true where id='${post}';`)
  sql(`update public.clients set status='paused' where id='${client}';`)
  rejected(context()+link,'22023')
  sql(`update public.clients set status='active' where id='${client}';`)
  sql("insert into public.schedules values('60000000-0000-4000-8000-000000000002','published','2026-11-15',2,'2026-11-14T12:00Z');")
  rejected(context()+link,'22023')
  sql("delete from public.schedules where id='60000000-0000-4000-8000-000000000002';")
  check(sql(context()+link),assignmentId,'Valid current publication still permits exact retry')
  const wrongDayPayload=route(id(11),{code:'different-weekday'})
  wrongDayPayload.stops[0].requirements[0].dayOfWeek=2
  const wrongDayRoute=sql(context()+save(wrongDayPayload))
  rejected(context()+`select public.link_patrol_route_shift('${wrongDayRoute}','${shift}','${guard}');`,'22023')
  const latest=sql(`select current_version_id from public.patrol_routes where id='${routeId}'`)
  sql(context()+save(route(id(6),{id:routeId,expectedVersionId:latest,name:'New version for future assignments'})))
  rejected(context()+link,'PT409')
  sql(`update public.patrol_assignments set status='completed' where id='${assignmentId}';`)
  rejected(context()+link,'PT409')
  sql(`update public.patrol_assignments set status='active' where id='${assignmentId}';`)
  check(sql('select count(*) from public.patrol_assignments'),'1','No overlapping active version added')
  check(sql('select count(*) from public.patrol_hit_obligations'),'2','Historical obligations unchanged')
  check(sql(protectedSnapshot),protectedBefore,'Protected work remains unchanged')

  const rollbackPayload=route(id(7),{code:'rollback-check'})
  check(sql('begin;'+context()+save(rollbackPayload)+'rollback;').includes('-'),true,'Rollback-only save executed')
  check(sql("select count(*) from public.patrol_routes where code='rollback-check'"),'0','Rollback-only save retained no route')
  const concurrentPayload=route(id(8),{code:'concurrent-retry'})
  const concurrent=(statement)=>new Promise((yes,no)=>{
    const child=spawn(join(bin,'psql'+extension),connection,{env:environment,windowsHide:true,stdio:'pipe'});let output='',error=''
    child.stdout.on('data',(value)=>{output+=value});child.stderr.on('data',(value)=>{error+=value})
    const timer=setTimeout(()=>child.kill(),15_000)
    child.once('error',no);child.once('close',(code)=>{clearTimeout(timer);code===0?yes(output.trim()):no(new Error(error))});child.stdin.end(context()+statement)
  })
  const copies=await Promise.all([concurrent(save(concurrentPayload)),concurrent(save(concurrentPayload))])
  check(copies[0],copies[1],'Concurrent exact retry deduplicates')
  check(sql("select count(*) from public.patrol_routes where code='concurrent-retry'"),'1','One concurrent route')
  const concurrentRouteId=copies[0]
  const concurrentVersion=sql(`select current_version_id from public.patrol_routes where id='${concurrentRouteId}'`)
  const competing=await Promise.allSettled([concurrent(save(route(id(9),{id:concurrentRouteId,code:'concurrent-retry',expectedVersionId:concurrentVersion,name:'Concurrent edit A'}))),concurrent(save(route(id(10),{id:concurrentRouteId,code:'concurrent-retry',expectedVersionId:concurrentVersion,name:'Concurrent edit B'})))])
  check(competing.filter((result)=>result.status==='fulfilled').length,1,'Only one competing edit succeeds')
  check(competing.filter((result)=>result.status==='rejected'&&result.reason.message.includes('Load the latest version')).length,1,'Competing stale edit requires reload')
  check(sql(`select count(*) from public.patrol_route_versions where route_id='${concurrentRouteId}'`),'2','No lost-update version is inserted')
  console.log(JSON.stringify({passed:true,checks,syntheticOnly:true,productionConnections:0,rollbackVerified:true,concurrentRetryVerified:true,protectedRecordsUnchanged:true,releaseRehearsalVerified:arguments_.length>0,artifacts:directory}))
} catch(error){priorError=error;throw error} finally {stopIsolatedPostgres({data,run,started,priorError})}
