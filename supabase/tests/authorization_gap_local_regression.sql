-- TRANSACTION BODY. Local restored fixture only. Combine AFTER the candidate
-- inside one inspected outer BEGIN and final ROLLBACK; never COMMIT fixtures.
do $local_guard$
begin
  if current_database()<>'overnight_recovery_fixture_v2_20261019'
    or inet_server_addr() is distinct from inet '127.0.0.1'
    or inet_server_port() is distinct from 55439 then
    raise exception 'Authorization fixtures require the isolated local restore.';
  end if;
end;
$local_guard$;
set local plpgsql.check_asserts=on;
set local statement_timeout='30s';
set local lock_timeout='2s';
create temporary table authorization_regression_results(test_case text primary key,passed boolean not null) on commit drop;
grant insert,select on pg_temp.authorization_regression_results to authenticated;

do $setup$
declare actor record; own_employee uuid; peer_employee uuid; license_employee uuid; admin_employee uuid; target_week date; ticket uuid;
begin
  perform set_config('sygshift.push_kicked','yes',true);
  for actor in
    select employee.id,account.auth_user_id,row_number() over(order by employee.id) as ordinal
    from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
    where employee.status='active' and employee.role='guard' and account.disabled_at is null
    order by employee.id limit 3
  loop
    perform set_config('sygshift.auth_actor_'||actor.ordinal,actor.id::text,true);
    perform set_config('sygshift.auth_user_'||actor.ordinal,actor.auth_user_id::text,true);
  end loop;
  own_employee:=current_setting('sygshift.auth_actor_1')::uuid;
  peer_employee:=current_setting('sygshift.auth_actor_2')::uuid;
  license_employee:=current_setting('sygshift.auth_actor_3')::uuid;
  select employee.id,account.auth_user_id into actor
  from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and employee.role='admin' and account.disabled_at is null limit 1;
  assert actor.id is not null and license_employee is not null,'The restored fixture needs an active Admin and three employee anchors.';
  admin_employee:=actor.id;
  perform set_config('sygshift.auth_admin',actor.id::text,true);
  perform set_config('sygshift.auth_admin_user',actor.auth_user_id::text,true);

  -- The local transaction makes deterministic credentials and permission cohorts.
  -- Every original row, override, account flag and appended event is rolled back.
  update public.employee_credentials set status='revoked' where employee_id in (own_employee,peer_employee) and kind='armed_guard';
  insert into public.employee_credentials(employee_id,kind,status,valid_from,expires_on)
  select employee_id,'armed_guard','active',current_date,current_date+10 from unnest(array[own_employee,peer_employee]) employee_id
  on conflict(employee_id,kind) where archived_at is null and credential_type_id is null
  do update set status='active',valid_from=current_date,expires_on=current_date+10;

  insert into public.employee_permission_overrides(employee_id,permission_code,effect,reason)
  select actor_id,permission_code,'deny','Local rollback-only authorization regression'
  from unnest(array[own_employee,peer_employee,license_employee]) actor_id
  cross join unnest(array['licensing.view','licensing.manage','directory.edit_credentials','admin.security.manage','support.tickets.view','support.tickets.manage','schedule.manage','hr.people.manage']) permission_code
  on conflict(employee_id,permission_code) where active do update set effect='deny';
  update public.employee_permission_overrides set effect='grant'
  where employee_id=peer_employee and permission_code in ('support.tickets.view','support.tickets.manage','schedule.manage') and active;
  update public.employee_permission_overrides set effect='grant'
  where employee_id=license_employee and permission_code in ('licensing.view','admin.security.manage') and active;

  ticket:=gen_random_uuid();
  insert into public.support_tickets(id,submitted_by,subject,category,subcategory,description,route_permission)
  values(ticket,own_employee,'Rollback authorization fixture','schedule','general','This local ticket exists only inside the rollback regression.','schedule.manage');
  perform set_config('sygshift.auth_ticket',ticket::text,true);
  insert into public.support_ticket_messages(ticket_id,author_id,visibility,body,email_requester)
  values(ticket,admin_employee,'internal','Internal local fixture; never requester-facing.',false);
  ticket:=gen_random_uuid();
  insert into public.support_tickets(id,submitted_by,subject,category,subcategory,description,confidential,route_permission)
  values(ticket,own_employee,'Confidential rollback fixture','human_resources','general','This confidential local ticket exists only for permission tests.',true,'hr.people.manage');
  perform set_config('sygshift.auth_hr_ticket',ticket::text,true);

  select (candidate.payload->>'weekStartsOn')::date into target_week
  from private.import_candidates candidate
  where candidate.import_run_id=(select id from private.import_runs order by created_at desc limit 1) and candidate.kind='weekly_schedule'
  order by candidate.candidate_key limit 1;
  assert target_week is not null,'A restored source schedule is required.';
  perform set_config('sygshift.auth_week',target_week::text,true);
