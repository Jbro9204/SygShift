-- Run after the exact forward reader recovery, within the same rollback batch.
do $test$
declare actor_auth uuid; response jsonb; before_value jsonb; after_value jsonb;
begin
  select account.auth_user_id into actor_auth from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and 'notifications.manage'=any(private.employee_effective_permissions(employee.id))
  order by employee.id limit 1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  response := public.get_notification_center_v2('all','reader_compatibility',null,null,1,20);
  assert response->>'deliveryVisibility'='legacy';
  assert response-'deliveryVisibility'=public.get_notification_center('all','reader_compatibility',null,null,1,20);
  assert not exists(select 1 from jsonb_array_elements(response->'batches') batch where batch->>'status' not in ('queued','delivered','failed'));
  assert jsonb_array_length(public.get_notification_center_v2('suppressed','reader_compatibility',null,null,1,20)->'batches')=0,
    'A coarse fallback must never present unrelated failed rows as confirmed provider suppressions.';
  assert md5(pg_get_functiondef('public.get_notification_center()'::regprocedure))='e1e39a69d2eb370bfb91bc488bfad0f7';
  assert md5(pg_get_functiondef('public.get_notification_center(text,text,date,date,integer,integer)'::regprocedure))='84c182bcf5067bc10b0703e82ff3783e';
  assert not has_function_privilege('anon','public.get_notification_center_v2(text,text,date,date,integer,integer)','EXECUTE');
  assert (select current_reader.proowner=legacy_reader.proowner and current_reader.proacl=legacy_reader.proacl
    and current_reader.proconfig=legacy_reader.proconfig and current_reader.prosecdef and current_reader.provolatile='s'
    from pg_proc current_reader,pg_proc legacy_reader
    where current_reader.oid='public.get_notification_center_v2(text,text,date,date,integer,integer)'::regprocedure
      and legacy_reader.oid='public.get_notification_center(text,text,date,date,integer,integer)'::regprocedure);
  select snapshot into before_value from notification_before_reader_fallback;
  select jsonb_build_object('queue_snapshot',jsonb_build_object(
    'outbox',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(row)::text,'|' order by id))) from private.notification_outbox row),
    'support',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(row)::text,'|' order by id))) from public.support_ticket_notifications row),
    'employee',(select jsonb_build_object('count',count(*),'hash',md5(string_agg(to_jsonb(row)::text,'|' order by id))) from public.employee_notification_email_deliveries row),
    'audit',(select count(*) from private.audit_events), 'email_audit',(select count(*) from private.email_delivery_audit),
    'retry_events',(select count(*) from private.notification_retry_events), 'employee_notifications',(select count(*) from public.employee_notifications),
    'ledger',(select count(*) from supabase_migrations.schema_migrations))) into after_value;
  assert before_value=after_value, 'Reader recovery changed a queue, terminal history, audit, retry, inbox, or ledger record.';
end;
$test$;
select jsonb_build_object('fallback_contract',public.get_notification_center_v2('all','reader_compatibility',null,null,1,20));
select 'notification_reader_forward_recovery_regression_passed' as status;
