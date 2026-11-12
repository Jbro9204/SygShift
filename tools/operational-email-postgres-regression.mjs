import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { isolatedPostgresRuntime, startIsolatedPostgres, stopIsolatedPostgres } from './isolated-postgres-startup.mjs'

// Synthetic loopback database only; no application credentials are read.
assert.equal(process.versions.node, '24.19.0')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^(?:DATABASE_URL|SUPABASE_)/iu.test(key)))
const { bin, extension } = isolatedPostgresRuntime({ platform: process.platform, override: process.env.OPERATIONAL_EMAIL_TEST_POSTGRES_BIN, environment })
const directory = mkdtempSync(join(tmpdir(), 'sygshift-operational-email-'))
const data = join(directory, 'data')
const listener = net.createServer()
await new Promise((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes) })
const port = listener.address().port
await new Promise((yes, no) => listener.close(error => error ? no(error) : yes()))
const run = (name, args, input) => {
  const result = spawnSync(join(bin, name + extension), args, { input, encoding: 'utf8', env: environment, windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...(name === 'pg_ctl' ? { stdio: 'ignore' } : {}) })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return (result.stdout ?? '').trim()
}
const connection = ['-X', '--no-password', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-f', '-']
const sql = source => run('psql', connection, source)
const read = path => readFileSync(resolve(path), 'utf8').replaceAll('\r\n', '\n')
const migration = read('supabase/migrations/20261112205236_operational_email_recipient_delivery_guard.sql')
const service = source => sql(`set role service_role;set request.jwt.claim.role='service_role';${source}`)
const id = n => `12000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let checks = 0
const check = (value, expected, name) => { assert.deepEqual(value, expected, name); checks += 1 }
const reject = (statement, code, asService = true) => {
  const source = `do $test$ begin begin ${statement} raise exception 'Expected rejection did not occur'; exception when sqlstate '${code}' then null;end;end $test$;`
  ;(asService ? service : sql)(source); checks += 1
}
const resolveJob = (n, lane='general') => JSON.parse(service(`select public.service_resolve_operational_email_recipients('${id(n)}','${lane}');`))
const claim = (n, e, lane='general') => JSON.parse(service(`select public.service_claim_operational_email_recipient('${id(n)}','${lane}','${id(e)}');`))
const finish = (n, e, attempt, outcome, lane='general') => JSON.parse(service(`select public.service_record_operational_email_recipient_result('${id(n)}','${lane}','${id(e)}','${attempt}','${outcome}');`))
const finalize = (n, lane='general') => JSON.parse(service(`select public.service_finalize_operational_email_job('${id(n)}','${lane}');`))
const seedJob = (n, type, source, recipient=null) => sql(`insert into private.notification_outbox(id,message_type,aggregate_id,recipient_employee_id,attempt_count,attempted_at) values('${id(n)}','${type}','${id(source)}',${recipient ? `'${id(recipient)}'` : 'null'},1,now());`)
const functions = [
  ['supabase/migrations/20261005123949_call_off_alert_lifecycle_retirement.sql','public.service_claim_notification_batch','03cf0f7c948839dc21274d12f5755b7d'],
  ['supabase/migrations/20260909220000_employee_writeup_and_signature_delivery.sql','public.service_claim_notification_batch','cdf3e8111e99d0e4066172880d092424','private.service_claim_notification_batch_pre_call_off'],
  ['supabase/migrations/20261005123949_call_off_alert_lifecycle_retirement.sql','public.service_claim_employee_notification_batch','04a1a9e927be69cd329e2fc43df67660'],
  ['supabase/migrations/20260906133034_employee_notification_center.sql','public.service_claim_employee_notification_batch','11ddfe3ec4e15c6ecd7608636fe93b14','private.service_claim_employee_notification_batch_pre_call_off'],
  ['supabase/migrations/20260827110000_my_account_self_service.sql','public.service_filter_notification_recipients','284d52e3f1eac114823e97876cf82968'],
  ['supabase/migrations/20260823190000_personal_email_delivery_routing.sql','public.service_claim_timekeeping_notification_batch','f1e611dd9378bd9a4407e750fad10ab3'],
  ['supabase/migrations/20260828180000_home_time_off_request_workflow.sql','public.service_claim_time_off_notification_batch','05ae34871e1bad549880d0c3e5d6b8ab'],
  ['supabase/migrations/20260829120000_communications_workspaces.sql','public.service_get_announcement_email_recipients','6920f867592b2cb40f81b72560bf96e1'],
  ['supabase/migrations/20260921182231_support_ticket_email_redesign.sql','public.service_claim_support_ticket_notification_batch','3fa61260ba733975e4a7e73b18eb50e9'],
  ['supabase/migrations/20260908143000_support_notification_routing_and_session_foundation.sql','private.support_employee_can_view','b68974bcf6176b9e367c624f125e640d'],
  ['supabase/migrations/20260823190000_personal_email_delivery_routing.sql','private.preferred_delivery_email','d4fbf5510bffe6cc09f7386901aaa546'],
]
const installReviewed = ([path, name, expected, renamed]) => {
  const source = read(path)
  const start = source.search(new RegExp(`create (?:or replace )?function ${name.replaceAll('.', '\\.')}\\(`, 'iu'))
  assert(start >= 0, name)
  const end = source.indexOf('$$;', start)
  assert(end > start, name)
  let definition = source.slice(start, end + 3)
  if (renamed) definition = definition.replace(name, renamed)
  const signature = `${renamed ?? name}(${name.endsWith('preferred_delivery_email') ? 'text,text' : name.endsWith('service_filter_notification_recipients') ? 'text,uuid,jsonb' : name.endsWith('service_get_announcement_email_recipients') ? 'uuid' : name.endsWith('support_employee_can_view') ? 'uuid,public.support_tickets' : 'integer'})`
  // Exact historical bodies can carry CRLF from the original Windows checkout.
  // Check both byte encodings, never substitute or bypass the reviewed hash.
  sql(definition)
  let hash = sql(`select md5(pg_get_functiondef('${signature}'::regprocedure));`)
  if (hash !== expected) {
    sql(definition.replace(/create function/iu,'create or replace function').replace(/as \$\$([\s\S]*)\$\$;/iu, (_,body) => `as $$${body.replaceAll('\n','\r\n')}$$;`))
    hash = sql(`select md5(pg_get_functiondef('${signature}'::regprocedure));`)
  }
  check(hash, expected, `Reviewed exact dependency ${signature}`)
  sql(`revoke all on function ${signature} from public,anon,authenticated,service_role;${renamed || (name.startsWith('private.') && !name.endsWith('preferred_delivery_email')) ? '' : `grant execute on function ${signature} to service_role;`}`)
}
let started = false
let failure
try {
  run('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'])
  startIsolatedPostgres({ data, directory, port, run, utc:true }); started=true
  sql(read('tests/fixtures/operational-email-postgres.sql'))
  {const source=read('supabase/migrations/202607030001_foundation.sql');const start=source.indexOf('create function private.write_audit_event()');const end=source.indexOf('$$;',start);sql(source.slice(start,end+3))}
  {const source=read('supabase/migrations/20260909220000_employee_writeup_and_signature_delivery.sql');const start=source.indexOf('create or replace function private.enforce_notification_delivery_lease()');const end=source.indexOf('$$;',start);sql(source.slice(start,end+3));sql('create trigger fixture_outbox_lease before update on private.notification_outbox for each row execute function private.enforce_notification_delivery_lease();create trigger fixture_employee_lease before update on public.employee_notification_email_deliveries for each row execute function private.enforce_notification_delivery_lease();')}
  functions.forEach(installReviewed)
  const dependencySnapshot=()=>JSON.parse(sql(`select jsonb_agg(jsonb_build_object('oid',p.oid,'body',p.prosrc,'owner',p.proowner,'acl',p.proacl,'config',p.proconfig) order by p.oid) from pg_proc p where p.oid in(${functions.map(([,name,,renamed])=>`'${renamed??name}(${name.endsWith('preferred_delivery_email')?'text,text':name.endsWith('service_filter_notification_recipients')?'text,uuid,jsonb':name.endsWith('service_get_announcement_email_recipients')?'uuid':name.endsWith('support_employee_can_view')?'uuid,public.support_tickets':'integer'})'::regprocedure`).join(',')});`))
  const priorDependencies=dependencySnapshot()
  const protectedBefore=sql(`select jsonb_build_object('employees',(select jsonb_agg(e) from public.employees e),'accounts',(select jsonb_agg(a) from private.employee_accounts a),'time',(select jsonb_agg(t) from public.time_events t),'payroll',(select jsonb_agg(p) from private.payroll_rows p));`)
  assert.equal((migration.match(/^begin;$/gmu)??[]).length,1)
  assert.equal((migration.match(/^commit;$/gmu)??[]).length,1)
  const rollbackRehearsal=migration.replace(/^commit;$/mu,'rollback;')
  assert.equal((rollbackRehearsal.match(/^rollback;$/gmu)??[]).length,1)
  sql(rollbackRehearsal)
  check(sql("select to_regclass('private.operational_email_delivery_ledger') is null"),'t','One outer transaction rolls back all new objects')
  const drift=spawnSync(join(bin,'psql'+extension),connection,{input:`begin;alter function public.service_get_announcement_email_recipients(uuid) set search_path='public';${migration.replace(/^begin;$/mu,'').replace(/^commit;$/mu,'rollback;')}`,encoding:'utf8',env:environment,windowsHide:true})
  check(drift.status!==0&&drift.stderr.includes('Operational email dependency drift'),true,'Changed prior definition stops migration rather than overriding drift')
  const start=Date.now();sql(migration);check(Date.now()-start<10000,true,'Migration completes within bounded timeout')
  check(dependencySnapshot().map(row=>({...row,body:row.body.replace(/and private\.operational_email_claim_allowed\('support',notification\.id\) /u,'').replace(/private\.operational_email_claim_allowed\('(general|employee|timekeeping|time_off)',(outbox|delivery)\.id\) and /gu,'')})),priorDependencies,'Only five reviewed pending predicates change; all other body bytes and metadata remain exact')
  check(sql('select count(*) from private.operational_email_delivery_ledger'),'0','Migration does not backfill jobs or recipient identities')
  check(sql(`select jsonb_build_object('employees',(select jsonb_agg(e) from public.employees e),'accounts',(select jsonb_agg(a) from private.employee_accounts a),'time',(select jsonb_agg(t) from public.time_events t),'payroll',(select jsonb_agg(p) from private.payroll_rows p));`),protectedBefore,'Migration preserves business rows')
  check(sql("select relrowsecurity and relforcerowsecurity from pg_class where oid='private.operational_email_delivery_ledger'::regclass"),'t','Forced RLS')
  for(const role of ['anon','authenticated','service_role']) check(sql(`select has_table_privilege('${role}','private.operational_email_delivery_ledger','select,insert,update,delete')`),'f',`No table grants ${role}`)
  reject(`perform public.service_resolve_operational_email_recipients('${id(999)}','general');`,'22023')
  seedJob(201,'announcement_published',101)
  check(resolveJob(201).recipientEmployeeIds,[id(1),id(2),id(3),id(4),id(5)],'Retained snapshot IDs, no new arbitrary employee')
  sql(`update private.employee_contacts set personal_email='updated@example.test' where employee_id='${id(1)}';`)
  const first=claim(201,1);check(first.email,'updated@example.test','Fresh address by stable ID')
  check(claim(201,1).state,'held','Unresolved claim is not resent')
  check(finish(201,1,first.attemptId,'accepted').state,'accepted','Accepted proof')
  check(finish(201,1,first.attemptId,'unknown').state,'accepted','Accepted proof never downgrades')
  for(const e of [2,3,5]) check(claim(201,e).state,'suppressed',`Inactive/separated/suspended excluded ${e}`)
  reject(`perform public.service_finalize_operational_email_job('${id(201)}','general');`,'23514')
  const leaveClaim=claim(201,4);check(leaveClaim.state,'send','Employee on leave retains ordinary email eligibility')
  check(finalize(201).status,'held','Unresolved claim prevents aggregate success')
  check(sql(`select delivered_at is null and failed_at is not null from private.notification_outbox where id='${id(201)}'`),'t','Held job not marked delivered')
  finish(201,4,leaveClaim.attemptId,'accepted')
  reject(`perform public.service_finalize_operational_email_job('${id(201)}','general');`,'23514')
  seedJob(202,'schedule_published',102)
  const schedule=resolveJob(202);check(schedule.recipientEmployeeIds.includes(id(6)),false,'Unassigned Guard not included')
  sql(`update public.employees set role='supervisor' where id='${id(6)}';`)
  check(resolveJob(202).recipientEmployeeIds,schedule.recipientEmployeeIds,'Late role promotion cannot expand retained audience')
  reject(`perform public.service_claim_operational_email_recipient('${id(202)}','general','${id(6)}');`,'42501')
  sql(`update private.employee_notification_preferences set schedule_published=false where employee_id='${id(1)}';`)
  check(claim(202,1).state,'suppressed','Current preference is checked before send')
  seedJob(203,'time_off_decision',103,1);resolveJob(203,'time_off')
  check(claim(203,1,'time_off').state,'send','Time off uses its own preference')
  seedJob(204,'automatic_clock_out_employee',104);resolveJob(204,'timekeeping')
  sql(`update auth.users set banned_until=now()+interval '1 day' where id='${id(1)}';`)
  check(claim(204,1,'timekeeping').state,'suppressed','Current Auth ban excludes operations delivery')
  sql(`update auth.users set banned_until=null where id='${id(1)}';`)
  seedJob(205,'announcement_published',105);resolveJob(205)
  sql(`update private.employee_contacts set personal_email='updated@example.test' where employee_id='${id(6)}';`)
  check(claim(205,1).state,'suppressed','Ambiguous shared canonical address fails closed')
  sql(`update private.employee_contacts set personal_email='person6@example.test' where employee_id='${id(6)}';`)
  seedJob(206,'announcement_published',106);resolveJob(206)
  check(finalize(206).status,'suppressed','Empty retained audience is terminal suppression')
  reject(`perform public.service_resolve_operational_email_recipients('${id(203)}','general');`,'22023')
  reject(`perform public.service_record_operational_email_recipient_result('${id(203)}','time_off','${id(1)}','${id(999)}','accepted');`,'42501')
  seedJob(207,'announcement_published',105);resolveJob(207)
  sql(`update private.employee_accounts set disabled_at=now() where employee_id='${id(1)}';`)
  check(claim(207,1).state,'suppressed','Disabled account never gets operational delivery')
  sql(`update private.employee_accounts set disabled_at=null where employee_id='${id(1)}';`)
  seedJob(208,'announcement_published',105);resolveJob(208)
  sql(`delete from private.employee_accounts where employee_id='${id(1)}';`)
  const unprovisioned=claim(208,1);check(unprovisioned.state,'send','Active unprovisioned employee remains eligible for ordinary announcements')
  finish(208,1,unprovisioned.attemptId,'accepted')
  check(finalize(208).status,'delivered','One verified acceptance completes exact job')
  check(finalize(208).status,'delivered','Terminal finalize is idempotent')
  sql(`insert into private.employee_accounts values('${id(1)}','${id(1)}',null);`)
  seedJob(209,'announcement_published',105);resolveJob(209)
  sql(`update auth.users set deleted_at=now() where id='${id(1)}';`)
  check(claim(209,1).state,'suppressed','Deleted Auth identity is excluded')
  sql(`update auth.users set deleted_at=null where id='${id(1)}';`)
  seedJob(210,'schedule_published',102);resolveJob(210)
  sql(`update public.employees set role='guard' where id='${id(6)}';`)
  check(claim(210,6).state,'suppressed','Lost role membership cannot retain privileged operational mail')
  sql(`insert into public.support_tickets values('${id(107)}','${id(1)}','support.route');
    insert into public.support_ticket_notifications values('${id(211)}','${id(107)}','${id(1)}','support_ticket_opened',1,now(),null,null,null,null);
    insert into public.employee_notifications values('${id(108)}','${id(1)}',null,null,null);
    insert into public.employee_notification_email_deliveries values('${id(212)}','${id(108)}','${id(1)}',1,now(),null,null,null,null);`)
  check(resolveJob(211,'support').recipientEmployeeIds,[id(1)],'Support bound to exact recipient ID')
  const supportClaim=claim(211,1,'support');check(supportClaim.state,'send','Support keeps existing view authority')
  finish(211,1,supportClaim.attemptId,'accepted','support')
  check(finalize(211,'support').status,'delivered','Support accepted outcome finalizes correct source')
  check(resolveJob(212,'employee').recipientEmployeeIds,[id(1)],'Employee notification bound to exact ID')
  sql(`update public.employee_notifications set resolved_at=now() where id='${id(108)}';`)
  check(claim(212,1,'employee').state,'suppressed','Resolved employee notification suppressed')
  check(finalize(212,'employee').status,'suppressed','Employee suppression is terminal without delivered success')
  seedJob(213,'document_signature_required',109,1);resolveJob(213)
  sql(`update private.employee_notification_preferences set announcements=false,time_off_decision=false where employee_id='${id(1)}';`)
  const required=claim(213,1);check(required.state,'send','Required document does not inherit optional preferences')
  finish(213,1,required.attemptId,'suppressed')
  check(finalize(213).status,'suppressed','Worker pre-provider suppression remains truthful')
  seedJob(214,'time_off_decision',103,1);resolveJob(214,'time_off')
  check(claim(214,1,'time_off').state,'suppressed','Time-off current preference respected')
  seedJob(215,'announcement_published',105);resolveJob(215)
  sql(`update private.notification_outbox set aggregate_id='${id(106)}' where id='${id(215)}';`)
  reject(`perform public.service_resolve_operational_email_recipients('${id(215)}','general');`,'23514')
  seedJob(216,'announcement_published',999)
  reject(`perform public.service_resolve_operational_email_recipients('${id(216)}','general');`,'23514')
  for(const role of ['anon','authenticated']){
    const denied=spawnSync(join(bin,'psql'+extension),connection,{input:`set role ${role};set request.jwt.claim.role='service_role';select public.service_resolve_operational_email_recipients('${id(215)}','general');`,encoding:'utf8',env:environment,windowsHide:true})
    check(denied.status!==0,true,`${role} cannot spoof service JWT to call delivery RPC`)
  }
  seedJob(217,'announcement_published',105)
  check(JSON.parse(service(`select public.service_defer_operational_email_job('${id(217)}','general')`)).status,'deferred','Lookup failure backs off an unclaimed provider attempt')
  check(JSON.parse(service(`select public.service_defer_operational_email_job('${id(201)}','general')`)).status,'held','Lost finalization reply cannot clear a held terminal state')
  check(JSON.parse(service(`select public.service_defer_operational_email_job('${id(208)}','general')`)).status,'delivered','Lost finalization reply cannot clear accepted terminal state')
  sql(`update private.employee_notification_preferences set announcements=true where employee_id='${id(1)}';`)
  seedJob(218,'announcement_published',105);resolveJob(218)
  const processSql=(input,onData)=>new Promise(resolveResult=>{
    const process=spawn(join(bin,'psql'+extension),connection,{env:environment,windowsHide:true,stdio:['pipe','pipe','pipe']});let out='';let error='';
    process.stdout.on('data',data=>{out+=data;onData?.(out)});process.stderr.on('data',data=>{error+=data});process.on('close',code=>resolveResult({code,out,error}));process.stdin.end(input)
  })
  let ready;let readyTimeout
  const claimReady=new Promise((yes,no)=>{ready=yes;readyTimeout=setTimeout(()=>no(new Error('First isolated claim did not reach its lock checkpoint.')),5000)})
  const firstProcess=processSql(`set role service_role;set request.jwt.claim.role='service_role';begin;select public.service_claim_operational_email_recipient('${id(218)}','general','${id(1)}');select pg_sleep(1);commit;`,out=>{if(out.includes('"state": "send"')){clearTimeout(readyTimeout);ready()}})
  await claimReady
  const competing=await processSql(`set role service_role;set request.jwt.claim.role='service_role';select public.service_claim_operational_email_recipient('${id(218)}','general','${id(1)}');`)
  check(competing.code!==0,true,'Concurrent second sender cannot claim the same job')
  check((await firstProcess).code,0,'Original recipient claim completes')
  check(claim(218,1).state,'held','Later retry sees unresolved claim, never send again')
  check(Number(sql(`select count(*) from private.operational_email_delivery_ledger where job_id='${id(218)}' and event='claimed'`)),1,'Exactly one durable claim under race')
  sql(`update public.employees set role='supervisor' where id='${id(1)}';
    insert into public.call_off_reports(id,shift_id,canceled_at,resolved_at,duplicate_of_call_off_report_id,replacement_needed) values('${id(110)}','${id(112)}',null,null,null,true);`)
  seedJob(219,'call_off_supervisor_alert',110);resolveJob(219)
  check(claim(219,1).state,'send','Required call-off warning bypasses optional preferences only')
  seedJob(220,'document_signature_required',109,1);resolveJob(220)
  sql(`update private.employee_accounts set disabled_at=now() where employee_id='${id(1)}';`)
  check(claim(220,1).state,'suppressed','Required document cannot bypass disabled account')
  sql(`update private.employee_accounts set disabled_at=null where employee_id='${id(1)}';`)
  seedJob(221,'call_off_supervisor_alert',110);resolveJob(221)
  sql(`update public.call_off_reports set resolved_at=now() where id='${id(110)}';`)
  check(claim(221,1).state,'suppressed','Call-off resolved after snapshot is not delivered')
  seedJob(222,'announcement_published',105);resolveJob(222)
  sql(`update private.employee_contacts set personal_email='invalid@local' where employee_id='${id(1)}';`)
  check(claim(222,1).state,'suppressed','Unusable external address suppressed before any provider claim')
  sql(`update private.employee_contacts set personal_email='updated@example.test' where employee_id='${id(1)}';`)
  sql(read('supabase/tests/operational_email_delivery_postflight.sql'));checks+=1
  // Mixed-version rollback uses the actual old claimers and lease trigger.
  sql("update private.notification_outbox set available_at=now()+interval '1 day' where delivered_at is null and failed_at is null;")
  seedJob(230,'announcement_published',105);sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id='${id(230)}';`)
  check(JSON.parse(service("select public.service_claim_guarded_operational_email_batch('general',10)")).length,0,'Guarded facade is inert before verified activation')
  check(JSON.parse(service('select public.service_claim_notification_batch(10)')).map(job=>job.id),[id(230)],'Legacy no-ledger job continues before cutover')
  check(sql(`select available_at>now()+interval '19 minutes' from private.notification_outbox where id='${id(230)}'`),'t','Actual legacy20minute lease retained')
  sql(`update private.notification_outbox set delivered_at=now() where id='${id(230)}';update private.operational_email_delivery_control set guarded_enabled=true,reason='Synthetic verified cutover',changed_at=now();`)
  seedJob(231,'announcement_published',101);sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id='${id(231)}';`)
  const atomic=JSON.parse(service("select public.service_claim_guarded_operational_email_batch('general',10)"));check(atomic.map(job=>job.id),[id(231)],'Guarded facade returns only claimed jobs')
  check(Number(sql(`select count(*) from private.operational_email_delivery_ledger where job_id='${id(231)}' and event='audience'`)),1,'Audience ownership committed atomically before batch response')
  check(service("select coalesce(current_setting('sygshift.operational_email_claim_lane',true),'')"),'','Facade marker never leaks to next request')
  const accepted=claim(231,1);finish(231,1,accepted.attemptId,'accepted')
  sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id='${id(231)}';update private.operational_email_delivery_control set guarded_enabled=false,reason='Synthetic rollback safety check';`)
  seedJob(232,'announcement_published',105);sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id='${id(232)}';`)
  check(JSON.parse(service('select public.service_claim_notification_batch(10)')).map(job=>job.id),[id(232)],'Old worker skips guarded accepted-subset job and processes unrelated legacy job')
  check(sql(`select failed_at is null and delivered_at is null from private.notification_outbox where id='${id(231)}'`),'t','Rollback filter does not destructively quarantine active guarded job')
  check(claim(231,1).state,'accepted','Accepted recipient is never authorized for a second handoff')
  sql(`update private.notification_outbox set delivered_at=now() where id='${id(232)}';update private.operational_email_delivery_control set guarded_enabled=true,reason='Synthetic guarded resume';`)
  check(JSON.parse(service("select public.service_claim_guarded_operational_email_batch('general',10)")).map(job=>job.id),[id(231)],'New worker can resume the same retained audience')
  sql("update private.notification_outbox set available_at=now()+interval '1 day' where delivered_at is null and failed_at is null;")
  seedJob(233,'announcement_published',999);seedJob(234,'announcement_published',105)
  sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id in('${id(233)}','${id(234)}');`)
  check(JSON.parse(service("select public.service_claim_guarded_operational_email_batch('general',10)")).map(job=>job.id),[id(234)],'One malformed source cannot head-block unrelated valid mail')
  check(sql(`select failed_at is not null and delivered_at is null from private.notification_outbox where id='${id(233)}'`),'t','Malformed source held without provider-success claim')
  sql(`update private.notification_outbox set available_at=now()+interval '1 day' where delivered_at is null and failed_at is null;
    update public.timekeeping_operational_exceptions set shift_id='${id(112)}',scheduled_end_at=now() where id='${id(104)}';
    insert into public.support_ticket_notifications(id,ticket_id,recipient_employee_id,message_type,attempt_count,available_at) values('${id(242)}','${id(107)}','${id(1)}','support_ticket_opened',0,now()-interval '1 minute');
    insert into public.employee_notifications(id,recipient_employee_id)values('${id(111)}','${id(1)}');
    insert into public.employee_notification_email_deliveries(id,notification_id,recipient_employee_id,attempt_count,available_at)values('${id(243)}','${id(111)}','${id(1)}',0,now()-interval '1 minute');`)
  seedJob(240,'automatic_clock_out_employee',104);seedJob(241,'time_off_decision',103,1)
  sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id in('${id(240)}','${id(241)}');`)
  for(const [lane,n]of[['timekeeping',240],['time_off',241],['support',242],['employee',243]]){
    const jobs=JSON.parse(service(`select public.service_claim_guarded_operational_email_batch('${lane}',10)`))
    check(jobs.some(job=>job.id===id(n)),true,`Actual ${lane} claimant runs through guarded facade`)
    check(Number(sql(`select count(*) from private.operational_email_delivery_ledger where lane='${lane}' and job_id='${id(n)}' and event='audience'`)),1,`Atomic ${lane} audience reservation`)
  }
  sql("update private.notification_outbox set available_at=now()+interval '1 day' where delivered_at is null and failed_at is null;")
  seedJob(250,'announcement_published',105);seedJob(251,'announcement_published',105)
  sql(`update private.notification_outbox set available_at=now()-interval '1 minute' where id in('${id(250)}','${id(251)}');`)
  let batchReady;let batchTimer
  const batchCheckpoint=new Promise((yes,no)=>{batchReady=yes;batchTimer=setTimeout(()=>no(new Error('Guarded batch did not reach its lock checkpoint.')),5000)})
  const firstBatch=processSql("set role service_role;set request.jwt.claim.role='service_role';begin;select public.service_claim_guarded_operational_email_batch('general',1);select pg_sleep(1);commit;",out=>{if(out.includes(id(250))||out.includes(id(251))){clearTimeout(batchTimer);batchReady()}})
  await batchCheckpoint
  check(JSON.parse(service("select public.service_claim_guarded_operational_email_batch('general',1)")).length,0,'Concurrent guarded batch observes lane lock without duplicate claim')
  check(JSON.parse(service('select public.service_claim_notification_batch(10)')).length,0,'Concurrent old caller cannot claim guarded batch or bypass cutover')
  check((await firstBatch).code,0,'Atomic first batch finishes')
  check(JSON.parse(service("select public.service_claim_guarded_operational_email_batch('general',1)")).length,1,'Next guarded batch can claim unrelated remaining job')
  check(Number(sql(`select count(*) from private.operational_email_delivery_ledger where job_id in('${id(250)}','${id(251)}') and event='audience'`)),2,'Mixed-version race retains one audience per claimed job')
  sql(read('supabase/tests/operational_email_cutover_observation.sql'));checks+=1
  reject(`update private.operational_email_delivery_ledger set created_at=now();`,'42501')
  reject(`delete from private.operational_email_delivery_ledger;`,'P0001',false)
  check(sql('select count(*) from public.time_events'),'1','Punch preserved')
  check(sql('select minutes from private.payroll_rows'),'480','Payroll preserved')
  sql(`insert into public.employees select ('22000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'active','guard' from generate_series(1,100000)n;
    insert into private.employee_contacts select id,'scale-'||id||'@example.test',null from public.employees where id::text like '22000000%';analyze public.employees;analyze private.employee_contacts;`)
  const statement=`select 1 from public.employees e join private.employee_contacts c on c.employee_id=e.id where e.status in('active','leave') and private.preferred_delivery_email(c.personal_email,c.company_email)='updated@example.test' and e.id<>'${id(1)}'`
  check(sql("select to_regclass('private.operational_email_current_address_idx') is not null"),'t','Migration installs measured private lookup index')
  sql('drop index private.operational_email_current_address_idx;')
  const beforePlan=JSON.parse(sql(`explain(analyze,format json,timing off) ${statement}`))[0]
  sql('create index operational_email_current_address_idx on private.employee_contacts(private.preferred_delivery_email(personal_email,company_email));analyze private.employee_contacts;')
  const afterPlan=JSON.parse(sql(`explain(analyze,format json,timing off) ${statement}`))[0]
  check(JSON.stringify(afterPlan).includes('operational_email_current_address_idx'),true,'Canonical address ambiguity lookup uses tested expression index')
  console.log(JSON.stringify({checks,passed:true,productionConnections:0,scaleRows:100000,addressLookupMs:{unindexed:beforePlan['Execution Time'],indexed:afterPlan['Execution Time']}}))
} catch(error) {failure=error;throw error} finally {stopIsolatedPostgres({data,run,started,priorError:failure})}
