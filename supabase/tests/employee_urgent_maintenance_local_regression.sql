-- TRANSACTION BODY. Local restored fixture only, AFTER candidate, one BEGIN /
-- final ROLLBACK. Reactivates only the cloned local maintenance row.
do $guard$
begin
 if current_database()<>'overnight_recovery_fixture_v2_20261019' or inet_server_addr() is distinct from inet '127.0.0.1' or inet_server_port() is distinct from 55439 then raise exception 'Local restored fixture only'; end if;
end;
$guard$;
set local plpgsql.check_asserts=on;
set local statement_timeout='30s';
set local lock_timeout='2s';
create temporary table urgent_regression_results(test_case text primary key,passed boolean not null) on commit drop;
grant insert,select on pg_temp.urgent_regression_results to authenticated,service_role;

do $setup$
declare actor record; selected_shifts uuid[]; admin_user uuid;admin_employee uuid;canonical_event uuid;
begin
 perform set_config('sygshift.push_kicked','yes',true);
 select employee.id,account.auth_user_id into actor
 from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
 where employee.role='guard' and employee.status='active' and account.disabled_at is null and (
   select count(*) from public.shift_assignments assignment join public.shifts shift on shift.id=assignment.shift_id join public.schedules schedule on schedule.id=shift.schedule_id
   where assignment.employee_id=employee.id and assignment.status in ('assigned','confirmed') and assignment.canceled_at is null
     and schedule.status='published' and shift.canceled_at is null and shift.ends_at>clock_timestamp()
     and private.canonical_attendance_call_off_report(employee.id,shift.id) is null
     and private.canonical_attendance_accountability_event(employee.id,shift.id,'call_off') is null
 )>=4 order by employee.id limit 1;
 assert actor.id is not null,'Four fresh own-assignment anchors are required.';
 perform set_config('sygshift.urgent_employee',actor.id::text,true);
 perform set_config('sygshift.urgent_auth_user',actor.auth_user_id::text,true);
 select array_agg(id order by id) into selected_shifts from (
   select distinct shift.id from public.shift_assignments assignment join public.shifts shift on shift.id=assignment.shift_id join public.schedules schedule on schedule.id=shift.schedule_id
   where assignment.employee_id=actor.id and assignment.status in ('assigned','confirmed') and assignment.canceled_at is null
     and schedule.status='published' and shift.canceled_at is null and shift.ends_at>clock_timestamp()
     and private.canonical_attendance_call_off_report(actor.id,shift.id) is null
     and private.canonical_attendance_accountability_event(actor.id,shift.id,'call_off') is null
   order by shift.id limit 4
 ) shifts;
 perform set_config('sygshift.urgent_shift_1',selected_shifts[1]::text,true);
 perform set_config('sygshift.urgent_shift_2',selected_shifts[2]::text,true);
 perform set_config('sygshift.urgent_shift_3',selected_shifts[3]::text,true);
 perform set_config('sygshift.urgent_shift_4',selected_shifts[4]::text,true);
 select account.auth_user_id,employee.id into admin_user,admin_employee from private.employee_accounts account join public.employees employee on employee.id=account.employee_id where employee.role='admin' and employee.status='active' and account.disabled_at is null limit 1;
 perform set_config('sygshift.urgent_admin_user',admin_user::text,true);
 perform set_config('sygshift.urgent_nonurgent_event',(select id::text from public.attendance_accountability_events where event_type='late_arrival' limit 1),true);
 assert nullif(current_setting('sygshift.urgent_nonurgent_event',true),'') is not null,'A nonurgent marker-denial anchor is required.';
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',admin_user)::text,true);
 insert into public.attendance_accountability_events(employee_id,shift_id,event_type,status,operational_date,starts_at,ends_at,source,note,created_by)
 select actor.id,shift.id,'no_call_no_show','reported',(shift.starts_at at time zone shift.time_zone)::date,shift.starts_at,shift.ends_at,'scheduler','Local preexisting canonical absence fixture',admin_employee
 from public.shifts shift where shift.id=selected_shifts[3] returning id into canonical_event;
 perform set_config('sygshift.urgent_canonical_event',canonical_event::text,true);
 update public.maintenance_windows set starts_at=clock_timestamp()-interval '1 minute',ends_at=clock_timestamp()+interval '1 hour'
 where id=(select id from public.maintenance_windows where status='scheduled' and 'time_attendance'=any(feature_codes) and access_mode in ('read_only','unavailable') order by starts_at desc limit 1);
 assert found,'The production-cloned local maintenance window is required.';
 assert exists(select 1 from public.maintenance_windows where status='scheduled' and starts_at<clock_timestamp() and ends_at>clock_timestamp() and 'time_attendance'=any(feature_codes) and not 'time_clock'=any(feature_codes));
