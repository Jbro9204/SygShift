-- TRANSACTION BODY after the urgent candidate. No window edits, provider calls,
-- committed records, role grants, payroll/punch/schedule/identity changes.
-- One minimal new absence and its downstream queue/history records are rolled
-- back. Trace/transport evidence must be reviewed before using this harness.
set local statement_timeout='30s';
set local lock_timeout='2s';
set local plpgsql.check_asserts=on;
create temporary table urgent_hosted_results(test_case text primary key,passed boolean not null) on commit drop;
grant insert,select on pg_temp.urgent_hosted_results to authenticated,service_role;
create temporary table urgent_immutable_before on commit drop as
select 'time_events'::text as relation_name,count(*) as count,md5(string_agg(to_jsonb(item)::text,'|' order by id)) as row_hash from public.time_events item
union all select 'employees',count(*),md5(string_agg(to_jsonb(item)::text,'|' order by id)) from public.employees item
union all select 'maintenance_windows',count(*),md5(string_agg(to_jsonb(item)::text,'|' order by id)) from public.maintenance_windows item;
do $anchors$
declare actor record;
begin
 assert exists(select 1 from public.maintenance_windows where status='scheduled' and starts_at<=now() and ends_at>now() and 'time_attendance'=any(feature_codes) and access_mode in ('read_only','unavailable')),'An actually active time-attendance window is required.';
 perform set_config('sygshift.push_kicked','yes',true);
 select employee.id,account.auth_user_id,shift.id as shift_id into actor
 from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
 join public.shift_assignments assignment on assignment.employee_id=employee.id
 join public.shifts shift on shift.id=assignment.shift_id join public.schedules schedule on schedule.id=shift.schedule_id
 where employee.role='guard' and employee.status='active' and account.disabled_at is null
 and assignment.status in ('assigned','confirmed') and assignment.canceled_at is null and schedule.status='published'
 and shift.canceled_at is null and shift.ends_at>clock_timestamp()
 and private.canonical_attendance_call_off_report(employee.id,shift.id) is null
 and private.canonical_attendance_accountability_event(employee.id,shift.id,'call_off') is null
 order by employee.id,shift.id limit 1;
 assert actor.id is not null,'A fresh own-assignment anchor is required.';
 perform set_config('sygshift.urgent_employee',actor.id::text,true);
 perform set_config('sygshift.urgent_auth_user',actor.auth_user_id::text,true);
 perform set_config('sygshift.urgent_shift',actor.shift_id::text,true);
 perform set_config('sygshift.urgent_nonurgent_event',(select id::text from public.attendance_accountability_events where event_type='late_arrival' limit 1),true);
 perform set_config('sygshift.urgent_shift_hash',(select md5(to_jsonb(shift)::text) from public.shifts shift where id=actor.shift_id),true);
end;
$anchors$;
set local role authenticated;
do $unlinked$
begin
 perform set_config('request.jwt.claims','{"role":"authenticated","aal":"aal1"}',true);
 begin perform public.report_attendance_accountability_event(null,'called_in_sick',current_date,'Rollback-only unlinked denial');raise exception 'Unlinked issuer accepted';exception when insufficient_privilege then null;end;
 insert into pg_temp.urgent_hosted_results values('unlinked issuer denied before any capability',true);
end;
$unlinked$;
do $urgent_employee$
declare result jsonb;replay jsonb;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 assert public.current_employee_id()=current_setting('sygshift.urgent_employee')::uuid and not public.has_mfa();
 result:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift')::uuid,'called_in_sick',null,'Rollback-only maintenance-path verification; no provider call');
 assert result->>'id' is not null and result->>'callOffId' is not null and result->>'created'='true';
 perform set_config('sygshift.urgent_event',result->>'id',true);
 perform set_config('sygshift.urgent_report',result->>'callOffId',true);
 replay:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift')::uuid,'call_off',null,'Rollback-only idempotency verification');
 assert replay->>'id'=result->>'id' and replay->>'callOffId'=result->>'callOffId' and replay->>'alreadyRecorded'='true';
 begin perform public.service_mark_attendance_accountability_dispatch_result((result->>'id')::uuid,true,null);raise exception 'Employee called service marker';exception when insufficient_privilege then null;end;
 begin perform public.record_time_event(null);raise exception 'Missing clock kind accepted';exception when check_violation then assert sqlerrm='A time event kind is required.';end;
 insert into pg_temp.urgent_hosted_results values('active window: employee AAL1 full sick/call-off chain and idempotency allowed; clock boundary reachable',true);
