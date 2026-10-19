-- TRANSACTION BODY. Read-only workflow probes after the candidate DDL, under
-- one outer BEGIN and final ROLLBACK. No source/ticket/credential data is changed.
-- Every returned value is an aggregate, fixed test label, or catalog metadata.
set local plpgsql.check_asserts=on;
set local statement_timeout='30s';
set local lock_timeout='2s';
create temporary table authorization_hosted_results(test_case text primary key,passed boolean not null) on commit drop;
grant insert,select on pg_temp.authorization_hosted_results to authenticated;
create temporary table authorization_row_counts_before on commit drop as
select (select count(*) from public.time_events) as punches,
  (select count(*) from public.employees) as employees,
  (select count(*) from public.shifts) as shifts,
  (select count(*) from public.employee_credentials) as credentials,
  (select count(*) from public.support_tickets) as tickets,
  (select count(*) from public.support_ticket_messages) as messages,
  (select count(*) from private.audit_events) as audits;
do $anchors$
declare actor record; week_date date;
begin
  select employee.id,account.auth_user_id into actor
  from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
  where employee.role='admin' and employee.status='active' and account.disabled_at is null limit 1;
  assert actor.id is not null,'An existing active Admin anchor is required.';
  perform set_config('sygshift.auth_admin_user',actor.auth_user_id::text,true);
  perform set_config('sygshift.auth_admin_employee',actor.id::text,true);
  select employee.id,account.auth_user_id into actor
  from public.employees employee join private.employee_accounts account on account.employee_id=employee.id
  where employee.role='guard' and employee.status='active' and account.disabled_at is null
    and exists(select 1 from public.support_tickets ticket where ticket.submitted_by=employee.id)
  order by employee.id limit 1;
  assert actor.id is not null,'An existing employee-owned ticket anchor is required.';
  perform set_config('sygshift.auth_employee_user',actor.auth_user_id::text,true);
  perform set_config('sygshift.auth_employee',actor.id::text,true);
  perform set_config('sygshift.auth_own_ticket',(select id::text from public.support_tickets where submitted_by=actor.id limit 1),true);
  perform set_config('sygshift.auth_credential_employee',(select employee_id::text from public.employee_credentials where status='active' and kind='armed_guard' and (valid_from is null or valid_from<=current_date) and (expires_on is null or expires_on>=current_date) and employee_id<>actor.id limit 1),true);
  assert nullif(current_setting('sygshift.auth_credential_employee',true),'') is not null,'An active peer qualification anchor is required.';
  select (candidate.payload->>'weekStartsOn')::date into week_date
  from private.import_candidates candidate
  where candidate.import_run_id=(select id from private.import_runs order by created_at desc limit 1) and candidate.kind='weekly_schedule'
  order by candidate.candidate_key limit 1;
  assert week_date is not null;
  perform set_config('sygshift.auth_week',week_date::text,true);
end;
$anchors$;
set local role authenticated;
do $unlinked$
begin
  perform set_config('request.jwt.claims','{"role":"authenticated","aal":"aal1"}',true);
  assert public.current_employee_id() is null;
  assert not public.has_valid_credential(current_setting('sygshift.auth_credential_employee')::uuid,'armed_guard',current_date),'Unlinked credential disclosure remains.';
  begin perform public.get_bible_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Legacy source preview accepted unlinked account'; exception when insufficient_privilege then null; end;
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Current source preview accepted unlinked account'; exception when insufficient_privilege then null; end;
  begin perform public.read_support_ticket(current_setting('sygshift.auth_own_ticket')::uuid); raise exception 'Unlinked ticket read accepted'; exception when insufficient_privilege then null; end;
  insert into pg_temp.authorization_hosted_results values('unlinked direct calls denied; credential predicate false',true);
