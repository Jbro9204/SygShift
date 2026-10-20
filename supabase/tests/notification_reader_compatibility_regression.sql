-- Body only: candidate and all tests must share ONE outer BEGIN/final ROLLBACK.
-- Synthetic job payloads only; no provider calls or committed queue records.
create temporary table notification_reader_contract_evidence(phase text, legacy jsonb, current jsonb);

do $test$
declare
  actor_auth uuid;
  denied_auth uuid;
  fixture_id uuid;
  mixed_id uuid := gen_random_uuid();
  accepted_id uuid := gen_random_uuid();
  failed_id uuid := gen_random_uuid();
  suppressed_id uuid := gen_random_uuid();
  child_id uuid;
  outcome text;
  phase text;
  legacy jsonb;
  current jsonb;
  item jsonb;
  accepted_before jsonb;
  failed_before jsonb;
  suppressed_before jsonb;
  old_unpaged_hash text := md5(pg_get_functiondef('public.get_notification_center()'::regprocedure));
  handoff_fixture record;
  handoff_value jsonb;
begin
  perform set_config('sygshift.push_kicked','yes',true);
  select account.auth_user_id into actor_auth from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and 'notifications.manage'=any(private.employee_effective_permissions(employee.id))
  order by employee.id limit 1;
  assert actor_auth is not null, 'A retained authorized manager is required.';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  assert not exists(select 1 from notification_handoff_fixture fixture join private.notification_outbox delivery on delivery.id=fixture.id
    where to_jsonb(delivery)-'terminal_outcome'-'retry_of_notification_id'<>fixture.accepted_row);
  assert (select (public.retry_notification_job(id)->>'retried')::integer=0 from notification_handoff_fixture),
    'A fifth attempt accepted after a refused installation became eligible for resend.';
  for handoff_fixture in select * from notification_handoff_other_fixtures loop
    execute format('select to_jsonb(delivery)-''terminal_outcome''-''retry_of_notification_id'' from %s delivery where id=$1',handoff_fixture.relation)
      into handoff_value using handoff_fixture.id;
    assert handoff_value=handoff_fixture.accepted_row, 'A valid late provider acceptance changed during successful installation.';
  end loop;
  select account.auth_user_id into denied_auth from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and not ('notifications.manage'=any(private.employee_effective_permissions(employee.id)))
  order by employee.id limit 1;
  assert denied_auth is not null, 'A retained non-manager is required for the deny control.';
  assert old_unpaged_hash='e1e39a69d2eb370bfb91bc488bfad0f7', 'No-argument legacy API changed.';
  -- The two existing overloads make a direct no-argument SQL call ambiguous.
  -- Clone the exact older routine under pg_temp to exercise its unchanged body
  -- and authorization without altering either production-facing signature.
  execute replace(pg_get_functiondef('public.get_notification_center()'::regprocedure),
    'FUNCTION public.get_notification_center()', 'FUNCTION pg_temp.legacy_notification_reader_probe()');
  revoke all on function pg_temp.legacy_notification_reader_probe() from public, anon, authenticated, service_role;

  for outcome in select unnest(array['queued','delivered','failed','suppressed','canceled','retry_exhausted']) loop
    fixture_id := gen_random_uuid();
    insert into private.notification_outbox(id,message_type,aggregate_type,aggregate_id,payload,idempotency_key,
      attempt_count,delivered_at,failed_at,terminal_outcome,last_error)
    values(fixture_id,'schedule_published','reader_compatibility',gen_random_uuid(),'{}','reader-compat:'||fixture_id,
      case when outcome='retry_exhausted' then 5 else 1 end,
      case when outcome='delivered' then clock_timestamp() end,
      case when outcome in ('failed','suppressed','canceled','retry_exhausted') then clock_timestamp() end,
      case when outcome in ('failed','suppressed','canceled','retry_exhausted') then outcome end,
      case when outcome='suppressed' then 'Suppressed — Provider Recipient' end);
  end loop;
  insert into private.notification_outbox(id,message_type,aggregate_type,aggregate_id,payload,idempotency_key,attempt_count)
  values(accepted_id,'schedule_published','reader_compatibility',mixed_id,'{}','reader-compat:'||accepted_id,1),
    (failed_id,'schedule_published','reader_compatibility',mixed_id,'{}','reader-compat:'||failed_id,5),
    (suppressed_id,'schedule_published','reader_compatibility',mixed_id,'{}','reader-compat:'||suppressed_id,1);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  perform public.service_mark_notification_result(accepted_id,true,null);
  perform public.service_mark_notification_result(failed_id,false,'Retry leaf fixture');
  perform public.service_mark_notification_suppressed(suppressed_id,'Suppressed — Provider Recipient');
  select to_jsonb(delivery) into accepted_before from private.notification_outbox delivery where id=accepted_id;
  select to_jsonb(delivery) into failed_before from private.notification_outbox delivery where id=failed_id;
  select to_jsonb(delivery) into suppressed_before from private.notification_outbox delivery where id=suppressed_id;

  for phase in select unnest(array['initial','queued_retry','accepted_retry','status_filters','pagination']) loop
    perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
    if phase='queued_retry' then
      assert (public.retry_notification_job(accepted_id)->>'retried')::integer=1;
      select id into child_id from private.notification_outbox where retry_of_notification_id=failed_id;
      assert child_id is not null;
      assert (public.retry_notification_job(failed_id)->>'retried')::integer=0, 'An old browser duplicate retry must not duplicate a generation.';
    elsif phase='accepted_retry' then
      perform set_config('request.jwt.claims','{"role":"service_role"}',true);
      perform public.service_mark_notification_result(child_id,true,null);
      perform public.service_mark_notification_result(child_id,false,'Late failure must not replace acceptance');
      perform public.service_mark_notification_suppressed(child_id,'Suppressed — Provider Recipient');
      perform public.service_mark_notification_result(suppressed_id,true,null);
      perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
      assert (public.retry_notification_job(accepted_id)->>'retried')::integer=0;
    end if;
    legacy := public.get_notification_center('all','reader_compatibility',null,null,1,20);
    current := public.get_notification_center_v2('all','reader_compatibility',null,null,1,20);
    assert (select array_agg(key order by key) from jsonb_object_keys(legacy) key)=array['batches','page','permissions','summary'];
    assert (select array_agg(key order by key) from jsonb_object_keys(legacy->'summary') key)=array['delivered','failed','pending'];
    assert not exists(select 1 from jsonb_array_elements(legacy->'batches') batch where batch->>'status' not in ('queued','delivered','failed'));
    assert (select array_agg(key order by key) from jsonb_object_keys(legacy->'page') key)=array['number','size','total','totalPages'];
    assert jsonb_array_length(legacy->'batches')=7 and jsonb_array_length(current->'batches')=7;
    assert (legacy->'summary'->>'pending')::integer+(legacy->'summary'->>'delivered')::integer+(legacy->'summary'->>'failed')::integer
      =(current->'summary'->>'pending')::integer+(current->'summary'->>'delivered')::integer+(current->'summary'->>'failed')::integer
      +(current->'summary'->>'suppressed')::integer+(current->'summary'->>'canceled')::integer+(current->'summary'->>'retryExhausted')::integer,
      'Versioning changed the total number of grouped leaf jobs.';
    for item in select value from jsonb_array_elements(legacy->'batches') loop
      assert (select array_agg(key order by key) from jsonb_object_keys(item) key)=array['aggregateId','aggregateType','attemptCount','availableAt','channels','createdAt','deliveredAt','failedAt','id','lastError','messageType','recipientCount','status','subject'];
    end loop;
    assert exists(select 1 from jsonb_array_elements(current->'batches') batch where batch->>'status'='suppressed');
    assert exists(select 1 from jsonb_array_elements(current->'batches') batch where batch->>'status'='canceled');
    assert exists(select 1 from jsonb_array_elements(current->'batches') batch where batch->>'status'='retry_exhausted');
    if phase='queued_retry' then
      assert exists(select 1 from jsonb_array_elements(legacy->'batches') batch where batch->>'aggregateId'=mixed_id::text and batch->>'status'='failed' and (batch->>'recipientCount')::integer=3);
      assert exists(select 1 from jsonb_array_elements(current->'batches') batch where batch->>'aggregateId'=mixed_id::text and batch->>'status'='queued' and (batch->>'recipientCount')::integer=3);
    end if;
    if phase='status_filters' then
      foreach outcome in array array['queued','delivered','failed'] loop
        item := public.get_notification_center(outcome,'reader_compatibility',null,null,1,20);
        assert not exists(select 1 from jsonb_array_elements(item->'batches') batch where batch->>'status'<>outcome);
        assert (item->'page'->>'total')::integer=jsonb_array_length(item->'batches');
      end loop;
      foreach outcome in array array['suppressed','canceled','retry_exhausted'] loop
        item := public.get_notification_center_v2(outcome,'reader_compatibility',null,null,1,20);
        assert jsonb_array_length(item->'batches')=1 and item->'batches'->0->>'status'=outcome;
      end loop;
    elsif phase='pagination' then
      item := public.get_notification_center('all','reader_compatibility',null,null,2,5);
      assert (item->'page'->>'total')::integer=7 and (item->'page'->>'totalPages')::integer=2 and jsonb_array_length(item->'batches')=2;
      item := public.get_notification_center_v2('all','reader_compatibility',null,null,2,5);
      assert (item->'page'->>'total')::integer=7 and (item->'page'->>'totalPages')::integer=2 and jsonb_array_length(item->'batches')=2;
    end if;
    insert into notification_reader_contract_evidence values(phase,legacy,current);
  end loop;
  assert (select to_jsonb(delivery)=accepted_before from private.notification_outbox delivery where id=accepted_id);
  assert (select to_jsonb(delivery)=failed_before from private.notification_outbox delivery where id=failed_id);
  assert (select to_jsonb(delivery)=suppressed_before from private.notification_outbox delivery where id=suppressed_id);
  assert not exists(select 1 from private.notification_outbox where retry_of_notification_id in (accepted_id,suppressed_id));
  assert md5(pg_get_functiondef('public.get_notification_center()'::regprocedure))=old_unpaged_hash;
  item := pg_temp.legacy_notification_reader_probe();
  assert (select array_agg(key order by key) from jsonb_object_keys(item) key)=array['recent','summary'];
  assert jsonb_array_length(item->'recent')<=25;
  assert (select array_agg(key order by key) from jsonb_object_keys(item->'summary') key)=array['delivered','failed','pending'];
  assert not has_function_privilege('anon','public.get_notification_center_v2(text,text,date,date,integer,integer)','EXECUTE');
  assert has_function_privilege('authenticated','public.get_notification_center_v2(text,text,date,date,integer,integer)','EXECUTE');
  assert has_function_privilege('service_role','public.get_notification_center_v2(text,text,date,date,integer,integer)','EXECUTE');
  assert (select current_reader.proowner=legacy_reader.proowner and current_reader.proacl=legacy_reader.proacl
      and current_reader.proconfig=legacy_reader.proconfig and current_reader.prosecdef=legacy_reader.prosecdef
      and current_reader.provolatile=legacy_reader.provolatile and current_reader.prorettype=legacy_reader.prorettype
    from pg_proc current_reader,pg_proc legacy_reader
    where current_reader.oid='public.get_notification_center_v2(text,text,date,date,integer,integer)'::regprocedure
      and legacy_reader.oid='public.get_notification_center(text,text,date,date,integer,integer)'::regprocedure);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal1')::text,true);
  begin
    perform public.get_notification_center('all','reader_compatibility',null,null,1,20);
    raise exception 'Legacy reader accepted an unverified session.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.get_notification_center_v2('all','reader_compatibility',null,null,1,20);
    raise exception 'Versioned reader accepted an unverified session.';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',denied_auth,'role','authenticated','aal','aal2')::text,true);
  begin
    perform public.get_notification_center('all','reader_compatibility',null,null,1,20);
    raise exception 'Legacy reader accepted an employee without notification management permission.';
  exception when insufficient_privilege then null; end;
  begin
    perform public.get_notification_center_v2('all','reader_compatibility',null,null,1,20);
    raise exception 'Versioned reader accepted an employee without notification management permission.';
  exception when insufficient_privilege then null; end;
end;
$test$;
select jsonb_build_object('contracts',jsonb_agg(to_jsonb(evidence) order by phase)) from notification_reader_contract_evidence evidence;
select 'notification_reader_compatibility_regression_passed' as status;
