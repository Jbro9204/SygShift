-- Prove ordered review payload equality at the existing authenticated timeout.
-- Temporarily restore exact prior collectors inside the outer rollback only,
-- then install the candidate and compare both periods, history, empty and wide base.
begin isolation level repeatable read;
set local statement_timeout='8s';
set local lock_timeout='250ms';
set local idle_in_transaction_session_timeout='10s';
do $diagnostic_actor$
declare
  actor_auth_id uuid;
begin
  select account.auth_user_id into actor_auth_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where employee.status = 'active'
    and account.auth_user_id is not null
    and account.disabled_at is null
    and 'time.view' = any(private.employee_effective_permissions(employee.id))
  order by case employee.role when 'admin' then 0 else 1 end, employee.created_at
  limit 1;

  if actor_auth_id is null then
    raise insufficient_privilege using message = 'No existing active Time viewer is available for this operator diagnostic.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_auth_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', actor_auth_id, 'role', 'authenticated', 'aal', 'aal2'
  )::text, true);
end
$diagnostic_actor$;

-- Forward recovery restores exact pre-change collection code and the same ACL.
do $recover_timekeeping_row_collection$
declare
  target record;
  signature regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  recovered_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  recovered_sql text;
  prior_token text;
  current_token text;
  element_name text;
begin
  for target in
    select * from (values
      ('private.get_timekeeping_review_operations_base(date,date)',
        'f1a37c481aff6cacbb4ee3b5f47d6532', '54a94325d91b44d34e7c4e9f59aa79ce',
        'transformed_rows', 'transformed_row_values', array['base_row', 'transformed_row']),
      ('private.get_timekeeping_review_preferred_name_boundary_base(date,date)',
        '970c28204f2e0bc9ce2f34a83fd6eb47', '8b3d65f5db03d490831f3f5e62786a5e',
        'enriched_rows', 'enriched_row_values', array['enriched_row'])
    ) baseline(signature, original_hash, revised_hash, collection_name, buffer_name, element_names)
  loop
    signature := target.signature::regprocedure;
    select * into strict original_function from pg_catalog.pg_proc where oid = signature;
    original_sql := pg_get_functiondef(signature);
    if md5(original_sql) = target.original_hash then
      continue;
    end if;
    if md5(original_sql) <> target.revised_hash then
      raise check_violation using message = 'Timekeeping collection source changed after the repair; review forward recovery.';
    end if;

    current_token := target.collection_name || ' jsonb;' || chr(10)
      || '  ' || target.buffer_name || ' jsonb[] := ''{}''::jsonb[];';
    prior_token := target.collection_name || ' jsonb := ''[]''::jsonb;';
    recovered_sql := replace(original_sql, current_token, prior_token);
    foreach element_name in array target.element_names
    loop
      current_token := target.buffer_name || ' := array_append(' || target.buffer_name
        || ', ' || element_name || ');';
      prior_token := target.collection_name || ' := ' || target.collection_name
        || ' || jsonb_build_array(' || element_name || ');';
      recovered_sql := replace(recovered_sql, current_token, prior_token);
    end loop;
    current_token := '  end loop;' || chr(10) || '  ' || target.collection_name
      || ' := to_jsonb(' || target.buffer_name || ');' || chr(10) || chr(10) || '  select';
    prior_token := '  end loop;' || chr(10) || chr(10) || '  select';
    recovered_sql := replace(recovered_sql, current_token, prior_token);
    if md5(recovered_sql) <> target.original_hash then
      raise check_violation using message = 'Timekeeping collection recovery differs from the exact saved baseline.';
    end if;

    execute recovered_sql;
    select * into strict recovered_function from pg_catalog.pg_proc where oid = signature;
    if pg_get_functiondef(signature) <> recovered_sql
      or recovered_function.proowner is distinct from original_function.proowner
      or recovered_function.proacl is distinct from original_function.proacl
      or recovered_function.proconfig is distinct from original_function.proconfig
      or recovered_function.prosecdef is distinct from original_function.prosecdef
      or recovered_function.provolatile is distinct from original_function.provolatile
      or recovered_function.proargdefaults is distinct from original_function.proargdefaults
    then
      raise check_violation using message = 'Timekeeping collection recovery did not preserve the verified function boundary.';
    end if;
  end loop;
