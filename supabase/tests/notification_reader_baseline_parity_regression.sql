-- Run immediately after the candidate, before any retry-generation fixtures.
-- The runner captures the exact original paginated definition into this temp
-- table BEFORE the candidate. Its baseline hash must match the verified source.
-- Compare old and new reader bodies over the SAME safely backfilled queue data;
-- the deliberately repaired exhausted row is therefore not mistaken for drift.
do $test$
declare
  original_definition text;
  actor_auth uuid;
  probe record;
  expected jsonb;
  actual jsonb;
  checked integer := 0;
  tie_reorders integer := 0;
  fixture_id uuid;
  index_value integer;
begin
  select definition into original_definition from notification_reader_pre_candidate;
  assert md5(original_definition)='1def49e00ca411d349c9445d797c4e13';
  assert not exists(select 1 from private.notification_outbox where retry_of_notification_id is not null),
    'Full baseline parity requires original rows before retry-generation fixtures.';
  execute replace(original_definition,'FUNCTION public.get_notification_center(', 'FUNCTION pg_temp.pre_bridge_notification_reader(');
  revoke all on function pg_temp.pre_bridge_notification_reader(text,text,date,date,integer,integer) from public, anon, authenticated, service_role;
  execute replace(replace(original_definition,'FUNCTION public.get_notification_center(', 'FUNCTION pg_temp.pre_bridge_all_rows('),
    'limit clean_size offset (clean_page-1)*clean_size','');
  execute replace(replace(pg_get_functiondef('public.get_notification_center(text,text,date,date,integer,integer)'::regprocedure),
    'FUNCTION public.get_notification_center(', 'FUNCTION pg_temp.bridge_all_rows('),
    'limit clean_size offset (clean_page-1)*clean_size','');
  revoke all on function pg_temp.pre_bridge_all_rows(text,text,date,date,integer,integer) from public, anon, authenticated, service_role;
  revoke all on function pg_temp.bridge_all_rows(text,text,date,date,integer,integer) from public, anon, authenticated, service_role;
  select account.auth_user_id into actor_auth from public.employees employee
  join private.employee_accounts account on account.employee_id=employee.id
  where employee.status='active' and account.disabled_at is null
    and 'notifications.manage'=any(private.employee_effective_permissions(employee.id))
  order by employee.id limit 1;
  assert actor_auth is not null;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor_auth,'role','authenticated','aal','aal2')::text,true);
  for probe in select * from (values
    ('all',null::text,null::date,null::date,1,10),
    ('all',null,null::date,null::date,2,10),
    ('all',null,null::date,null::date,4,5),
    ('queued',null,null::date,null::date,1,20),
    ('delivered',null,null::date,null::date,1,20),
    ('failed',null,null::date,null::date,1,20),
    ('all','schedule',null::date,null::date,1,20),
    ('all','  schedule  ',null::date,null::date,1,5),
    ('all','call off',null::date,null::date,1,10),
    ('all',null,date '2026-10-01',date '2026-10-19',1,20),
    ('all',null,date '2099-01-01',date '2099-01-02',1,10),
    ('all',null,null::date,null::date,999,20),
    ('all',null,null::date,null::date,0,100)
  ) as cases(status,search,date_from,date_through,page,page_size) loop
    expected := pg_temp.pre_bridge_notification_reader(probe.status,probe.search,probe.date_from,probe.date_through,probe.page,probe.page_size);
    actual := public.get_notification_center(probe.status,probe.search,probe.date_from,probe.date_through,probe.page,probe.page_size);
    if actual<>expected then
      -- The original API orders only by created_at. Equal timestamps have no
      -- defined relative order and can cross a LIMIT boundary after an anti-join.
      -- Permit ONLY that proven ambiguity: identical metadata and ordered time
      -- sequence, then exact complete row equality across the full filtered set.
      assert actual-'batches'=expected-'batches', 'Legacy response metadata changed.';
      assert (select jsonb_agg(value->'createdAt' order by ordinal) from jsonb_array_elements(actual->'batches') with ordinality batch(value,ordinal))
        is not distinct from (select jsonb_agg(value->'createdAt' order by ordinal) from jsonb_array_elements(expected->'batches') with ordinality batch(value,ordinal)),
        'A pagination change exceeded the original equal-timestamp ambiguity.';
      expected := pg_temp.pre_bridge_all_rows(probe.status,probe.search,probe.date_from,probe.date_through,probe.page,probe.page_size);
      actual := pg_temp.bridge_all_rows(probe.status,probe.search,probe.date_from,probe.date_through,probe.page,probe.page_size);
      assert actual-'batches'=expected-'batches';
      assert (select jsonb_agg(value order by value->>'id') from jsonb_array_elements(actual->'batches'))
        is not distinct from (select jsonb_agg(value order by value->>'id') from jsonb_array_elements(expected->'batches')),
        'The bridge changed a complete baseline row beyond the undefined order of equal timestamps.';
      tie_reorders := tie_reorders+1;
    end if;
    checked := checked+1;
  end loop;
  assert checked=13;
  -- Keep strict full JSON/pagination equality where ordering is uniquely defined.
  for index_value in 1..6 loop
    fixture_id:=gen_random_uuid();
    insert into private.notification_outbox(id,message_type,aggregate_type,aggregate_id,payload,idempotency_key,
      created_at,attempt_count,delivered_at,failed_at)
    values(fixture_id,'schedule_published','uniquely_ordered_reader_fixture',gen_random_uuid(),'{}','ordered-reader:'||fixture_id,
      timestamptz '2026-10-19 20:00:00+00'-index_value*interval '1 minute',1,
      case when index_value in (3,4) then clock_timestamp() end,
      case when index_value in (5,6) then clock_timestamp() end);
  end loop;
  for index_value in 1..2 loop
    assert public.get_notification_center('all','uniquely_ordered_reader_fixture',null,null,index_value,5)
      =pg_temp.pre_bridge_notification_reader('all','uniquely_ordered_reader_fixture',null,null,index_value,5),
      'Strict legacy response parity failed for uniquely ordered pagination.';
  end loop;
  raise notice 'Legacy baseline: 13 complete logical payloads matched; % equal-timestamp pagination reorder(s); strict unique-order page1/page2 JSON matched.',tie_reorders;
end;
$test$;
select 'notification_reader_baseline_parity_13_cases_passed' as status;