end;
$setup$;

set local role authenticated;
do $unlinked$
begin
  perform set_config('request.jwt.claims','{"role":"authenticated","aal":"aal1"}',true);
  assert public.current_employee_id() is null;
  assert not public.has_valid_credential(current_setting('sygshift.auth_actor_1')::uuid,'armed_guard',current_date),'An unlinked account still sees a credential predicate.';
  begin perform public.get_bible_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Unguarded legacy source preview'; exception when insufficient_privilege then null; end;
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Unguarded current source preview'; exception when insufficient_privilege then null; end;
  begin perform public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid); raise exception 'Unlinked ticket read accepted'; exception when insufficient_privilege then null; end;
  insert into pg_temp.authorization_regression_results values('unlinked: source/support denied; credential false',true);
end;
$unlinked$;

do $employee$
declare payload jsonb; message_id bigint;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_user_1'))::text,true);
  assert public.current_employee_id()=current_setting('sygshift.auth_actor_1')::uuid and not public.has_mfa();
  assert public.has_valid_credential(public.current_employee_id(),'armed_guard',current_date);
  assert not public.has_valid_credential(public.current_employee_id(),'armed_guard',current_date-1);
  assert not public.has_valid_credential(public.current_employee_id(),'armed_guard',current_date+11);
  assert not public.has_valid_credential(current_setting('sygshift.auth_actor_2')::uuid,'armed_guard',current_date),'Cross-employee credential scope bypassed RLS.';
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Ordinary employee source preview accepted'; exception when insufficient_privilege then null; end;
  payload:=public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid);
  assert payload->>'canManage'='false' and payload->'messages'='[]'::jsonb,'Own-ticket read exposed management or internal notes.';
  assert payload->'events'='[]'::jsonb;
  message_id:=public.add_support_ticket_message(current_setting('sygshift.auth_ticket')::uuid,'Rollback-only employee reply',false);
  assert message_id is not null,'Own-ticket reply must remain available without MFA.';
  begin perform public.add_support_ticket_message(current_setting('sygshift.auth_ticket')::uuid,'Disallowed internal note',true); raise exception 'Employee internal note accepted'; exception when insufficient_privilege then null; end;
  begin perform public.update_support_ticket(current_setting('sygshift.auth_ticket')::uuid,'{"priority":"urgent"}'); raise exception 'Employee ticket management accepted'; exception when insufficient_privilege then null; end;
  payload:=public.get_time_off_request_context(current_date,current_date);
  assert payload#>>'{employee,id}'=public.current_employee_id()::text;
  assert payload->'allowedTypes' ? 'sick_time','Urgent sick access was restricted by privileged MFA hardening.';
  assert public.has_effective_permission('time.punch'),'Existing ordinary employee clock access was lost.';
  begin
    perform public.record_time_event(null);
    raise exception 'Missing time-event kind accepted';
  exception when check_violation then
    assert sqlerrm='A time event kind is required.','Clock request failed before its normal input-validation boundary.';
  end;
  payload:=public.report_attendance_accountability_event(null,'called_in_sick',current_date,'Rollback-only sick report');
  assert payload->>'employeeId'=public.current_employee_id()::text and payload->>'eventType'='called_in_sick';
  payload:=public.report_attendance_accountability_event(null,'call_off',current_date+1,'Rollback-only call-off report');
  assert payload->>'employeeId'=public.current_employee_id()::text and payload->>'eventType'='call_off';
  insert into pg_temp.authorization_regression_results values('employee AAL1: own credentials/ticket/reply/sick/clock allowed; elevated access denied',true);