end;
$setup$;

do $sealed_and_forged$
declare payload jsonb;capability_id uuid; variant text; actor uuid:=current_setting('sygshift.urgent_employee')::uuid;
begin
 assert not has_table_privilege('authenticated','private.employee_urgent_maintenance_capabilities','SELECT,INSERT,UPDATE,DELETE');
 assert not has_table_privilege('service_role','private.employee_urgent_maintenance_capabilities','SELECT,INSERT,UPDATE,DELETE');
 assert not has_function_privilege('authenticated','private.employee_urgent_maintenance_write_allowed(text,text,text,jsonb,jsonb)','EXECUTE');
 assert not has_function_privilege('service_role','private.employee_urgent_maintenance_write_allowed(text,text,text,jsonb,jsonb)','EXECUTE');
 assert not has_function_privilege('anon','private.require_urgent_capability_cleanup()','EXECUTE');
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 payload:=jsonb_build_object('id',gen_random_uuid(),'employee_id',actor,'shift_id',null,'created_by',actor,'source','employee','event_type','called_in_sick','operational_date',current_date,'status','reported');
 perform set_config('sygshift.urgent_maintenance_capability','true',true);
 perform set_config('sygshift.maintenance_bypass','employee_urgent_absence',true);
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,payload),'A forged GUC became authority.';
 foreach variant in array array['backend','transaction','auth','employee'] loop
   capability_id:=gen_random_uuid();
   insert into private.employee_urgent_maintenance_capabilities(id,backend_pid,transaction_id,scope,auth_user_id,employee_id,operational_date,requested_event_type,event_type)
   values(capability_id,pg_backend_pid()+case when variant='backend' then 1 else 0 end,
     case when variant='transaction' then '1'::xid8 else pg_current_xact_id() end,'employee_urgent_absence',
     case when variant='auth' then gen_random_uuid() else auth.uid() end,
     case when variant='employee' then gen_random_uuid() else actor end,current_date,'called_in_sick','called_in_sick');
   assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,payload),'Mismatched capability accepted: '||variant;
   delete from private.employee_urgent_maintenance_capabilities where id=capability_id;
 end loop;
 capability_id:=gen_random_uuid();
 insert into private.employee_urgent_maintenance_capabilities(id,backend_pid,transaction_id,scope,auth_user_id,employee_id,operational_date,requested_event_type,event_type)
 values(capability_id,pg_backend_pid(),pg_current_xact_id(),'employee_urgent_absence',auth.uid(),actor,current_date,'called_in_sick','called_in_sick');
 assert private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,payload);
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,payload||jsonb_build_object('employee_id',gen_random_uuid()));
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,payload||jsonb_build_object('shift_id',gen_random_uuid()));
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','INSERT',null,payload||'{"event_type":"no_call_no_show"}');
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','UPDATE',payload,payload||'{"status":"resolved"}');
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','DELETE',payload,null);
 assert not private.employee_urgent_maintenance_write_allowed('public','time_events','INSERT',null,payload);
 delete from private.employee_urgent_maintenance_capabilities where id=capability_id;
 begin
   insert into private.employee_urgent_maintenance_capabilities(id,backend_pid,transaction_id,scope,auth_user_id,employee_id,operational_date,requested_event_type,event_type)
   values(gen_random_uuid(),pg_backend_pid(),pg_current_xact_id(),'employee_urgent_absence',auth.uid(),actor,current_date,'called_in_sick','called_in_sick');
   set constraints private.urgent_capability_cleanup_required immediate;
   raise exception 'A capability survived its transaction boundary check';
 exception when check_violation then
   assert sqlerrm='An employee urgent maintenance capability cannot survive its RPC transaction.';
 end;
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 insert into pg_temp.urgent_regression_results values('sealed ACLs; forged GUC and mismatched backend/transaction/auth/employee denied; commit leak rejected',true);
end;
$sealed_and_forged$;

