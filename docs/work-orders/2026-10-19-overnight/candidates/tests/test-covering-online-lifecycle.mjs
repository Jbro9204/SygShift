import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const psql='C:/Program Files/PostgreSQL/18/bin/psql.exe';
const out='tmp/timekeeping-diagnostics-20261019/online-lifecycle/';fs.mkdirSync(out,{recursive:true});
const candidate='docs/work-orders/2026-10-19-overnight/candidates/';
const env={...process.env,PGOPTIONS:'-c statement_timeout=30s -c lock_timeout=2s -c application_name=codex-local-covering-lifecycle'};
const args=['-X','-w','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','55439','-U','codex_task','-d','overnight_recovery_fixture_v2_20261019'];
const run=(label,sql,{fail=false,options=env.PGOPTIONS}={})=>{
 const file=out+label+'.sql';fs.writeFileSync(file,sql);
 const r=spawnSync(psql,[...args,'-A','-t','-f',file],{env:{...env,PGOPTIONS:options},encoding:'utf8',timeout:45000});
 fs.writeFileSync(out+label+'-stdout.txt',r.stdout??'');fs.writeFileSync(out+label+'-stderr.txt',r.stderr??'');
 const expected=fail?r.status!==0:r.status===0;
 if(!expected)throw new Error(`${label}: unexpected psql status ${r.status}; inspect protected evidence`);
 return (r.stdout??'').trim();
};
const guard=`do $local$ begin if current_database()<>'overnight_recovery_fixture_v2_20261019' or inet_server_addr()<>inet '127.0.0.1' or inet_server_port()<>55439 or current_user<>'codex_task' then raise exception 'Isolated local fixture target refused';end if;end $local$;\n`;
const signatures=['private.get_effective_time_events(uuid)','private.get_timekeeping_review_base(date,date)','private.get_timekeeping_review_operations_base(date,date)','private.get_timekeeping_review_pre_payroll_week_allocation(date,date)','private.get_timekeeping_review_preferred_name_boundary_base(date,date)','public.get_timekeeping_review(date,date)'];
const sqlList=signatures.map(s=>`'${s}'::regprocedure`).join(',');
const original=JSON.parse(run('00-snapshot',guard+`select jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'definition',pg_get_functiondef(oid),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'hash',md5(pg_get_functiondef(oid))) order by oid::regprocedure::text) from pg_proc where oid in (${sqlList});`).split('\n').find(x=>x.startsWith('[')));
const sourceFiles=['20261019230425_materialize_effective_time_event_candidate_priority','20261019230743_collect_timekeeping_review_rows_once','20261019234005_group_timekeeping_payroll_categories_by_employee','20261019235117_materialize_timekeeping_occurrence_gaps'];
const strip=sql=>sql.replace(/^(begin|commit|rollback);[ \t]*\r?$/gim,'');
const indexSource=fs.readFileSync(candidate+'20261020001516_cover_active_shift_timekeeping_candidates.sql','utf8');
const recoverySource=fs.readFileSync(candidate+'20261020002135_recover_active_shift_timekeeping_covering_index.sql','utf8');
const results=[];
const cleanLedger=()=>run('zz-remove-only-fixture-ledger',guard+`do $cleanup$ begin if exists(select 1 from supabase_migrations.schema_migrations where version='20261020001516' and (name<>'cover_active_shift_timekeeping_candidates' or statements is distinct from array[$s$${indexSource}$s$])) or exists(select 1 from supabase_migrations.schema_migrations where version='20261020002135' and (name<>'recover_active_shift_timekeeping_covering_index' or statements is distinct from array[$r$${recoverySource}$r$])) then raise exception 'Fixture ledger teardown source drift';end if;end $cleanup$; delete from supabase_migrations.schema_migrations where version in ('20261020001516','20261020002135');`);
let reader;
const openReader=async()=>{
 reader=spawn(psql,[...args,'-A','-t'],{env,stdio:['pipe','pipe','pipe']});
 reader.stderr.on('data',()=>{});
 await new Promise((resolve,reject)=>{let data='';const timer=setTimeout(()=>reject(new Error('Local old-snapshot setup timed out')),5000);reader.stdout.on('data',d=>{data+=d.toString();if(data.includes('LOCAL_SNAPSHOT_READY')){clearTimeout(timer);resolve();}});reader.once('error',reject);reader.stdin.write(guard+'begin isolation level repeatable read read only;\nselect count(*) from public.shifts;\n\\echo LOCAL_SNAPSHOT_READY\n');});
};
const closeReader=async()=>{reader.stdin.end('rollback;\n\\q\n');await new Promise(resolve=>reader.once('exit',resolve));reader=null;};
const assertInvalid=label=>{const text=run(label,guard+`select jsonb_build_object('exists',to_regclass('public.shifts_timekeeping_candidate_cover_idx') is not null,'valid',(select indisvalid from pg_index where indexrelid=to_regclass('public.shifts_timekeeping_candidate_cover_idx')),'ready',(select indisready from pg_index where indexrelid=to_regclass('public.shifts_timekeeping_candidate_cover_idx')),'live',(select indislive from pg_index where indexrelid=to_regclass('public.shifts_timekeeping_candidate_cover_idx')));`);if(JSON.parse(text.split('\n').find(x=>x.startsWith('{'))).valid!==false)throw new Error('Real interrupted index must be invalid');};
try {
 run('01-install-exact-production-patches',guard+'begin;\n'+sourceFiles.map(s=>strip(fs.readFileSync('supabase/migrations/'+s+'.sql','utf8'))).join('\n')+'\ncommit;');
 const metadata=JSON.parse(run('02-installed-metadata',guard+`select jsonb_agg(jsonb_build_object('identity',oid::regprocedure::text,'source_hash',md5(pg_get_functiondef(oid)),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'config',proconfig,'security_definer',prosecdef,'volatility',provolatile::text,'defaults',proargdefaults::text) order by oid::regprocedure::text) from pg_proc where oid in (${sqlList});`).split('\n').find(x=>x.startsWith('[')));
 metadata.forEach(x=>{if(x.identity==='get_timekeeping_review(date,date)')x.identity='public.'+x.identity;});
 const adapt=file=>fs.readFileSync(candidate+file,'utf8')
  .replace('set role postgres;','set role codex_task;\n'+guard)
  .replaceAll("current_database()<>'postgres' or current_user<>'postgres' or inet_server_port()<>5432","current_database()<>'overnight_recovery_fixture_v2_20261019' or current_user<>'codex_task' or inet_server_port()<>55439")
  .replaceAll("where oid='public.shifts'::regclass)<>'postgres'","where oid='public.shifts'::regclass)<>'codex_task'")
  .replace(/ if \(select count\(\*\) from pg_roles[^\n]+\n/g,' -- Global production role timeout defaults are not included in the restored fixture.\n')
  .replaceAll("candidate.owner<>'postgres'","candidate.owner<>'codex_task'")
  .replace(/\$expected\$\[.*?\]\$expected\$/g,`$expected$${JSON.stringify(metadata)}$expected$`)
  .replaceAll('\\ir 20261020001516_cover_active_shift_timekeeping_candidates.sql',`\\i '${path.resolve(candidate+'20261020001516_cover_active_shift_timekeeping_candidates.sql').replaceAll('\\','/')}'`)
  .replaceAll('\\ir 20261020002135_recover_active_shift_timekeeping_covering_index.sql',`\\i '${path.resolve(candidate+'20261020002135_recover_active_shift_timekeeping_covering_index.sql').replaceAll('\\','/')}'`);
 run('03-production-target-negative',fs.readFileSync(candidate+'covering-index-preflight.sql','utf8'),{fail:true});results.push('production target refuses local fixture');
 run('04-preflight',adapt('covering-index-preflight.sql'));results.push('healthy absent preflight');
 run('05-build-and-ledger',adapt('covering-index-release.psql'));results.push('standalone concurrent build, exact valid verification, atomic ledger');
 run('06-duplicate-release-refused',adapt('covering-index-release.psql'),{fail:true});results.push('duplicate release refuses');
 run('07-applied-cleanup-refused',adapt('covering-index-failed-build-cleanup.psql'),{fail:true});results.push('unledgered cleanup refuses applied index');
 run('08-forward-recovery',adapt('covering-index-forward-recovery.psql'));results.push('fresh forward recovery drops index and retains original ledger');
 run('09-repeat-recovery-refused',adapt('covering-index-forward-recovery.psql'),{fail:true});results.push('repeat recovery refuses');
 cleanLedger();
 run('10-function-drift-refused',adapt('covering-index-preflight.sql').replace('e4e6ab15b4a6bdca294cc4d250398396','00000000000000000000000000000000'),{fail:true});results.push('source drift refuses before build');
 run('11-build-only',guard+indexSource);
 run('12-resume-build-ledger',adapt('covering-index-resume-ledger.psql'));results.push('valid unledgered interrupted build resumes ledger without DDL');
 run('13-drop-only',guard+recoverySource);
 run('14-resume-drop-ledger',adapt('covering-index-resume-recovery-ledger.psql'));results.push('ambiguous completed drop resumes recovery ledger');
 cleanLedger();
 run('15-build-unledgered',guard+indexSource);
 run('16-clean-unledgered-valid',adapt('covering-index-failed-build-cleanup.psql'));results.push('exact unledgered valid candidate cleanup');
 // Keep a real local old snapshot open so concurrent build times out during
 // snapshot validation and leaves a real invalid index for guarded cleanup.
 reader=spawn(psql,[...args,'-A','-t'],{env,stdio:['pipe','pipe','pipe']});
 let stderr='';reader.stderr.on('data',d=>stderr+=d.toString());
 await new Promise((resolve,reject)=>{
  let data='';const timer=setTimeout(()=>reject(new Error('Local old-snapshot setup timed out')),5000);
  reader.stdout.on('data',d=>{data+=d.toString();if(data.includes('LOCAL_SNAPSHOT_READY')){clearTimeout(timer);resolve();}});
  reader.once('error',reject);reader.stdin.write(guard+'begin isolation level repeatable read read only;\nselect count(*) from public.shifts;\n\\echo LOCAL_SNAPSHOT_READY\n');
 });
 run('17-real-concurrent-build-timeout',indexSource,{fail:true,options:'-c statement_timeout=500ms -c lock_timeout=2s -c application_name=codex-local-covering-failure'});
 reader.stdin.end('rollback;\n\\q\n');await new Promise(resolve=>reader.once('exit',resolve));reader=null;fs.writeFileSync(out+'17-reader-stderr.txt',stderr);
 const invalid=run('18-invalid-proof',guard+`select jsonb_build_object('exists',to_regclass('public.shifts_timekeeping_candidate_cover_idx') is not null,'valid',(select indisvalid from pg_index where indexrelid=to_regclass('public.shifts_timekeeping_candidate_cover_idx')));`);
 if(JSON.parse(invalid.split('\n').find(x=>x.startsWith('{'))).valid!==false)throw new Error('Expected real invalid concurrent build was not observed');
 run('19-invalid-cleanup',adapt('covering-index-failed-build-cleanup.psql'));results.push('real timed-out concurrent build leaves invalid index; exact guarded concurrent cleanup succeeds');
 run('19b-unledgered-build-for-interrupted-drop',guard+indexSource);
 await openReader();
 run('19c-cancel-unledgered-drop',adapt('covering-index-failed-build-cleanup.psql').replace('drop index concurrently public.shifts_timekeeping_candidate_cover_idx;',"set statement_timeout='500ms';\ndrop index concurrently public.shifts_timekeeping_candidate_cover_idx;"),{fail:true});
 await closeReader();assertInvalid('19d-invalid-unledgered-drop-proof');
 run('19e-resume-unledgered-drop',adapt('covering-index-failed-build-cleanup.psql'));results.push('real canceled unledgered concurrent drop leaves invalid target; exact cleanup retry succeeds');
 run('19f-installed-build-for-interrupted-drop',adapt('covering-index-release.psql'));
 await openReader();
 run('19g-cancel-installed-forward-drop',adapt('covering-index-forward-recovery.psql').replace(/\\i ('[^\n]+recover_active_shift_timekeeping_covering_index.sql')/,"set statement_timeout='500ms';\n\\i $1"),{fail:true});
 await closeReader();assertInvalid('19h-invalid-installed-drop-proof');
 run('19i-resume-installed-forward-drop',adapt('covering-index-forward-recovery.psql'));results.push('real canceled installed forward drop leaves invalid target; exact forward retry succeeds and retains original ledger');
 cleanLedger();
 // An unrelated invalid index must block recovery; it is never exempted.
 run('19j-unledgered-build-with-other-index',guard+indexSource);
 await openReader();
 run('19k-create-unrelated-invalid',indexSource.replaceAll('shifts_timekeeping_candidate_cover_idx','sygshift_local_unrelated_invalid_idx'),{fail:true,options:'-c statement_timeout=500ms -c lock_timeout=2s -c application_name=sygshift-local-unrelated-index'});
 await closeReader();
 run('19l-unrelated-invalid-refused',adapt('covering-index-failed-build-cleanup.psql'),{fail:true});results.push('unrelated invalid shift index blocks cleanup despite exact target exemption');
 run('19m-remove-only-unrelated-fixture-index',guard+'drop index concurrently public.sygshift_local_unrelated_invalid_idx;');
 run('19n-clean-exact-target-after-unrelated-removed',adapt('covering-index-failed-build-cleanup.psql'));
 // Wrong same-name object must not be dropped.
 run('20-wrong-index',guard+'create index shifts_timekeeping_candidate_cover_idx on public.shifts(schedule_id);');
 run('21-wrong-index-cleanup-refused',adapt('covering-index-failed-build-cleanup.psql'),{fail:true});results.push('wrong same-name index refuses cleanup');
 run('22-remove-only-local-wrong-index',guard+'drop index concurrently public.shifts_timekeeping_candidate_cover_idx;');
} finally {
 if(reader){reader.stdin.end('rollback;\n\\q\n');await new Promise(resolve=>reader.once('exit',resolve));}
 cleanLedger();
 run('97-remove-only-fixture-index-if-present',guard+`do $index$ begin if to_regclass('public.shifts_timekeeping_candidate_cover_idx') is not null and (select pg_get_indexdef(to_regclass('public.shifts_timekeeping_candidate_cover_idx'))) not in ('CREATE INDEX shifts_timekeeping_candidate_cover_idx ON public.shifts USING btree (id) INCLUDE (starts_at, ends_at, schedule_id) WHERE (canceled_at IS NULL)','CREATE INDEX shifts_timekeeping_candidate_cover_idx ON public.shifts USING btree (schedule_id)') then raise exception 'Fixture index teardown source drift';end if;end $index$;\ndrop index concurrently if exists public.shifts_timekeeping_candidate_cover_idx;`);
 // Local teardown preserves exact original function bodies and all ownership/ACLs.
 run('98-restore-clone-functions',guard+'begin;\n'+original.map(x=>x.definition+';').join('\n')+'\ncommit;');
 const after=JSON.parse(run('99-final-state-proof',guard+`select jsonb_build_object('indexAbsent',to_regclass('public.shifts_timekeeping_candidate_cover_idx') is null,'reservedLedgerAbsent',not exists(select 1 from supabase_migrations.schema_migrations where version in ('20261020001516','20261020002135')),'functions',(select jsonb_agg(jsonb_build_object('signature',oid::regprocedure::text,'definition',pg_get_functiondef(oid),'owner',pg_get_userbyid(proowner),'acl',proacl::text,'hash',md5(pg_get_functiondef(oid))) order by oid::regprocedure::text) from pg_proc where oid in (${sqlList})));`).split('\n').find(x=>x.startsWith('{')));
 if(!after.indexAbsent||!after.reservedLedgerAbsent||JSON.stringify(after.functions)!==JSON.stringify(original))throw new Error('Local fixture teardown mismatch');
 results.push('clone exact six definitions/owners/ACLs restored, candidate index and both test ledger versions absent');
 fs.writeFileSync(out+'summary.json',JSON.stringify({at:new Date().toISOString(),passed:results,localOnly:true,adaptation:'Target and owner/ACL/default metadata adapted to isolated restored PG18 fixture; exact four deployed function patches installed before tests. Production source guards unchanged in original artifacts. No business record mutation.'},null,2)+'\n');
}
console.log(JSON.stringify({passed:results.length,summary:out+'summary.json'}));