end;
$employee$;

do $admin_aal1$
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_admin_user'))::text,true);
  assert public.current_app_role()='admin' and not public.has_mfa();
  begin perform public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid); raise exception 'Admin AAL1 cross-ticket read accepted'; exception when insufficient_privilege then null; end;
  begin perform public.get_support_ticket_assignees(current_setting('sygshift.auth_ticket')::uuid); raise exception 'Admin AAL1 assignee lookup accepted'; exception when insufficient_privilege then null; end;
  begin perform public.update_support_ticket(current_setting('sygshift.auth_ticket')::uuid,'{"priority":"high"}'); raise exception 'Admin AAL1 ticket mutation accepted'; exception when insufficient_privilege then null; end;
  begin perform public.add_support_ticket_message(current_setting('sygshift.auth_ticket')::uuid,'Disallowed Admin AAL1 internal note',true); raise exception 'Admin AAL1 internal note accepted'; exception when insufficient_privilege then null; end;
  insert into pg_temp.authorization_regression_results values('Admin AAL1: elevated support reads/mutations denied',true);
end;
$admin_aal1$;

do $admin_aal2$
declare payload jsonb; message_id bigint;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.auth_admin_user'))::text,true);
  assert public.has_mfa();
  payload:=public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid);
  assert payload->>'canManage'='true' and jsonb_array_length(payload->'messages')=2,'Admin MFA access/internal-note visibility changed.';
  assert jsonb_typeof(public.get_support_ticket_assignees(current_setting('sygshift.auth_ticket')::uuid))='array';
  perform public.update_support_ticket(current_setting('sygshift.auth_ticket')::uuid,'{"priority":"high"}');
  message_id:=public.add_support_ticket_message(current_setting('sygshift.auth_ticket')::uuid,'Rollback-only Admin internal note',true);
  assert message_id is not null;
  assert public.read_support_ticket(current_setting('sygshift.auth_hr_ticket')::uuid)->>'canManage'='true';
  insert into pg_temp.authorization_regression_results values('Admin AAL2: elevated support and confidential ticket access allowed',true);
end;
$admin_aal2$;

do $handler$
declare payload jsonb;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_user_2'))::text,true);
  begin perform public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid); raise exception 'Handler AAL1 elevated read accepted'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.auth_user_2'))::text,true);
  assert public.has_effective_permission('support.tickets.manage') and public.has_effective_permission('schedule.manage');
  payload:=public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid);
  assert payload->>'canManage'='true';
  perform public.update_support_ticket(current_setting('sygshift.auth_ticket')::uuid,'{"priority":"urgent"}');
  begin perform public.read_support_ticket(current_setting('sygshift.auth_hr_ticket')::uuid); raise exception 'Handler without HR route read confidential ticket'; exception when insufficient_privilege then null; end;
  begin perform public.get_support_ticket_assignees(current_setting('sygshift.auth_hr_ticket')::uuid); raise exception 'Handler without HR route managed confidential ticket'; exception when insufficient_privilege then null; end;
  insert into pg_temp.authorization_regression_results values('routed handler: MFA+exact route required; unrelated confidential route denied',true);
end;
$handler$;

