import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

assert.equal(process.versions.node,'24.19.0')
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const {bin,extension}=isolatedPostgresRuntime({platform:process.platform,override:process.env.TIME_OFF_TEST_POSTGRES_BIN,environment})
const directory=mkdtempSync(join(tmpdir(),'sygshift-time-off-history-'));const data=join(directory,'data')
const listener=net.createServer();await new Promise((yes,no)=>{listener.once('error',no);listener.listen(0,'127.0.0.1',yes)})
const port=listener.address().port;await new Promise((yes,no)=>listener.close(error=>error?no(error):yes()))
const run=(name,args,input)=>{const result=spawnSync(join(bin,name+extension),args,{input,encoding:'utf8',env:environment,windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,...(name==='pg_ctl'?{stdio:'ignore'}:{})});assert.equal(result.status,0,result.stderr||result.error?.message);return(result.stdout??'').trim()}
const connection=['-X','--no-password','-h','127.0.0.1','-p',String(port),'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-qAt','-f','-']
const sql=source=>run('psql',connection,source)
const read=path=>readFileSync(resolve(path),'utf8').replaceAll('\r\n','\n')
const extract=(path,name)=>{const source=read(path);const start=source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.','\\.')}\\(`,'iu'));assert(start>=0,name);const end=source.indexOf('$$;',start);assert(end>start,name);return source.slice(start,end+3).replace(/create function/iu,'create or replace function')}
const fixture='tests/fixtures/time-off-cancellation-postgres.sql'
const migration=read('supabase/migrations/20261112210145_time_off_history_keyset_reader.sql')
const manager='10000000-0000-4000-8000-000000000001';const employee='10000000-0000-4000-8000-000000000002';const other='10000000-0000-4000-8000-000000000003'
const id=n=>`23000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const actor=(who=manager)=>`set role authenticated;set fixture.actor='${who}';set fixture.mfa='false';`
const request=(options={},who=manager)=>{
  const {search=null,status='all',bucket='all',limit=20,cursor=null,requestId=null}=options
  const text=value=>value===null?'null':`'${value.replaceAll("'","''")}'`
  return JSON.parse(sql(`${actor(who)}select public.get_time_off_request_page_v1(${text(search)},${text(status)},${text(bucket)},${limit},${text(cursor===null?null:JSON.stringify(cursor))}::jsonb,${text(requestId)}::uuid);`))
}
let checks=0;const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks+=1}
const reject=(statement,code,who=manager)=>{sql(`${actor(who)}do $test$begin begin ${statement} raise exception 'Expected rejection did not occur';exception when sqlstate '${code}' then null;end;end $test$;`);checks+=1}
const dependencies=[
  ['supabase/migrations/20261106172037_approved_time_off_early_return.sql','public.get_request_center_payload_v3','()','e329f3d32cc303c089744ed74688ad63'],
  ['supabase/migrations/20261105185646_approved_time_off_cancellation.sql','public.get_request_center_payload_v2','()','f5cbb87f301b6a6ed690d52b3354d5ef'],
  ['supabase/migrations/20261106172037_approved_time_off_early_return.sql','private.time_off_cancellation_context','(uuid,uuid,timestamptz)','74401d5c41d0b6d6e3dcd27675c92784'],
  ['supabase/migrations/20261029225323_emergency_access_revocation_control_plane.sql','private.current_employee_id','()','fac2b39045e797012633ea4d1499ae5d'],
  ['supabase/migrations/202607030001_foundation.sql','public.current_app_role','()','91960bb233b09534da26e322b24f750b'],
  ['supabase/migrations/20260727203000_access_control_center.sql','public.has_effective_permission','(text)','9f170426206862a0eaddb4236a574240'],
  ['supabase/migrations/20260928203430_rebuild_time_off_request_center.sql','private.time_off_window','(date,date,time,time,text)','565adeb7863a8d8f0900a19a8f27a5a1'],
]
const install=([path,name,args,hash])=>{
  const source=extract(path,name);sql(source)
  if(sql(`select md5(pg_get_functiondef('${name}${args}'::regprocedure))`)!==hash)sql(source.replace(/as \$\$([\s\S]*)\$\$;/iu,(_,body)=>`as $$${body.replaceAll('\n','\r\n')}$$;`))
  check(sql(`select md5(pg_get_functiondef('${name}${args}'::regprocedure))`),hash,`Exact retained dependency ${name}`)
  sql(`revoke all on function ${name}${args} from public,anon,authenticated,service_role;${name.startsWith('public.')?`grant execute on function ${name}${args} to authenticated;`:''}${['private.current_employee_id','public.current_app_role','public.has_effective_permission'].includes(name)?`grant execute on function ${name}${args} to service_role;`:''}`)
}
let started=false;let failure
try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);startIsolatedPostgres({data,directory,port,run,utc:true});started=true
  sql(read(fixture));sql(read('tests/fixtures/time-off-history-postgres.sql'))
  // Load the same public wrapper and actual session/role/permission boundaries.
  install(dependencies.find(([,name])=>name==='private.current_employee_id'))
  sql(extract('supabase/migrations/202607030001_foundation.sql','public.current_employee_id'))
  sql(extract('supabase/migrations/20260928203430_rebuild_time_off_request_center.sql','private.time_off_local_instant'))
  sql('drop function public.has_effective_permission(text);') // Replace only the isolated fixture stub, never a production function.
  dependencies.filter(([,name])=>name!=='private.current_employee_id').forEach(install)
  const fingerprints=()=>sql(`select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) from pg_proc p where p.oid in(${dependencies.map(([,name,args])=>`'${name}${args}'::regprocedure`).join(',')});`)
  const before=fingerprints()
  assert.equal((migration.match(/^begin;$/gmu)??[]).length,1);assert.equal((migration.match(/^commit;$/gmu)??[]).length,1)
  sql(migration.replace(/^commit;$/mu,'rollback;'))
  check(sql("select to_regprocedure('public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid)') is null"),'t','Single transaction rehearsal rolls back new reader')
  sql(migration);check(fingerprints(),before,'Canonical readers/auth/time functions remain unchanged')
  sql(`insert into public.time_off_requests(id,employee_id,starts_on,ends_on,status,request_type,employment_type_snapshot,pay_treatment,submission_snapshot,affected_shifts_snapshot,reason,created_at)
    select ('23000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${employee}',date '2099-07-01',date '2099-07-03','approved','unpaid_time_off','hourly','unpaid','{"timeZone":"America/New_York"}','[]',
    case when n=1 then 'historicalneedle oldest-only-target' else 'historicalneedle' end,'2026-01-01T00:00:00.123456Z' from generate_series(1,201)n;`)
  const first=request({search:'historicalneedle',bucket:'history'})
  check(first.items.length,20,'Bounded first page')
  check(first.page.total,201,'All older/future approvals are counted beyond old100cap')
  check(first.counts.approved,201,'Authoritative approved count')
  check(first.page.hasMore,true,'More pages exposed')
  check(first.page.nextCursor.createdAt,'2026-01-01T00:00:00.123456Z','Full microsecond cursor precision')
  let cursor=first.page.nextCursor;const seen=new Set(first.items.map(x=>x.id));let pageCount=1
  while(cursor){const page=request({search:'historicalneedle',bucket:'history',cursor});for(const row of page.items){assert(!seen.has(row.id));seen.add(row.id)}cursor=page.page.nextCursor;pageCount+=1}
  check(seen.size,201,'Every historical record is reachable without duplicate or loss')
  check(pageCount,11,'All bounded pages traversed')
  check(request({search:'oldest-only-target'}).items[0].id,id(1),'Search before pagination finds oldest matching record')
  check(request({search:'historicalneedle'},other).page.total,0,'Guard cannot enumerate another employee records')
  check(request({search:'historicalneedle'},employee).page.total,201,'Personal history remains completely discoverable')
  reject(`perform public.get_time_off_request_page_v1('historicalneedle','all','history',20,'${JSON.stringify(first.page.nextCursor)}',null);`,'22023',employee)
  sql(`insert into public.time_off_requests(id,employee_id,starts_on,ends_on,status,request_type,employment_type_snapshot,pay_treatment,submission_snapshot,affected_shifts_snapshot,reason,created_at)
    values('${id(202)}','${employee}','2099-07-01','2099-07-03','approved','unpaid_time_off','hourly','unpaid','{"timeZone":"America/New_York"}','[]','historicalneedle',clock_timestamp());`)
  check(request({search:'historicalneedle',bucket:'history',cursor:first.page.currentCursor}).items.map(x=>x.id),first.items.map(x=>x.id),'Previous returns same head snapshot after new record')
  check(request({search:'historicalneedle',bucket:'history'}).page.total,202,'Explicit fresh request sees new record')
  sql(`insert into private.time_off_request_early_returns values('${id(1)}','${employee}','${manager}','2099-07-02Z','2099-07-02Z','Returned for tonight','America/New_York');
    update public.time_off_requests set status='canceled' where id='${id(2)}';
    insert into private.time_off_request_cancellations values('${id(2)}','${employee}','${manager}',now(),'Vacation no longer needed');`)
  const ended=request({search:'historicalneedle',status:'ended_early'})
  check(ended.page.total,1,'Ended-early status derives from retained receipt')
  check(ended.items[0].status,'approved','Original approval remains unchanged')
  check(ended.items[0].earlyReturn.note,'Returned for tonight','Early-return history is retained')
  check(ended.items[0].cancellationContext.phase,'ended_early','Canonical action context is reused')
  check(request({search:'historicalneedle',status:'approved'}).page.total,200,'Approved filter excludes ended-early and canceled records')
  check(request({requestId:id(2),limit:1}).items[0].cancellation.note,'Vacation no longer needed','Exact history lookup retains cancellation details')
  check(request({requestId:id(2),limit:1},other).items.length,0,'Exact lookup cannot bypass recipient authorization')
  sql(`update public.employees set time_zone='America/Los_Angeles' where id='${employee}';`)
  const unchangedZone=request({requestId:id(1),limit:1}).items[0]
  check(unchangedZone.earlyReturn.timeZone,'America/New_York','Historical early-return receipt keeps its original timezone after profile changes')
  check(unchangedZone.cancellationContext.timeZone,'America/New_York','Canonical context uses immutable submitted timezone, not new profile zone')
  check(unchangedZone.startsOn,'2099-07-01','Original date is not rebased')
  sql(`update public.time_off_requests set reason='context mix' where id in('${id(3)}','${id(4)}');
    update public.time_off_requests set submission_snapshot='{"timeZone":"Not/AZone"}' where id='${id(3)}';`)
  const mixedContext=request({search:'context mix'})
  check(mixedContext.items.length,2,'Malformed action context does not hide valid peer records')
  const invalidContext=mixedContext.items.find(row=>row.id===id(3))
  check(invalidContext.cancellationContextUnavailable,true,'Unverifiable action eligibility is explicit')
  check(Object.hasOwn(invalidContext,'cancellationContext'),false,'Unverified context is omitted rather than replaced with allowed actions')
  check(Boolean(mixedContext.items.find(row=>row.id===id(4)).cancellationContext),true,'Valid peer retains canonical action context')
  const deniedContext=spawnSync(join(bin,'psql'+extension),connection,{input:`begin;create or replace function private.time_off_cancellation_context(target_request_id uuid,viewer_id uuid,evaluated_at timestamptz) returns jsonb language plpgsql stable security definer set search_path='' as $$begin raise insufficient_privilege using message='Fixture protected authority denied';end$$;${actor()}select public.get_time_off_request_page_v1('context mix');rollback;`,encoding:'utf8',env:environment,windowsHide:true})
  check(deniedContext.status!==0&&deniedContext.stderr.includes('Fixture protected authority denied'),true,'Permission errors propagate rather than become malformed-row warnings')
  reject(`perform public.get_time_off_request_page_v1('x','all','all',1,null,'${id(1)}');`,'22023')
  reject(`perform public.get_time_off_request_page_v1(null,'bogus','all',20,null,null);`,'22023')
  reject(`perform public.get_time_off_request_page_v1(null,'all','all',51,null,null);`,'22023')
  const changed={...first.page.currentCursor,extra:true};reject(`perform public.get_time_off_request_page_v1('historicalneedle','all','history',20,'${JSON.stringify(changed)}',null);`,'22023')
  sql(`update private.employee_accounts set disabled_at=now() where employee_id='${manager}';`)
  reject('perform public.get_time_off_request_page_v1();','42501')
  sql(`update private.employee_accounts set disabled_at=null where employee_id='${manager}';`)
  const records=()=>sql("select jsonb_build_object('leave',(select jsonb_agg(r order by id) from public.time_off_requests r),'punches',(select jsonb_agg(t) from public.time_events t),'payroll',(select jsonb_agg(p) from private.payroll_export_rows p),'schedules',(select jsonb_agg(s) from public.schedules s))")
  const stable=records();request({search:'historicalneedle'});request({requestId:id(1),limit:1});check(records(),stable,'All reads preserve leave, punches, payroll and schedules')
  for(const role of ['anon','service_role'])check(sql(`select has_function_privilege('${role}','public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid)','execute')`),'f',`${role} cannot invoke authenticated history reader`)
  sql(read('supabase/tests/time_off_history_reader_postflight.sql'));checks+=1
  sql(`insert into public.time_off_requests(id,employee_id,starts_on,ends_on,status,request_type,employment_type_snapshot,pay_treatment,submission_snapshot,affected_shifts_snapshot,reason,created_at)
    select ('24000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${employee}',date '2099-07-01',date '2099-07-03','approved','unpaid_time_off','hourly','unpaid','{"timeZone":"America/New_York"}','[]','scale history','2025-01-01Z'::timestamptz+n*interval '1 microsecond' from generate_series(1,100000)n;analyze public.time_off_requests;`)
  const plan=JSON.parse(sql(`${actor()}explain(analyze,format json,timing off)select public.get_time_off_request_page_v1(null,'approved','history',20,null,null);`))[0]
  check(plan['Execution Time']<10000,true,'100k-row exact-count page stays within bounded timeout')
  console.log(JSON.stringify({checks,passed:true,productionConnections:0,scaleRows:100000,pageExecutionMs:plan['Execution Time']}))
}catch(error){failure=error;throw error}finally{stopIsolatedPostgres({data,run,started,priorError:failure})}