end;
$urgent_employee$;
reset role;
do $chain_evidence$
begin
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 assert exists(select 1 from public.attendance_accountability_event_actions where event_id=current_setting('sygshift.urgent_event')::uuid and action='created' and actor_id=current_setting('sygshift.urgent_employee')::uuid);
 assert exists(select 1 from public.call_off_report_actions where call_off_report_id=current_setting('sygshift.urgent_report')::uuid and action='created' and actor_id=current_setting('sygshift.urgent_employee')::uuid);
 assert exists(select 1 from public.operational_alerts where related_record_type='call_off_report' and related_record_id=current_setting('sygshift.urgent_report')::uuid);
 assert exists(select 1 from private.notification_outbox where aggregate_type='call_off_report' and aggregate_id=current_setting('sygshift.urgent_report')::uuid and message_type='call_off_supervisor_alert');
 begin update public.attendance_accountability_events set note='Forbidden direct update' where id=current_setting('sygshift.urgent_event')::uuid;raise exception 'Direct update bypassed maintenance';exception when insufficient_privilege then null;end;
 begin update public.call_off_reports set reason='Forbidden direct update' where id=current_setting('sygshift.urgent_report')::uuid;raise exception 'Direct call-off update bypassed maintenance';exception when insufficient_privilege then null;end;
 set constraints private.urgent_capability_cleanup_required immediate;
 set constraints private.urgent_capability_cleanup_required deferred;
 insert into pg_temp.urgent_hosted_results values('created history/actions/alert/supervisor queue retained; direct writes blocked; capability cleaned',true);
end;
$chain_evidence$;
set local role service_role;
do $service_result$
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 assert public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event')::uuid,false,'Rollback-only simulated failed result; no email sent');
 assert public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event')::uuid,true,null);
 begin perform public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_nonurgent_event')::uuid,true,null);raise exception 'Nonurgent marker bypassed maintenance';exception when insufficient_privilege then null;end;
 insert into pg_temp.urgent_hosted_results values('separate service simulated delivery-result contract allowed only for urgent evidence',true);
end;
$service_result$;
set local role authenticated;
do $replay_after_mark$
declare result jsonb;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 result:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift')::uuid,'called_in_sick',null,'Rollback-only post-marker replay');
 assert result->>'alreadyRecorded'='true' and result->>'dispatchAlreadyNotified'='true';
 insert into pg_temp.urgent_hosted_results values('Worker retry contract observes completed Dispatch marker',true);
end;
$replay_after_mark$;
reset role;
do $preservation$
declare original record;actual_count bigint;actual_hash text;
begin
 for original in select * from pg_temp.urgent_immutable_before loop
   execute format('select count(*),md5(string_agg(to_jsonb(item)::text,''|'' order by id)) from public.%I item',original.relation_name) into actual_count,actual_hash;
   assert actual_count=original.count and actual_hash is not distinct from original.row_hash,'A protected table changed: '||original.relation_name;
 end loop;
 assert (select md5(to_jsonb(shift)::text)=current_setting('sygshift.urgent_shift_hash') from public.shifts shift where id=current_setting('sygshift.urgent_shift')::uuid);
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 assert not has_table_privilege('service_role','private.employee_urgent_maintenance_capabilities','SELECT,INSERT,UPDATE,DELETE');
 assert not has_table_privilege('authenticated','private.employee_urgent_maintenance_capabilities','SELECT,INSERT,UPDATE,DELETE');
 set constraints private.urgent_capability_cleanup_required immediate;
 insert into pg_temp.urgent_hosted_results values('all punch/employee/window rows and assigned shift unchanged; capabilities empty and sealed',true);
end;
$preservation$;
select jsonb_build_object(
 'tests',(select jsonb_agg(to_jsonb(result) order by test_case) from pg_temp.urgent_hosted_results result),
 'functions',(select jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'hash',md5(pg_get_functiondef(p.oid)),'owner',r.rolname,'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef) order by p.oid::regprocedure::text)
  from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid in ('private.enforce_maintenance_feature_write()'::regprocedure,'public.report_attendance_accountability_event(uuid,text,date,text)'::regprocedure,'public.service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)'::regprocedure,'private.employee_urgent_maintenance_write_allowed(text,text,text,jsonb,jsonb)'::regprocedure,'private.require_urgent_capability_cleanup()'::regprocedure)),
 'immutable_counts',(select jsonb_agg(jsonb_build_object('relation',relation_name,'rows',count,'hash',row_hash) order by relation_name) from pg_temp.urgent_immutable_before)
) as urgent_maintenance_rehearsal;