set local role authenticated;
do $employee_flow$
declare result jsonb;replay jsonb;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 assert public.current_employee_id()=current_setting('sygshift.urgent_employee')::uuid and not public.has_mfa();
 result:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift_1')::uuid,'called_in_sick',null,'Local active-maintenance sick report');
 assert result->>'id' is not null and result->>'callOffId' is not null and result->>'created'='true';
 perform set_config('sygshift.urgent_event_1',result->>'id',true);
 perform set_config('sygshift.urgent_report_1',result->>'callOffId',true);
 replay:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift_1')::uuid,'call_off',null,'Idempotent local urgent replay');
 assert replay->>'id'=result->>'id' and replay->>'callOffId'=result->>'callOffId' and replay->>'alreadyRecorded'='true';
 result:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift_2')::uuid,'call_off',null,'Local active-maintenance call-off report');
 assert result->>'id' is not null and result->>'callOffId' is not null;
 perform set_config('sygshift.urgent_report_2',result->>'callOffId',true);
 result:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift_3')::uuid,'called_in_sick',null,'Local self-report against canonical absence');
 assert result->>'id'=current_setting('sygshift.urgent_canonical_event') and result->>'eventType'='no_call_no_show' and result->>'callOffId' is not null;
 result:=public.report_attendance_accountability_event(null,'called_in_sick',current_date,'Local date-only urgent report');
 assert result->>'id' is not null and result->>'callOffId' is null;
 assert public.get_time_off_request_context(current_date,current_date)#>>'{employee,id}'=public.current_employee_id()::text;
 begin perform public.record_time_event(null); raise exception 'Null clock kind accepted'; exception when check_violation then assert sqlerrm='A time event kind is required.'; end;
 insert into pg_temp.urgent_regression_results values('active maintenance: employee AAL1 full sick/call-off/date flow and idempotency pass; clock boundary available',true);
end;
$employee_flow$;
reset role;

do $marker_baseline$
begin
 perform set_config('sygshift.urgent_business_hash',(select md5((to_jsonb(event)-array['dispatch_notified_at','dispatch_notification_error','updated_at'])::text) from public.attendance_accountability_events event where id=current_setting('sygshift.urgent_event_1')::uuid),true);
end;
$marker_baseline$;
set local role authenticated;
do $marker_acl$
begin
 begin perform public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event_1')::uuid,true,null);raise exception 'Employee called service-only marker';exception when insufficient_privilege then null;end;
end;
$marker_acl$;
set local role service_role;
do $marker_result$
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 assert public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event_1')::uuid,false,'Local transient Dispatch result');
 assert public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event_1')::uuid,true,null);
 assert public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_canonical_event')::uuid,true,null),'Self-linked canonical absence Dispatch evidence was blocked.';
 assert not public.service_mark_attendance_accountability_dispatch_result(gen_random_uuid(),true,null);
 begin perform public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_nonurgent_event')::uuid,true,null);raise exception 'Nonurgent marker bypassed maintenance';exception when insufficient_privilege then null;end;
 insert into pg_temp.urgent_regression_results values('separate service Dispatch marker records failed/accepted results; nonurgent and employee marker calls denied',true);
end;
$marker_result$;
reset role;
do $accepted_marker$
begin
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 perform set_config('sygshift.urgent_accepted_dispatch_time',(select dispatch_notified_at::text from public.attendance_accountability_events where id=current_setting('sygshift.urgent_event_1')::uuid),true);
 assert nullif(current_setting('sygshift.urgent_accepted_dispatch_time',true),'') is not null;