end
$recover_timekeeping_row_collection$;
create temp table timekeeping_before_review(case_name text primary key,payload jsonb) on commit drop;
create temp table timekeeping_equivalence_result(case_name text,payload_equal boolean,row_count int,elapsed_ms numeric) on commit drop;
insert into timekeeping_before_review select 'recent_historical',public.get_timekeeping_review(date '2026-10-04',date '2026-10-17')-'serverTimestamp';
insert into timekeeping_before_review select 'current_period',public.get_timekeeping_review(date '2026-10-18',date '2026-10-31')-'serverTimestamp';
insert into timekeeping_before_review select 'older_historical',public.get_timekeeping_review(date '2026-09-20',date '2026-10-03')-'serverTimestamp';
insert into timekeeping_before_review select 'empty_future',public.get_timekeeping_review(date '2099-01-04',date '2099-01-17')-'serverTimestamp';
insert into timekeeping_before_review select 'wide_base',private.get_timekeeping_review_base(date '2026-09-04',date '2026-10-19')-'serverTimestamp';


-- Repeated JSONB concatenation copies every prior review row on each append.
-- Collect the same ordered rows in an expanded native array and convert once.
-- Empty arrays still become []; no intermediate reader observes the buffer.
do $collect_timekeeping_rows_once$
declare
  target record;
  signature regprocedure;
  original_function pg_catalog.pg_proc%rowtype;
  revised_function pg_catalog.pg_proc%rowtype;
  original_sql text;
  revised_sql text;
  original_token text;
  revised_token text;
  element_name text;
begin
  for target in
    select * from (values
      ('private.get_timekeeping_review_operations_base(date,date)',
        'f1a37c481aff6cacbb4ee3b5f47d6532', '54a94325d91b44d34e7c4e9f59aa79ce',
        'transformed_rows', 'transformed_row_values', array['base_row', 'transformed_row']),
      ('private.get_timekeeping_review_preferred_name_boundary_base(date,date)',
        '970c28204f2e0bc9ce2f34a83fd6eb47', '8b3d65f5db03d490831f3f5e62786a5e',
        'enriched_rows', 'enriched_row_values', array['enriched_row'])
    ) baseline(signature, original_hash, revised_hash, collection_name, buffer_name, element_names)
  loop
    signature := target.signature::regprocedure;
    select * into strict original_function from pg_catalog.pg_proc where oid = signature;
    original_sql := pg_get_functiondef(signature);
    if md5(original_sql) = target.revised_hash then
      continue;
    end if;
    if md5(original_sql) <> target.original_hash then
      raise check_violation using message = 'Timekeeping row collection source changed after the verified baseline; review before applying.';
    end if;

    original_token := target.collection_name || ' jsonb := ''[]''::jsonb;';
    revised_token := target.collection_name || ' jsonb;' || chr(10)
      || '  ' || target.buffer_name || ' jsonb[] := ''{}''::jsonb[];';
    revised_sql := replace(original_sql, original_token, revised_token);

    foreach element_name in array target.element_names
    loop
      original_token := target.collection_name || ' := ' || target.collection_name
        || ' || jsonb_build_array(' || element_name || ');';
      revised_token := target.buffer_name || ' := array_append(' || target.buffer_name
        || ', ' || element_name || ');';
      revised_sql := replace(revised_sql, original_token, revised_token);
    end loop;

    original_token := '  end loop;' || chr(10) || chr(10) || '  select';
    revised_token := '  end loop;' || chr(10) || '  ' || target.collection_name
      || ' := to_jsonb(' || target.buffer_name || ');' || chr(10) || chr(10) || '  select';
    revised_sql := replace(revised_sql, original_token, revised_token);
    if md5(revised_sql) <> target.revised_hash then
      raise check_violation using message = 'Timekeeping row collection patch differs from the verified candidate.';
    end if;

    execute revised_sql;
    select * into strict revised_function from pg_catalog.pg_proc where oid = signature;
    if pg_get_functiondef(signature) <> revised_sql
      or revised_function.proowner is distinct from original_function.proowner
      or revised_function.proacl is distinct from original_function.proacl
      or revised_function.proconfig is distinct from original_function.proconfig
      or revised_function.prosecdef is distinct from original_function.prosecdef
      or revised_function.provolatile is distinct from original_function.provolatile
      or revised_function.proargdefaults is distinct from original_function.proargdefaults
    then
      raise check_violation using message = 'Timekeeping collection change did not preserve the verified function boundary.';
    end if;
  end loop;
