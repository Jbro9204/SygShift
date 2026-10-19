begin;
set local lock_timeout = '2s';
set local statement_timeout = '8s';

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

commit;