end;
$accepted_marker$;
set local role service_role;
do $late_marker$
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 assert public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event_1')::uuid,false,'Local late failed result');
end;
$late_marker$;
set local role authenticated;
do $worker_replay$
declare result jsonb;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 result:=public.report_attendance_accountability_event(current_setting('sygshift.urgent_shift_1')::uuid,'called_in_sick',null,'Local replay after accepted Dispatch evidence');
 assert result->>'alreadyRecorded'='true' and result->>'dispatchAlreadyNotified'='true','Worker retry would lose the accepted-delivery stop marker.';
 insert into pg_temp.urgent_regression_results values('accepted Dispatch timestamp survives late failure; employee replay reports already notified',true);
end;
$worker_replay$;
reset role;

do $evidence_and_denials$
declare report public.call_off_reports%rowtype;employee_id uuid:=current_setting('sygshift.urgent_employee')::uuid;event_before jsonb;
begin
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 assert (select dispatch_notified_at::text=current_setting('sygshift.urgent_accepted_dispatch_time') and dispatch_notification_error='Local late failed result'
   and md5((to_jsonb(event)-array['dispatch_notified_at','dispatch_notification_error','updated_at'])::text)=current_setting('sygshift.urgent_business_hash')
   from public.attendance_accountability_events event where id=current_setting('sygshift.urgent_event_1')::uuid);
 assert (select call_off_report_id=current_setting('sygshift.urgent_report_1')::uuid from public.attendance_accountability_events where id=current_setting('sygshift.urgent_event_1')::uuid);
 select * into report from public.call_off_reports where id=current_setting('sygshift.urgent_report_1')::uuid;
 assert report.employee_id=employee_id and report.reported_by=employee_id and report.received_by=employee_id and report.call_off_type='sick';
 assert (select count(*)=1 from public.call_off_report_actions where call_off_report_id=report.id and action='created' and actor_id=employee_id);
 assert exists(select 1 from public.operational_alerts where related_record_type='call_off_report' and related_record_id=report.id and alert_type='employee_call_off');
 begin update public.call_off_reports set reason='Forbidden ordinary direct update' where id=report.id;raise exception 'Direct own report update bypassed maintenance';exception when insufficient_privilege then null;end;
 begin delete from public.call_off_report_actions where call_off_report_id=report.id;raise exception 'Direct action deletion bypassed protection';exception when insufficient_privilege then null;when raise_exception then assert sqlerrm='call_off_report_actions is append-only.';end;
 begin update public.attendance_accountability_events set note='Forbidden ordinary attendance update' where id=current_setting('sygshift.urgent_event_1')::uuid;raise exception 'Direct attendance update bypassed maintenance';exception when insufficient_privilege then null;end;
 begin update public.shifts set notes=coalesce(notes,'')||'Forbidden schedule edit' where id=current_setting('sygshift.urgent_shift_1')::uuid;raise exception 'Schedule edit bypassed maintenance';exception when insufficient_privilege then null;end;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.urgent_admin_user'))::text,true);
 begin
   perform public.report_employee_call_off(employee_id,current_setting('sygshift.urgent_shift_4')::uuid,'other',clock_timestamp(),'Forbidden manager behalf during maintenance',null,true,null);
   raise exception 'Manager behalf operation bypassed maintenance';
 exception when insufficient_privilege then null;end;
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 set constraints private.urgent_capability_cleanup_required immediate;
 set constraints private.urgent_capability_cleanup_required deferred;
 insert into pg_temp.urgent_regression_results values('full linked absence/action/alert evidence retained; direct writes/deletes/schedule/manager-behalf remain blocked; capabilities cleaned',true);
end;
$evidence_and_denials$;

