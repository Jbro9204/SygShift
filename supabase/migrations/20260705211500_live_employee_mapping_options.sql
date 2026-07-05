set search_path = '';

create or replace function private.import_employee_mapping_key_is_valid(
  target_import_run_id uuid,
  target_employee_mapping_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.current_import_mappings mapping
    where mapping.import_run_id = target_import_run_id
      and mapping.mapping_type = 'employee'
      and mapping.mapping_key = target_employee_mapping_key
  )
  or exists (
    select 1
    from public.employees employee
    where target_employee_mapping_key = 'employee:' || employee.id::text
      and employee.status = 'active'
  )
$$;

create or replace function public.get_import_employee_mapping_options(target_import_run_id uuid)
returns table (
  mapping_key text,
  display_name text,
  source_type text,
  employee_status public.employee_status
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_import_admin();

  return query
  with mapped_options as (
    select
      mapping.mapping_key,
      btrim(concat_ws(
        ' ',
        mapping.decision ->> 'firstName',
        mapping.decision ->> 'middleName',
        mapping.decision ->> 'lastName'
      )) as display_name,
      coalesce(mapping.decision ->> 'sourceType', 'import_mapping') as source_type,
      (mapping.decision ->> 'status')::public.employee_status as employee_status
    from private.current_import_mappings mapping
    where mapping.import_run_id = target_import_run_id
      and mapping.mapping_type = 'employee'
      and coalesce((mapping.decision ->> 'status')::public.employee_status, 'active'::public.employee_status) = 'active'
  ),
  live_options as (
    select
      'employee:' || employee.id::text as mapping_key,
      btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) as display_name,
      'live_directory' as source_type,
      employee.status as employee_status
    from public.employees employee
    where employee.status = 'active'
  )
  select distinct on (combined.mapping_key)
    combined.mapping_key,
    combined.display_name,
    combined.source_type,
    combined.employee_status
  from (
    select * from mapped_options
    union all
    select * from live_options
  ) combined
  order by combined.mapping_key, combined.display_name;
end
$$;

create or replace function public.save_import_assignee_alias_mapping(
  target_import_run_id uuid,
  target_source_label text,
  target_disposition text,
  target_employee_mapping_keys text[],
  target_note text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  normalized_source_label text := private.normalize_import_label(target_source_label);
  employee_keys text[] := coalesce(target_employee_mapping_keys, '{}'::text[]);
  employee_key text;
  decision jsonb;
begin
  perform private.require_import_admin();
  if normalized_source_label = '' or not exists (
    select 1 from private.import_assignee_alias_inventory alias
    where alias.import_run_id = target_import_run_id and alias.normalized_label = normalized_source_label
  ) then
    raise check_violation using message = 'The assignee label is unavailable in this import.';
  end if;
  if target_disposition not in ('employee', 'multiple_employees', 'open', 'exclude') then
    raise check_violation using message = 'Invalid assignee-label disposition.';
  end if;
  if (target_disposition = 'employee' and cardinality(employee_keys) <> 1)
    or (target_disposition = 'multiple_employees' and cardinality(employee_keys) < 2)
    or (target_disposition in ('open', 'exclude') and cardinality(employee_keys) <> 0)
  then
    raise check_violation using message = 'The employee mappings do not match the selected disposition.';
  end if;
  if cardinality(employee_keys) <> (select count(distinct key_value) from unnest(employee_keys) key_value) then
    raise check_violation using message = 'Duplicate employee mappings are not allowed.';
  end if;
  foreach employee_key in array employee_keys loop
    if not private.import_employee_mapping_key_is_valid(target_import_run_id, employee_key) then
      raise check_violation using message = 'Every assignee target must be an active reviewed or live Directory employee.';
    end if;
  end loop;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A mapping note of 4,000 characters or fewer is required.';
  end if;

  decision := jsonb_build_object(
    'sourceLabel', target_source_label,
    'normalizedLabel', normalized_source_label,
    'disposition', target_disposition,
    'employeeMappingKeys', to_jsonb(employee_keys)
  );
  return private.record_import_mapping(
    target_import_run_id,
    null,
    'assignee_alias',
    normalized_source_label,
    decision,
    target_note,
    reviewer_id
  );
end
$$;

create or replace function public.save_import_shift_override(
  target_candidate_id uuid,
  target_disposition text,
  target_employee_mapping_keys text[],
  target_note text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  candidate_record private.import_candidates%rowtype;
  employee_keys text[] := coalesce(target_employee_mapping_keys, '{}'::text[]);
  employee_key text;
  decision jsonb;
begin
  perform private.require_import_admin();
  select * into candidate_record
  from private.import_candidates candidate
  where candidate.id = target_candidate_id
  for update;

  if not found or candidate_record.kind <> 'shift' then
    raise check_violation using message = 'The shift import candidate is unavailable.';
  end if;
  if exists (
    select 1 from private.import_entity_links link
    where link.candidate_id = target_candidate_id and link.entity_table in ('shifts', 'shift_assignments')
  ) then
    raise check_violation using message = 'A promoted shift mapping cannot be changed.';
  end if;
  if target_disposition not in ('employee', 'multiple_employees', 'open', 'exclude') then
    raise check_violation using message = 'Invalid shift-override disposition.';
  end if;
  if (target_disposition = 'employee' and cardinality(employee_keys) <> 1)
    or (target_disposition = 'multiple_employees' and cardinality(employee_keys) < 2)
    or (target_disposition in ('open', 'exclude') and cardinality(employee_keys) <> 0)
  then
    raise check_violation using message = 'The employee mappings do not match the selected shift override.';
  end if;
  if cardinality(employee_keys) <> (select count(distinct key_value) from unnest(employee_keys) key_value) then
    raise check_violation using message = 'Duplicate employee mappings are not allowed.';
  end if;
  foreach employee_key in array employee_keys loop
    if not private.import_employee_mapping_key_is_valid(candidate_record.import_run_id, employee_key) then
      raise check_violation using message = 'Every shift-override target must be an active reviewed or live Directory employee.';
    end if;
  end loop;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A mapping note of 4,000 characters or fewer is required.';
  end if;

  decision := jsonb_build_object(
    'disposition', target_disposition,
    'employeeMappingKeys', to_jsonb(employee_keys)
  );
  return private.record_import_mapping(
    candidate_record.import_run_id,
    target_candidate_id,
    'shift_override',
    'candidate:' || candidate_record.id::text,
    decision,
    target_note,
    reviewer_id
  );
end
$$;

revoke all on function private.import_employee_mapping_key_is_valid(uuid, text) from public, anon, authenticated;
revoke all on function public.get_import_employee_mapping_options(uuid) from public, anon;
revoke all on function public.save_import_assignee_alias_mapping(uuid, text, text, text[], text) from public, anon;
revoke all on function public.save_import_shift_override(uuid, text, text[], text) from public, anon;

grant execute on function public.get_import_employee_mapping_options(uuid) to authenticated;
grant execute on function public.save_import_assignee_alias_mapping(uuid, text, text, text[], text) to authenticated;
grant execute on function public.save_import_shift_override(uuid, text, text[], text) to authenticated;
