begin;

-- The source-lifecycle routines were added after the immediate-availability
-- migration removed the legacy scan-state helper. Rewrite only the three
-- known late-added routines against the current protected-storage boundary.
do $$
declare
  target_function regprocedure;
  function_definition text;
begin
  foreach target_function in array array[
    'private.register_hr_system_item(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,text[],text,integer,text,jsonb,text,text)'::regprocedure,
    'public.service_adopt_hr_library_source(uuid,uuid,timestamp with time zone,text,text,text)'::regprocedure,
    'public.service_retire_hr_library_source(uuid,uuid,timestamp with time zone,text,text,text)'::regprocedure
  ] loop
    function_definition := pg_get_functiondef(target_function::oid);
    if position('private.hr_document_latest_scan_state' in function_definition) = 0 then
      raise exception 'Expected legacy document availability reference is absent from %.', target_function::text;
    end if;

    function_definition := replace(
      function_definition,
      'private.hr_document_latest_scan_state',
      'private.hr_document_latest_availability_state'
    );
    function_definition := replace(
      function_definition,
      'The source file has not passed security review.',
      'The protected source file is not available.'
    );
    execute function_definition;
  end loop;
end
$$;

-- Reusable source PDFs belong in the source catalog, not in the permanent
-- employee/company records list. Patch the authoritative base workspace
-- function before it counts or paginates so totals and pages remain correct.
do $$
declare
  workspace_function regprocedure := 'public.service_get_hr_document_workspace(uuid,text,uuid,text,boolean,integer,integer)'::regprocedure;
  function_definition text;
  archive_filter constant text := 'and (coalesce(target_include_archived, false) or document.archived_at is null)';
  source_exclusion constant text := E'and (coalesce(target_include_archived, false) or document.archived_at is null)\n      and not exists (\n        select 1\n        from private.hr_template_library_items library_item\n        where library_item.source_document_id = document.id\n      )';
  occurrence_count integer;
begin
  function_definition := pg_get_functiondef(workspace_function::oid);
  occurrence_count := (
    length(function_definition) - length(replace(function_definition, archive_filter, ''))
  ) / length(archive_filter);

  if occurrence_count <> 2 then
    raise exception 'The HR document workspace filter changed; expected 2 archive filters, found %.', occurrence_count;
  end if;

  execute replace(function_definition, archive_filter, source_exclusion);
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_proc function_record
    join pg_namespace function_schema on function_schema.oid = function_record.pronamespace
    where function_record.prokind = 'f'
      and function_schema.nspname in ('public', 'private')
      and pg_get_functiondef(function_record.oid) like '%private.hr_document_latest_scan_state%'
  ) then
    raise exception 'A live document function still depends on the deleted scan-state helper.';
  end if;

  if (
    length(pg_get_functiondef('public.service_get_hr_document_workspace(uuid,text,uuid,text,boolean,integer,integer)'::regprocedure))
      - length(replace(
        pg_get_functiondef('public.service_get_hr_document_workspace(uuid,text,uuid,text,boolean,integer,integer)'::regprocedure),
        'library_item.source_document_id = document.id',
        ''
      ))
  ) / length('library_item.source_document_id = document.id') <> 2 then
    raise exception 'The HR document workspace did not receive both source-library exclusions.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
