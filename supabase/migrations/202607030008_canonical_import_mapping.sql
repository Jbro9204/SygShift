begin;

create table private.import_mapping_decisions (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  candidate_id uuid references private.import_candidates(id) on delete restrict,
  mapping_type text not null check (mapping_type in ('employee', 'site', 'assignee_alias', 'shift_override')),
  mapping_key text not null,
  decision jsonb not null,
  note text not null,
  decided_by uuid not null references public.employees(id) on delete restrict,
  decided_at timestamptz not null default clock_timestamp(),
  supersedes_id bigint references private.import_mapping_decisions(id) on delete restrict,
  constraint import_mapping_key_present check (btrim(mapping_key) <> ''),
  constraint import_mapping_note_present check (btrim(note) <> ''),
  constraint import_mapping_decision_object check (jsonb_typeof(decision) = 'object')
);

create index import_mapping_decisions_lookup_idx
  on private.import_mapping_decisions(import_run_id, mapping_type, mapping_key, id desc);

create trigger import_mapping_decisions_append_only
before update or delete on private.import_mapping_decisions
for each row execute function private.prevent_append_only_change();

create view private.current_import_mappings as
select distinct on (decision.import_run_id, decision.mapping_type, decision.mapping_key)
  decision.id,
  decision.import_run_id,
  decision.candidate_id,
  decision.mapping_type,
  decision.mapping_key,
  decision.decision,
  decision.note,
  decision.decided_by,
  decision.decided_at,
  decision.supersedes_id
from private.import_mapping_decisions decision
order by decision.import_run_id, decision.mapping_type, decision.mapping_key, decision.id desc;

create table private.import_entity_links (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  promotion_batch_id uuid,
  candidate_id uuid references private.import_candidates(id) on delete restrict,
  mapping_decision_id bigint references private.import_mapping_decisions(id) on delete restrict,
  entity_table text not null check (
    entity_table in ('employees', 'employee_credentials', 'sites', 'posts', 'schedules', 'shifts', 'shift_assignments')
  ),
  entity_id uuid not null,
  relation text not null default 'primary',
  created_at timestamptz not null default clock_timestamp(),
  constraint import_entity_link_source check (num_nonnulls(candidate_id, mapping_decision_id) >= 1),
  constraint import_entity_link_relation_present check (btrim(relation) <> ''),
  constraint import_entity_link_unique unique (import_run_id, entity_table, entity_id, relation)
);

create index import_entity_links_candidate_idx on private.import_entity_links(candidate_id);
create index import_entity_links_mapping_idx on private.import_entity_links(mapping_decision_id);

create trigger import_entity_links_append_only
before update or delete on private.import_entity_links
for each row execute function private.prevent_append_only_change();