end
$collect_timekeeping_rows_once$;
with started as materialized(select clock_timestamp() as started_at), candidate as materialized(select public.get_timekeeping_review(date '2026-10-04',date '2026-10-17')-'serverTimestamp' as payload from started) insert into timekeeping_equivalence_result select 'recent_historical',candidate.payload=baseline.payload,jsonb_array_length(candidate.payload->'rows'),round(extract(epoch from clock_timestamp()-started.started_at)*1000,3) from started cross join candidate join timekeeping_before_review baseline on baseline.case_name='recent_historical';
with started as materialized(select clock_timestamp() as started_at), candidate as materialized(select public.get_timekeeping_review(date '2026-10-18',date '2026-10-31')-'serverTimestamp' as payload from started) insert into timekeeping_equivalence_result select 'current_period',candidate.payload=baseline.payload,jsonb_array_length(candidate.payload->'rows'),round(extract(epoch from clock_timestamp()-started.started_at)*1000,3) from started cross join candidate join timekeeping_before_review baseline on baseline.case_name='current_period';
with started as materialized(select clock_timestamp() as started_at), candidate as materialized(select public.get_timekeeping_review(date '2026-09-20',date '2026-10-03')-'serverTimestamp' as payload from started) insert into timekeeping_equivalence_result select 'older_historical',candidate.payload=baseline.payload,jsonb_array_length(candidate.payload->'rows'),round(extract(epoch from clock_timestamp()-started.started_at)*1000,3) from started cross join candidate join timekeeping_before_review baseline on baseline.case_name='older_historical';
with started as materialized(select clock_timestamp() as started_at), candidate as materialized(select public.get_timekeeping_review(date '2099-01-04',date '2099-01-17')-'serverTimestamp' as payload from started) insert into timekeeping_equivalence_result select 'empty_future',candidate.payload=baseline.payload,jsonb_array_length(candidate.payload->'rows'),round(extract(epoch from clock_timestamp()-started.started_at)*1000,3) from started cross join candidate join timekeeping_before_review baseline on baseline.case_name='empty_future';
with started as materialized(select clock_timestamp() as started_at), candidate as materialized(select private.get_timekeeping_review_base(date '2026-09-04',date '2026-10-19')-'serverTimestamp' as payload from started) insert into timekeeping_equivalence_result select 'wide_base',candidate.payload=baseline.payload,jsonb_array_length(candidate.payload->'rows'),round(extract(epoch from clock_timestamp()-started.started_at)*1000,3) from started cross join candidate join timekeeping_before_review baseline on baseline.case_name='wide_base';
do $assert_payloads$ begin if exists(select 1 from timekeeping_equivalence_result where payload_equal is distinct from true) or (select count(*) from timekeeping_equivalence_result)<>5 then raise check_violation using message='Collection candidate changed ordered review payload content.';end if;end $assert_payloads$;

select jsonb_build_object('status','passed','cases',jsonb_agg(to_jsonb(result) order by case_name)) as equivalence from timekeeping_equivalence_result result;
rollback;