do $licensing_source$
declare payload jsonb;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_user_3'))::text,true);
  assert not public.has_valid_credential(current_setting('sygshift.auth_actor_1')::uuid,'armed_guard',current_date),'Licensing grant bypassed MFA filtering.';
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Source admin AAL1 preview accepted'; exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.auth_user_3'))::text,true);
  assert public.has_valid_credential(current_setting('sygshift.auth_actor_1')::uuid,'armed_guard',current_date),'Existing Licensing RLS authority was lost.';
  payload:=public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date);
  assert jsonb_typeof(payload)='object';
  assert payload=public.get_bible_schedule_preview(current_setting('sygshift.auth_week')::date),'Legacy and current source preview contracts diverged.';
  assert md5(payload::text)=current_setting('sygshift.auth_source_before_hash'),'Source preview data/shape changed.';
  insert into pg_temp.authorization_regression_results values('Licensing/source admin: AAL1 denied; existing MFA permission allows unchanged payload',true);
end;
$licensing_source$;
reset role;

do $nested_and_disable$
declare before_count integer; after_count integer;
begin
  -- Existing definer recipient filtering must still see other employees'
  -- credentials even while an ordinary employee is the authenticated actor.
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_user_1'))::text,true);
  select count(*) into before_count from private.communication_audience_employee_ids('qualified',array['guard']::public.app_role[],'{}'::uuid[],true);
  assert exists(select 1 from private.communication_audience_employee_ids('qualified',array['guard']::public.app_role[],'{}'::uuid[],true) recipient where recipient.employee_id=current_setting('sygshift.auth_actor_2')::uuid),'Nested definer credential filtering lost a qualified peer.';
  assert public.has_valid_credential(current_setting('sygshift.auth_actor_2')::uuid,'armed_guard',current_date),'Owner context no longer evaluates credentials.';
  update private.employee_accounts set disabled_at=clock_timestamp() where employee_id=current_setting('sygshift.auth_actor_1')::uuid;
  select count(*) into after_count from private.communication_audience_employee_ids('qualified',array['guard']::public.app_role[],'{}'::uuid[],true);
  assert before_count=after_count,'Internal qualification lookup acquired caller-session filtering.';
  insert into pg_temp.authorization_regression_results values('nested guarded definer qualification remains complete; disabled fixture prepared',true);
end;
$nested_and_disable$;
set local role authenticated;
do $disabled$
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.auth_user_1'))::text,true);
  assert public.current_employee_id() is null;
  assert not public.has_valid_credential(current_setting('sygshift.auth_actor_1')::uuid,'armed_guard',current_date),'Disabled account still sees credentials.';
  begin perform public.read_support_ticket(current_setting('sygshift.auth_ticket')::uuid); raise exception 'Disabled account read own ticket'; exception when insufficient_privilege then null; end;
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Disabled account read source'; exception when insufficient_privilege then null; end;
  insert into pg_temp.authorization_regression_results values('disabled account: credentials false, own ticket/source denied',true);
end;
$disabled$;
reset role;

do $metadata$
begin
  assert not has_function_privilege('anon','public.has_valid_credential(uuid,public.credential_kind,date)','EXECUTE');
  assert not has_function_privilege('anon','public.get_bible_schedule_preview(date)','EXECUTE');
  assert not has_function_privilege('anon','public.get_imported_schedule_preview(date)','EXECUTE');
  assert not has_schema_privilege('authenticated','private','USAGE');
  assert has_function_privilege('authenticated','public.has_valid_credential(uuid,public.credential_kind,date)','EXECUTE');
  assert has_function_privilege('service_role','public.has_valid_credential(uuid,public.credential_kind,date)','EXECUTE');
  assert not (select prosecdef from pg_proc where oid='public.has_valid_credential(uuid,public.credential_kind,date)'::regprocedure);
  insert into pg_temp.authorization_regression_results values('anonymous/private-schema exposure unchanged; supported ACLs preserved',true);
end;
$metadata$;
select * from pg_temp.authorization_regression_results order by test_case;