create function private.normalize_import_label(value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', '', 'g')
$$;

create view private.import_employee_alias_proposals as
with employee_tokens as (
  select
    candidate.import_run_id,
    candidate.id candidate_id,
    regexp_split_to_array(lower(btrim(candidate.payload ->> 'name')), '[[:space:]]+') tokens
  from private.import_candidates candidate
  where candidate.kind = 'employee'
), aliases as (
  select
    employee.import_run_id,
    employee.candidate_id,
    alias.kind,
    private.normalize_import_label(alias.value) normalized_label
  from employee_tokens employee
  cross join lateral (
    values
      ('full', array_to_string(employee.tokens, '')),
      ('first', case when array_length(employee.tokens, 1) >= 2 then employee.tokens[1] end),
      ('last', case when array_length(employee.tokens, 1) >= 2 then employee.tokens[array_length(employee.tokens, 1)] end),
      ('initial_last', case when array_length(employee.tokens, 1) >= 2
        then left(employee.tokens[1], 1) || employee.tokens[array_length(employee.tokens, 1)] end),
      ('first_initial', case when array_length(employee.tokens, 1) >= 2
        then employee.tokens[1] || left(employee.tokens[array_length(employee.tokens, 1)], 1) end)
  ) alias(kind, value)
  where coalesce(alias.value, '') <> ''
), unique_aliases as (
  select
    alias.import_run_id,
    alias.normalized_label,
    min(alias.candidate_id::text)::uuid candidate_id,
    string_agg(distinct alias.kind, ',' order by alias.kind) match_methods
  from aliases alias
  where alias.normalized_label <> ''
  group by alias.import_run_id, alias.normalized_label
  having count(distinct alias.candidate_id) = 1
)
select
  unique_alias.import_run_id,
  unique_alias.normalized_label,
  unique_alias.candidate_id employee_candidate_id,
  'candidate:' || unique_alias.candidate_id::text employee_mapping_key,
  unique_alias.match_methods
from unique_aliases unique_alias;

create view private.import_assignee_alias_inventory as
select
  candidate.import_run_id,
  private.normalize_import_label(candidate.payload ->> 'assigneeLabel') normalized_label,
  jsonb_agg(distinct candidate.payload ->> 'assigneeLabel' order by candidate.payload ->> 'assigneeLabel') label_variants,
  count(*) shift_count,
  min((candidate.payload ->> 'localDate')::date) first_shift_on,
  max((candidate.payload ->> 'localDate')::date) last_shift_on
from private.import_candidates candidate
where candidate.kind = 'shift'
  and btrim(coalesce(candidate.payload ->> 'assigneeLabel', '')) <> ''
group by candidate.import_run_id, private.normalize_import_label(candidate.payload ->> 'assigneeLabel');

create function private.record_import_mapping(
  target_import_run_id uuid,
  target_candidate_id uuid,
  target_mapping_type text,
  target_mapping_key text,
  target_decision jsonb,
  target_note text,
  reviewer_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_id bigint;
  new_id bigint;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(target_import_run_id::text || ':' || target_mapping_type || ':' || target_mapping_key, 0)
  );

  select mapping.id into previous_id
  from private.current_import_mappings mapping
  where mapping.import_run_id = target_import_run_id
    and mapping.mapping_type = target_mapping_type
    and mapping.mapping_key = target_mapping_key;

  insert into private.import_mapping_decisions (
    import_run_id,
    candidate_id,
    mapping_type,
    mapping_key,
    decision,
    note,
    decided_by,
    supersedes_id
  ) values (
    target_import_run_id,
    target_candidate_id,
    target_mapping_type,
    target_mapping_key,
    target_decision,
    btrim(target_note),
    reviewer_id,
    previous_id
  ) returning id into new_id;

  return new_id;
end
$$;

create function private.accept_mapped_candidate(
  target_candidate_id uuid,
  target_note text,
  reviewer_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate_record private.import_candidates%rowtype;
  resulting_record jsonb;
begin
  select * into candidate_record
  from private.import_candidates candidate
  where candidate.id = target_candidate_id
  for update;

  if not found then
    raise check_violation using message = 'The import candidate is unavailable.';
  end if;
  if candidate_record.review_status in ('rejected', 'superseded') then
    raise check_violation using message = 'A rejected or duplicate candidate cannot be mapped.';
  end if;
  if candidate_record.review_status = 'accepted' then
    return;
  end if;

  update private.import_candidates
  set
    review_status = 'accepted',
    reviewed_by = reviewer_id,
    reviewed_at = clock_timestamp(),
    review_note = btrim(target_note)
  where id = target_candidate_id
  returning to_jsonb(import_candidates.*) into resulting_record;

  insert into private.import_review_decisions (
    import_run_id,
    candidate_id,
    decision,
    note,
    decided_by,
    previous_record,
    resulting_record
  ) values (
    candidate_record.import_run_id,
    candidate_record.id,
    'accepted',
    btrim(target_note),
    reviewer_id,
    to_jsonb(candidate_record),
    resulting_record
  );
end
$$;

create function public.save_import_employee_mapping(
  target_candidate_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_personal_email text,
  target_company_email text,
  target_mobile_phone text,
  target_guard_license_number text,
  target_guard_license_expires_on date,
  target_armed_status text,
  target_armed_credential_number text,
  target_armed_expires_on date,
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
  mapping_id bigint;
  decision jsonb;
begin
  perform private.require_import_admin();

  select * into candidate_record
  from private.import_candidates candidate
  where candidate.id = target_candidate_id
  for update;

  if not found or candidate_record.kind <> 'employee' then
    raise check_violation using message = 'The employee import candidate is unavailable.';
  end if;
  if exists (select 1 from private.import_entity_links link where link.candidate_id = target_candidate_id) then
    raise check_violation using message = 'A promoted employee mapping cannot be changed.';
  end if;
  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;
  if char_length(btrim(target_first_name)) > 120 or char_length(btrim(target_last_name)) > 120
    or char_length(btrim(coalesce(target_middle_name, ''))) > 120
    or char_length(btrim(coalesce(target_preferred_name, ''))) > 120
  then
    raise check_violation using message = 'An employee name exceeds 120 characters.';
  end if;
  if target_armed_status not in ('not_armed', 'pending_verification', 'active') then
    raise check_violation using message = 'Invalid armed-credential status.';
  end if;
  if target_armed_status = 'active'
    and (
      btrim(coalesce(target_armed_credential_number, '')) = ''
      or target_armed_expires_on is null
      or target_armed_expires_on < current_date
    )
  then
    raise check_violation using message = 'An active armed credential requires a number and a current expiration date.';
  end if;
  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;
  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A mapping note of 4,000 characters or fewer is required.';
  end if;

  decision := jsonb_build_object(
    'sourceType', 'directory_candidate',
    'firstName', btrim(target_first_name),
    'middleName', nullif(btrim(coalesce(target_middle_name, '')), ''),
    'lastName', btrim(target_last_name),
    'preferredName', nullif(btrim(coalesce(target_preferred_name, '')), ''),
    'role', target_role,
    'employmentType', target_employment_type,
    'status', target_status,
    'personalEmail', nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
    'companyEmail', nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
    'mobilePhone', nullif(btrim(coalesce(target_mobile_phone, '')), ''),
    'guardLicenseNumber', nullif(btrim(coalesce(target_guard_license_number, '')), ''),
    'guardLicenseExpiresOn', target_guard_license_expires_on,
    'armedStatus', target_armed_status,
    'armedCredentialNumber', nullif(btrim(coalesce(target_armed_credential_number, '')), ''),
    'armedExpiresOn', target_armed_expires_on
  );

  mapping_id := private.record_import_mapping(
    candidate_record.import_run_id,
    candidate_record.id,
    'employee',
    'candidate:' || candidate_record.id::text,
    decision,
    target_note,
    reviewer_id
  );
  perform private.accept_mapped_candidate(candidate_record.id, target_note, reviewer_id);
  return mapping_id;
end
$$;

create function public.save_import_schedule_employee_mapping(
  target_import_run_id uuid,
  target_source_label text,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_status public.employee_status,
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
  decision jsonb;
begin
  perform private.require_import_admin();
  if normalized_source_label = '' then
    raise check_violation using message = 'A schedule employee label is required.';
  end if;
  if not exists (
    select 1 from private.import_assignee_alias_inventory alias
    where alias.import_run_id = target_import_run_id and alias.normalized_label = normalized_source_label
  ) then
    raise check_violation using message = 'The schedule employee label is not present in this import.';
  end if;
  if exists (
    select 1
    from private.import_mapping_decisions mapping
    join private.import_entity_links link
      on link.mapping_decision_id = mapping.id and link.entity_table = 'employees'
    where mapping.import_run_id = target_import_run_id
      and mapping.mapping_type = 'employee'
      and mapping.mapping_key = 'schedule:' || normalized_source_label
  ) then
    raise check_violation using message = 'A promoted schedule-only employee mapping cannot be changed.';
  end if;
  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A mapping note of 4,000 characters or fewer is required.';
  end if;

  decision := jsonb_build_object(
    'sourceType', 'schedule_only',
    'sourceLabel', target_source_label,
    'firstName', btrim(target_first_name),
    'middleName', nullif(btrim(coalesce(target_middle_name, '')), ''),
    'lastName', btrim(target_last_name),
    'preferredName', null,
    'role', 'guard',
    'employmentType', 'hourly',
    'status', target_status,
    'personalEmail', null,
    'companyEmail', null,
    'mobilePhone', null,
    'guardLicenseNumber', null,
    'guardLicenseExpiresOn', null,
    'armedStatus', 'pending_verification',
    'armedCredentialNumber', null,
    'armedExpiresOn', null
  );

  return private.record_import_mapping(
    target_import_run_id,
    null,
    'employee',
    'schedule:' || normalized_source_label,
    decision,
    target_note,
    reviewer_id
  );
end
$$;

create function public.save_import_site_mapping(
  target_candidate_id uuid,
  target_canonical_site_key text,
  target_site_code text,
  target_site_name text,
  target_post_name text,
  target_requires_armed boolean,
  target_active boolean,
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
  canonical_key text := regexp_replace(lower(btrim(coalesce(target_canonical_site_key, ''))), '[^a-z0-9]+', '-', 'g');
  mapping_id bigint;
  decision jsonb;
begin
  perform private.require_import_admin();
  select * into candidate_record
  from private.import_candidates candidate
  where candidate.id = target_candidate_id
  for update;

  if not found or candidate_record.kind <> 'site' then
    raise check_violation using message = 'The site import candidate is unavailable.';
  end if;
  if exists (select 1 from private.import_entity_links link where link.candidate_id = target_candidate_id) then
    raise check_violation using message = 'A promoted site mapping cannot be changed.';
  end if;
  if canonical_key = '' or btrim(coalesce(target_site_name, '')) = '' or btrim(coalesce(target_post_name, '')) = '' then
    raise check_violation using message = 'Canonical site key, site name, and post name are required.';
  end if;
  if char_length(canonical_key) > 120 or char_length(btrim(target_site_name)) > 200
    or char_length(btrim(target_post_name)) > 200 or char_length(btrim(coalesce(target_site_code, ''))) > 40
  then
    raise check_violation using message = 'A site mapping field exceeds its maximum length.';
  end if;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A mapping note of 4,000 characters or fewer is required.';
  end if;

  decision := jsonb_build_object(
    'canonicalSiteKey', canonical_key,
    'siteCode', nullif(upper(btrim(coalesce(target_site_code, ''))), ''),
    'siteName', btrim(target_site_name),
    'postName', btrim(target_post_name),
    'requiresArmed', target_requires_armed,
    'active', target_active
  );
  mapping_id := private.record_import_mapping(
    candidate_record.import_run_id,
    candidate_record.id,
    'site',
    'candidate:' || candidate_record.id::text,
    decision,
    target_note,
    reviewer_id
  );
  perform private.accept_mapped_candidate(candidate_record.id, target_note, reviewer_id);
  return mapping_id;
end
$$;

create function public.save_import_assignee_alias_mapping(
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
    if not exists (
      select 1 from private.current_import_mappings mapping
      where mapping.import_run_id = target_import_run_id
        and mapping.mapping_type = 'employee'
        and mapping.mapping_key = employee_key
    ) then
      raise check_violation using message = 'Every assignee target must have a reviewed employee mapping.';
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

create function public.save_import_shift_override(
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
    if not exists (
      select 1 from private.current_import_mappings mapping
      where mapping.import_run_id = candidate_record.import_run_id
        and mapping.mapping_type = 'employee'
        and mapping.mapping_key = employee_key
    ) then
      raise check_violation using message = 'Every shift-override target must have a reviewed employee mapping.';
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
    candidate_record.id,
    'shift_override',
    'candidate:' || candidate_record.id::text,
    decision,
    target_note,
    reviewer_id
  );
end
$$;

create function public.save_import_schedule_employee_and_alias(
  target_import_run_id uuid,
  target_source_label text,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_status public.employee_status,
  target_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_source_label text := private.normalize_import_label(target_source_label);
begin
  perform private.require_import_admin();
  perform public.save_import_schedule_employee_mapping(
    target_import_run_id,
    target_source_label,
    target_first_name,
    target_middle_name,
    target_last_name,
    target_status,
    target_note
  );
  perform public.save_import_assignee_alias_mapping(
    target_import_run_id,
    target_source_label,
    'employee',
    array['schedule:' || normalized_source_label],
    target_note
  );
  return true;
end
$$;

create function public.accept_import_schedule_scope(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  target_note text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  candidate_record private.import_candidates%rowtype;
  accepted_count integer := 0;
begin
  perform private.require_import_admin();
  if target_through_date < target_from_date then
    raise check_violation using message = 'The schedule review date range is invalid.';
  end if;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A review note of 4,000 characters or fewer is required.';
  end if;
  if exists (
    select 1
    from private.import_candidates candidate
    where candidate.import_run_id = target_import_run_id and candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date
    group by candidate.payload ->> 'weekStartsOn'
    having count(*) <> 1
  ) then
    raise check_violation using message = 'The schedule scope contains duplicate week candidates.';
  end if;

  for candidate_record in
    select candidate.*
    from private.import_candidates candidate
    where candidate.import_run_id = target_import_run_id
      and candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date
      and candidate.review_status = 'pending'
    order by candidate.payload ->> 'weekStartsOn'
    for update
  loop
    perform private.accept_mapped_candidate(candidate_record.id, target_note, reviewer_id);
    accepted_count := accepted_count + 1;
  end loop;
  return accepted_count;
end
$$;

create function public.get_import_employee_mapping_queue(
  target_import_run_id uuid,
  page_size integer default 100,
  page_offset integer default 0
)
returns table (
  candidate_id uuid,
  candidate_key text,
  source_payload jsonb,
  current_mapping jsonb,
  mapping_decided_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_import_admin();
  if page_size < 1 or page_size > 100 or page_offset < 0 then
    raise check_violation using message = 'Invalid employee mapping page request.';
  end if;
  return query
  select
    candidate.id,
    candidate.candidate_key,
    candidate.payload,
    mapping.decision,
    mapping.decided_at,
    count(*) over()
  from private.import_candidates candidate
  left join private.current_import_mappings mapping
    on mapping.import_run_id = candidate.import_run_id
    and mapping.mapping_type = 'employee'
    and mapping.mapping_key = 'candidate:' || candidate.id::text
  where candidate.import_run_id = target_import_run_id and candidate.kind = 'employee'
  order by (mapping.id is not null), candidate.payload ->> 'name', candidate.id
  limit page_size offset page_offset;
end
$$;

create function public.get_import_site_mapping_queue(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  page_size integer default 100,
  page_offset integer default 0
)
returns table (
  candidate_id uuid,
  candidate_key text,
  source_payload jsonb,
  scope_shift_count bigint,
  current_mapping jsonb,
  mapping_decided_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_import_admin();
  if target_through_date < target_from_date or page_size < 1 or page_size > 100 or page_offset < 0 then
    raise check_violation using message = 'Invalid site mapping page request.';
  end if;
  return query
  with scoped_sites as (
    select
      shift.payload ->> 'siteKeyCandidate' site_key,
      count(*) shift_count
    from private.import_candidates shift
    where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
      and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
      and shift.payload ->> 'siteKeyCandidate' is not null
    group by shift.payload ->> 'siteKeyCandidate'
  )
  select
    candidate.id,
    candidate.candidate_key,
    candidate.payload,
    scoped.shift_count,
    mapping.decision,
    mapping.decided_at,
    count(*) over()
  from scoped_sites scoped
  join private.import_candidates candidate
    on candidate.import_run_id = target_import_run_id
    and candidate.kind = 'site'
    and candidate.payload ->> 'siteKeyCandidate' = scoped.site_key
  left join private.current_import_mappings mapping
    on mapping.import_run_id = candidate.import_run_id
    and mapping.mapping_type = 'site'
    and mapping.mapping_key = 'candidate:' || candidate.id::text
  order by (mapping.id is not null), candidate.payload ->> 'siteKeyCandidate', candidate.id
  limit page_size offset page_offset;
end
$$;

create function public.get_import_assignee_alias_queue(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  page_size integer default 100,
  page_offset integer default 0
)
returns table (
  normalized_label text,
  label_variants jsonb,
  scope_shift_count bigint,
  first_shift_on date,
  last_shift_on date,
  suggested_employee_mapping_key text,
  suggested_employee_name text,
  suggestion_method text,
  suggestion_ready boolean,
  current_mapping jsonb,
  mapping_decided_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_import_admin();
  if target_through_date < target_from_date or page_size < 1 or page_size > 100 or page_offset < 0 then
    raise check_violation using message = 'Invalid assignee mapping page request.';
  end if;
  return query
  with scoped_aliases as (
    select
      private.normalize_import_label(shift.payload ->> 'assigneeLabel') normalized,
      jsonb_agg(distinct shift.payload ->> 'assigneeLabel' order by shift.payload ->> 'assigneeLabel') variants,
      count(*) count,
      min((shift.payload ->> 'localDate')::date) first_on,
      max((shift.payload ->> 'localDate')::date) last_on
    from private.import_candidates shift
    where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
      and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
      and btrim(coalesce(shift.payload ->> 'assigneeLabel', '')) <> ''
    group by private.normalize_import_label(shift.payload ->> 'assigneeLabel')
  )
  select
    scoped.normalized,
    scoped.variants,
    scoped.count,
    scoped.first_on,
    scoped.last_on,
    proposal.employee_mapping_key,
    employee.payload ->> 'name',
    proposal.match_methods,
    exists (
      select 1 from private.current_import_mappings employee_mapping
      where employee_mapping.import_run_id = target_import_run_id
        and employee_mapping.mapping_type = 'employee'
        and employee_mapping.mapping_key = proposal.employee_mapping_key
    ),
    mapping.decision,
    mapping.decided_at,
    count(*) over()
  from scoped_aliases scoped
  left join private.import_employee_alias_proposals proposal
    on proposal.import_run_id = target_import_run_id and proposal.normalized_label = scoped.normalized
  left join private.import_candidates employee on employee.id = proposal.employee_candidate_id
  left join private.current_import_mappings mapping
    on mapping.import_run_id = target_import_run_id
    and mapping.mapping_type = 'assignee_alias'
    and mapping.mapping_key = scoped.normalized
  order by (mapping.id is not null), scoped.count desc, scoped.normalized
  limit page_size offset page_offset;
end
$$;

create function public.get_import_employee_mapping_options(target_import_run_id uuid)
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
  select
    mapping.mapping_key,
    concat_ws(
      ' ',
      mapping.decision ->> 'firstName',
      mapping.decision ->> 'middleName',
      mapping.decision ->> 'lastName'
    ),
    mapping.decision ->> 'sourceType',
    (mapping.decision ->> 'status')::public.employee_status
  from private.current_import_mappings mapping
  where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'employee'
  order by mapping.decision ->> 'lastName', mapping.decision ->> 'firstName', mapping.mapping_key;
end
$$;

create function public.get_import_mapping_readiness(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_import_admin();
  if target_through_date < target_from_date then
    raise check_violation using message = 'The import readiness date range is invalid.';
  end if;

  with scope_shifts as (
    select candidate.*
    from private.import_candidates candidate
    where candidate.import_run_id = target_import_run_id and candidate.kind = 'shift'
      and (candidate.payload ->> 'localDate')::date between target_from_date and target_through_date
  ), scope_schedules as (
    select candidate.*
    from private.import_candidates candidate
    where candidate.import_run_id = target_import_run_id and candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date
  ), scope_sites as (
    select distinct shift.payload ->> 'siteKeyCandidate' site_key
    from scope_shifts shift where shift.payload ->> 'siteKeyCandidate' is not null
  ), scope_aliases as (
    select distinct private.normalize_import_label(shift.payload ->> 'assigneeLabel') normalized_label
    from scope_shifts shift where btrim(coalesce(shift.payload ->> 'assigneeLabel', '')) <> ''
  ), counts as (
    select
      (select count(*) from private.import_candidates candidate where candidate.import_run_id = target_import_run_id and candidate.kind = 'employee') employee_candidates,
      (select count(*) from private.current_import_mappings mapping where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'employee' and mapping.mapping_key like 'candidate:%') directory_employee_mappings,
      (select count(*) from scope_schedules) schedule_candidates,
      (select count(*) from scope_schedules schedule where schedule.review_status = 'accepted') accepted_schedules,
      (select count(*) from scope_shifts) shift_candidates,
      (select count(*) from scope_shifts shift where btrim(coalesce(shift.payload ->> 'assigneeLabel', '')) = '') source_open_shifts,
      (select count(*) from scope_shifts shift where shift.payload ->> 'siteKeyCandidate' is null) missing_context_shifts,
      (select count(*) from scope_sites) site_keys,
      (select count(*) from scope_sites site join private.import_candidates candidate on candidate.import_run_id = target_import_run_id and candidate.kind = 'site' and candidate.payload ->> 'siteKeyCandidate' = site.site_key join private.current_import_mappings mapping on mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site' and mapping.mapping_key = 'candidate:' || candidate.id::text) site_mappings,
      (select count(*) from scope_aliases) assignee_labels,
      (select count(*) from scope_aliases alias join private.current_import_mappings mapping on mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'assignee_alias' and mapping.mapping_key = alias.normalized_label) alias_mappings,
      (select count(*) from scope_aliases alias join private.import_employee_alias_proposals proposal on proposal.import_run_id = target_import_run_id and proposal.normalized_label = alias.normalized_label left join private.current_import_mappings mapping on mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'assignee_alias' and mapping.mapping_key = alias.normalized_label where mapping.id is null) conservative_alias_suggestions
  )
  select jsonb_build_object(
    'importRunId', target_import_run_id,
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'employeeCandidateCount', employee_candidates,
    'directoryEmployeeMappingCount', directory_employee_mappings,
    'scheduleCandidateCount', schedule_candidates,
    'acceptedScheduleCount', accepted_schedules,
    'shiftCandidateCount', shift_candidates,
    'sourceOpenShiftCount', source_open_shifts,
    'missingContextShiftCount', missing_context_shifts,
    'siteKeyCount', site_keys,
    'siteMappingCount', site_mappings,
    'assigneeLabelCount', assignee_labels,
    'aliasMappingCount', alias_mappings,
    'conservativeAliasSuggestionCount', conservative_alias_suggestions,
    'directoryReady', employee_candidates = directory_employee_mappings,
    'scheduleReady', schedule_candidates > 0
      and schedule_candidates = accepted_schedules
      and shift_candidates > 0
      and missing_context_shifts = 0
      and site_keys = site_mappings
      and assignee_labels = alias_mappings
  ) into result
  from counts;

  return result;
end
$$;

revoke all on private.import_mapping_decisions, private.import_entity_links from public, anon, authenticated;
grant all on private.import_mapping_decisions, private.import_entity_links to service_role;
grant usage, select on all sequences in schema private to service_role;

revoke all on function public.save_import_employee_mapping(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, date, text, text, date, text) from public, anon;
revoke all on function public.save_import_schedule_employee_mapping(uuid, text, text, text, text, public.employee_status, text) from public, anon;
revoke all on function public.save_import_site_mapping(uuid, text, text, text, text, boolean, boolean, text) from public, anon;
revoke all on function public.save_import_assignee_alias_mapping(uuid, text, text, text[], text) from public, anon;
revoke all on function public.save_import_shift_override(uuid, text, text[], text) from public, anon;
revoke all on function public.save_import_schedule_employee_and_alias(uuid, text, text, text, text, public.employee_status, text) from public, anon;
revoke all on function public.accept_import_schedule_scope(uuid, date, date, text) from public, anon;
revoke all on function public.get_import_employee_mapping_queue(uuid, integer, integer) from public, anon;
revoke all on function public.get_import_site_mapping_queue(uuid, date, date, integer, integer) from public, anon;
revoke all on function public.get_import_assignee_alias_queue(uuid, date, date, integer, integer) from public, anon;
revoke all on function public.get_import_employee_mapping_options(uuid) from public, anon;
revoke all on function public.get_import_mapping_readiness(uuid, date, date) from public, anon;

grant execute on function public.save_import_employee_mapping(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, date, text, text, date, text) to authenticated;
grant execute on function public.save_import_schedule_employee_mapping(uuid, text, text, text, text, public.employee_status, text) to authenticated;
grant execute on function public.save_import_site_mapping(uuid, text, text, text, text, boolean, boolean, text) to authenticated;
grant execute on function public.save_import_assignee_alias_mapping(uuid, text, text, text[], text) to authenticated;
grant execute on function public.save_import_shift_override(uuid, text, text[], text) to authenticated;
grant execute on function public.save_import_schedule_employee_and_alias(uuid, text, text, text, text, public.employee_status, text) to authenticated;
grant execute on function public.accept_import_schedule_scope(uuid, date, date, text) to authenticated;
grant execute on function public.get_import_employee_mapping_queue(uuid, integer, integer) to authenticated;
grant execute on function public.get_import_site_mapping_queue(uuid, date, date, integer, integer) to authenticated;
grant execute on function public.get_import_assignee_alias_queue(uuid, date, date, integer, integer) to authenticated;
grant execute on function public.get_import_employee_mapping_options(uuid) to authenticated;
grant execute on function public.get_import_mapping_readiness(uuid, date, date) to authenticated;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

commit;