end;
$unlinked$;
do $ordinary$
declare payload jsonb; expected_credential boolean;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_employee_user'))::text,true);
  assert public.current_employee_id()=current_setting('sygshift.auth_employee')::uuid and not public.has_mfa();
  assert not public.has_valid_credential(current_setting('sygshift.auth_credential_employee')::uuid,'armed_guard',current_date),'Ordinary employee can inspect a peer credential.';
  select exists(select 1 from public.employee_credentials where employee_id=public.current_employee_id() and kind='armed_guard' and status='active' and (valid_from is null or valid_from<=current_date) and (expires_on is null or expires_on>=current_date)) into expected_credential;
  assert public.has_valid_credential(public.current_employee_id(),'armed_guard',current_date)=expected_credential;
  payload:=public.read_support_ticket(current_setting('sygshift.auth_own_ticket')::uuid);
  assert payload->>'canManage'='false' and payload->'events'='[]'::jsonb;
  assert not exists(select 1 from jsonb_array_elements(payload->'messages') message where message->>'visibility'='internal');
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Ordinary employee source preview accepted'; exception when insufficient_privilege then null; end;
  assert public.get_time_off_request_context(current_date,current_date)#>>'{employee,id}'=public.current_employee_id()::text;
  insert into pg_temp.authorization_hosted_results values('ordinary AAL1: own credential/ticket/sick context preserved; peer/source denied',true);
end;
$ordinary$;
do $admin_aal1$
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal1','sub',current_setting('sygshift.auth_admin_user'))::text,true);
  assert public.current_app_role()='admin' and not public.has_mfa();
  begin perform public.get_support_ticket_assignees(current_setting('sygshift.auth_own_ticket')::uuid); raise exception 'Admin AAL1 assignees accepted'; exception when insufficient_privilege then null; end;
  begin perform public.read_support_ticket(current_setting('sygshift.auth_own_ticket')::uuid); raise exception 'Admin AAL1 elevated reader accepted'; exception when insufficient_privilege then null; end;
  begin perform public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date); raise exception 'Admin AAL1 source preview accepted'; exception when insufficient_privilege then null; end;
  insert into pg_temp.authorization_hosted_results values('Admin AAL1: elevated support and source denied',true);
end;
$admin_aal1$;
do $admin_aal2$
declare payload jsonb;
begin
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','aal','aal2','sub',current_setting('sygshift.auth_admin_user'))::text,true);
  assert public.has_mfa() and public.has_effective_permission('admin.security.manage');
  assert public.read_support_ticket(current_setting('sygshift.auth_own_ticket')::uuid)->>'canManage'='true';
  assert jsonb_typeof(public.get_support_ticket_assignees(current_setting('sygshift.auth_own_ticket')::uuid))='array';
  payload:=public.get_imported_schedule_preview(current_setting('sygshift.auth_week')::date);
  assert jsonb_typeof(payload)='object' and md5(payload::text)=current_setting('sygshift.auth_source_before_hash');
  assert payload=public.get_bible_schedule_preview(current_setting('sygshift.auth_week')::date);
  assert public.has_valid_credential(current_setting('sygshift.auth_credential_employee')::uuid,'armed_guard',current_date),'Authorized Licensing/Admin qualification scope changed.';
  insert into pg_temp.authorization_hosted_results values('Admin AAL2: supported support/source/Licensing reads preserved',true);
end;
$admin_aal2$;
reset role;
do $integrity$
begin
  assert exists(select 1 from pg_temp.authorization_row_counts_before original where
    original.punches=(select count(*) from public.time_events)
    and original.employees=(select count(*) from public.employees)
    and original.shifts=(select count(*) from public.shifts)
    and original.credentials=(select count(*) from public.employee_credentials)
    and original.tickets=(select count(*) from public.support_tickets)
    and original.messages=(select count(*) from public.support_ticket_messages)
    and original.audits=(select count(*) from private.audit_events));
  assert public.has_valid_credential(current_setting('sygshift.auth_credential_employee')::uuid,'armed_guard',current_date),'Nested owner lookup was restricted by actor scope.';
  assert not has_schema_privilege('authenticated','private','USAGE');
  insert into pg_temp.authorization_hosted_results values('protected row counts unchanged; nested owner lookup and private schema boundary preserved',true);
end;
$integrity$;
select jsonb_build_object(
  'tests',(select jsonb_agg(to_jsonb(result) order by test_case) from pg_temp.authorization_hosted_results result),
  'functions',(select jsonb_agg(jsonb_build_object('identity',p.oid::regprocedure::text,'definition_hash',md5(pg_get_functiondef(p.oid)),'owner',r.rolname,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig) order by p.oid::regprocedure::text) from pg_temp.authorization_contract_before original join pg_proc p on p.oid=original.oid join pg_roles r on r.oid=p.proowner),
  'before_counts',(select to_jsonb(original) from pg_temp.authorization_row_counts_before original)
) as authorization_rehearsal;