do $service_exact_scope$
declare before_row jsonb;after_row jsonb;capability_id uuid:=gen_random_uuid();marked_at timestamptz:=clock_timestamp();
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 select to_jsonb(event) into before_row from public.attendance_accountability_events event where id=current_setting('sygshift.urgent_event_1')::uuid;
 after_row:=before_row||jsonb_build_object('dispatch_notified_at',marked_at,'dispatch_notification_error',null,'updated_at',marked_at);
 insert into private.employee_urgent_maintenance_capabilities(id,backend_pid,transaction_id,scope,employee_id,operational_date,event_type,attendance_event_id,result_notified_at)
 values(capability_id,pg_backend_pid(),pg_current_xact_id(),'attendance_dispatch_result',current_setting('sygshift.urgent_employee')::uuid,(before_row->>'operational_date')::date,before_row->>'event_type',(before_row->>'id')::uuid,marked_at);
 assert private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','UPDATE',before_row,after_row);
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','UPDATE',before_row,after_row||'{"note":"Forbidden service business edit"}');
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','UPDATE',before_row,after_row||jsonb_build_object('id',gen_random_uuid()));
 assert not private.employee_urgent_maintenance_write_allowed('public','call_off_reports','UPDATE',before_row,after_row);
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 assert not private.employee_urgent_maintenance_write_allowed('public','attendance_accountability_events','UPDATE',before_row,after_row);
 delete from private.employee_urgent_maintenance_capabilities where id=capability_id;
 insert into pg_temp.urgent_regression_results values('valid capabilities reject wrong record/employee/operation/business fields; canonical own absence links and service result allowed',true);
end;
$service_exact_scope$;

create function pg_temp.reject_urgent_fixture() returns trigger language plpgsql as $function$
begin raise exception using errcode='ZUR01',message='Force local urgent rollback cleanup';end;
$function$;
create trigger urgent_fixture_forced_failure after insert on public.attendance_accountability_events
for each row when(new.note='Force local urgent rollback cleanup') execute function pg_temp.reject_urgent_fixture();
create trigger urgent_marker_fixture_forced_failure after update on public.attendance_accountability_events
for each row when(new.dispatch_notification_error='Force local urgent rollback cleanup') execute function pg_temp.reject_urgent_fixture();
set local role authenticated;
do $failure_cleanup$
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 begin perform public.report_attendance_accountability_event(null,'called_in_sick',current_date+3,'Force local urgent rollback cleanup');raise exception 'Forced failure was ignored';exception when sqlstate 'ZUR01' then null;end;
 begin perform public.report_attendance_accountability_event(null,'no_call_no_show',current_date+3,'Forbidden employee event type');raise exception 'Employee manager-only event accepted';exception when check_violation then null;end;
 insert into pg_temp.urgent_regression_results values('forced downstream failure and invalid event type safely abort',true);
end;
$failure_cleanup$;
reset role;
drop trigger urgent_fixture_forced_failure on public.attendance_accountability_events;
do $marker_failure$
begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 begin perform public.service_mark_attendance_accountability_dispatch_result(current_setting('sygshift.urgent_event_1')::uuid,false,'Force local urgent rollback cleanup');raise exception 'Forced service-marker failure was ignored';exception when sqlstate 'ZUR01' then null;end;
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 assert (select dispatch_notified_at::text=current_setting('sygshift.urgent_accepted_dispatch_time') and dispatch_notification_error='Local late failed result' from public.attendance_accountability_events where id=current_setting('sygshift.urgent_event_1')::uuid);
 insert into pg_temp.urgent_regression_results values('service marker downstream failure rolls back capability and delivery fields',true);
end;
$marker_failure$;
drop trigger urgent_marker_fixture_forced_failure on public.attendance_accountability_events;
do $cleanup_and_inactive$
begin
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 assert not exists(select 1 from public.attendance_accountability_events where note='Force local urgent rollback cleanup');
 update private.employee_accounts set disabled_at=clock_timestamp() where employee_id=current_setting('sygshift.urgent_employee')::uuid;
end;
$cleanup_and_inactive$;
set local role authenticated;
do $inactive$
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.urgent_auth_user'))::text,true);
 begin perform public.report_attendance_accountability_event(null,'called_in_sick',current_date,'Disabled employee urgent report');raise exception 'Disabled employee issued a capability';exception when insufficient_privilege then null;end;
 insert into pg_temp.urgent_regression_results values('disabled account cannot issue urgent capability',true);
end;
$inactive$;
reset role;
do $final_cleanup$
begin
 assert not exists(select 1 from private.employee_urgent_maintenance_capabilities);
 set constraints private.urgent_capability_cleanup_required immediate;
end;
$final_cleanup$;
select * from pg_temp.urgent_regression_results order by test_case;
