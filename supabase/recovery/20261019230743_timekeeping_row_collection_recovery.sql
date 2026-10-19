begin;

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

commit;
