begin;

create table private.import_promotion_batches (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references private.import_runs(id) on delete restrict,
  from_date date not null,
  through_date date not null,
  published boolean not null,
  employee_count integer not null,
  site_count integer not null,
  post_count integer not null,
  schedule_count integer not null,
  shift_count integer not null,
  assignment_count integer not null,
  excluded_shift_count integer not null,
  source_candidate_count integer not null,
  note text not null,
  promoted_by uuid not null references public.employees(id) on delete restrict,
  promoted_at timestamptz not null default clock_timestamp(),
  constraint import_promotion_dates check (through_date >= from_date),
  constraint import_promotion_counts check (
    employee_count >= 0 and site_count >= 0 and post_count >= 0 and schedule_count >= 0
    and shift_count >= 0 and assignment_count >= 0 and excluded_shift_count >= 0
    and source_candidate_count >= 0
  ),
  constraint import_promotion_note_present check (btrim(note) <> ''),
  constraint import_promotion_scope_unique unique (import_run_id, from_date, through_date)
);

alter table private.import_entity_links
  add constraint import_entity_links_promotion_batch_fk
  foreign key (promotion_batch_id) references private.import_promotion_batches(id) on delete restrict
  deferrable initially deferred;

create trigger import_promotion_batches_append_only
before update or delete on private.import_promotion_batches
for each row execute function private.prevent_append_only_change();

create table private.employee_operational_profiles (
  employee_id uuid primary key references public.employees(id) on delete restrict,
  source_candidate_id uuid unique references private.import_candidates(id) on delete restrict,
  source_mapping_decision_id bigint not null references private.import_mapping_decisions(id) on delete restrict,
  source_display_name text,
  location_text text,
  schedule_availability text,
  employee_dg text,
  expected_hours_text text,
  source_notes text,
  supervisor_label text,
  armed_source_claim boolean not null default false,
  created_at timestamptz not null default clock_timestamp()
);

create trigger employee_operational_profiles_append_only
before update or delete on private.employee_operational_profiles
for each row execute function private.prevent_append_only_change();

drop function public.get_employee_directory();

create function public.get_employee_directory()
returns table (
  id uuid,
  employee_number text,
  username text,
  first_name text,
  middle_name text,
  last_name text,
  preferred_name text,
  role public.app_role,
  employment_type public.employment_type,
  status public.employee_status,
  photo_path text,
  hired_on date,
  personal_email text,
  company_email text,
  mobile_phone text,
  credentials jsonb,
  operational_profile jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege
      using message = 'Supervisor or administrator access with MFA is required.';
  end if;

  return query
  select
    employee.id,
    employee.employee_number,
    employee.username,
    employee.first_name,
    employee.middle_name,
    employee.last_name,
    employee.preferred_name,
    employee.role,
    employee.employment_type,
    employee.status,
    employee.photo_path,
    employee.hired_on,
    contact.personal_email,
    contact.company_email,
    contact.mobile_phone,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'kind', credential.kind,
            'status', credential.status,
            'credential_number', credential.credential_number,
            'valid_from', credential.valid_from,
            'expires_on', credential.expires_on,
            'notes', credential.notes
          )
          order by credential.kind, credential.expires_on nulls last
        )
        from public.employee_credentials credential
        where credential.employee_id = employee.id
      ),
      '[]'::jsonb
    ),
    case when profile.employee_id is null then null else jsonb_build_object(
      'sourceDisplayName', profile.source_display_name,
      'locationText', profile.location_text,
      'scheduleAvailability', profile.schedule_availability,
      'employeeDg', profile.employee_dg,
      'expectedHoursText', profile.expected_hours_text,
      'sourceNotes', profile.source_notes,
      'supervisorLabel', profile.supervisor_label,
      'armedSourceClaim', profile.armed_source_claim
    ) end
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_operational_profiles profile on profile.employee_id = employee.id
  order by employee.last_name, employee.first_name, employee.id;
end
$$;

revoke all on function public.get_employee_directory() from public, anon;
grant execute on function public.get_employee_directory() to authenticated;

create function private.reject_import_candidate(
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
  if candidate_record.review_status = 'accepted' then
    raise check_violation using message = 'An accepted candidate cannot be excluded during promotion.';
  end if;
  if candidate_record.review_status in ('rejected', 'superseded') then
    return;
  end if;

  update private.import_candidates
  set
    review_status = 'rejected',
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
    'rejected',
    btrim(target_note),
    reviewer_id,
    to_jsonb(candidate_record),
    resulting_record
  );
end
$$;

create function private.import_scope_effective_shift_decisions(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date
)
returns table (
  shift_candidate_id uuid,
  shift_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  site_key text,
  effective_mapping_id bigint,
  effective_decision jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    shift.id,
    (shift.payload ->> 'localDate')::date,
    ((shift.payload ->> 'localDate')::date + (shift.payload ->> 'startTime')::time)
      at time zone 'America/Denver',
    (
      (shift.payload ->> 'localDate')::date
      + case when coalesce((shift.payload ->> 'crossesMidnight')::boolean, false) then 1 else 0 end
      + (shift.payload ->> 'endTime')::time
    ) at time zone 'America/Denver',
    shift.payload ->> 'siteKeyCandidate',
    coalesce(override_mapping.id, alias_mapping.id),
    coalesce(override_mapping.decision, alias_mapping.decision)
  from private.import_candidates shift
  left join private.current_import_mappings override_mapping
    on override_mapping.import_run_id = target_import_run_id
    and override_mapping.mapping_type = 'shift_override'
    and override_mapping.mapping_key = 'candidate:' || shift.id::text
  left join private.current_import_mappings alias_mapping
    on alias_mapping.import_run_id = target_import_run_id
    and alias_mapping.mapping_type = 'assignee_alias'
    and alias_mapping.mapping_key = private.normalize_import_label(shift.payload ->> 'assigneeLabel')
  where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
    and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
$$;

create function private.import_scope_qualification_conflicts(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with mapped_shifts as (
    select
      shift.shift_candidate_id id,
      shift.shift_date,
      (site_mapping.decision ->> 'requiresArmed')::boolean requires_armed,
      shift.effective_decision assignment_decision
    from private.import_scope_effective_shift_decisions(
      target_import_run_id, target_from_date, target_through_date
    ) shift
    left join private.import_candidates site_candidate
      on site_candidate.import_run_id = target_import_run_id
      and site_candidate.kind = 'site'
      and site_candidate.payload ->> 'siteKeyCandidate' = shift.site_key
    left join private.current_import_mappings site_mapping
      on site_mapping.import_run_id = target_import_run_id
      and site_mapping.mapping_type = 'site'
      and site_mapping.mapping_key = 'candidate:' || site_candidate.id::text
  ), employee_targets as (
    select
      shift.id shift_id,
      shift.shift_date,
      shift.requires_armed,
      shift.assignment_decision ->> 'disposition' disposition,
      employee_key.value employee_mapping_key
    from mapped_shifts shift
    left join lateral jsonb_array_elements_text(
      coalesce(shift.assignment_decision -> 'employeeMappingKeys', '[]'::jsonb)
    ) employee_key(value) on true
  )
  select count(distinct target.shift_id)
  from employee_targets target
  left join private.current_import_mappings employee_mapping
    on employee_mapping.import_run_id = target_import_run_id
    and employee_mapping.mapping_type = 'employee'
    and employee_mapping.mapping_key = target.employee_mapping_key
  where target.requires_armed
    and target.disposition in ('employee', 'multiple_employees')
    and (
      employee_mapping.id is null
      or employee_mapping.decision ->> 'armedStatus' <> 'active'
      or (employee_mapping.decision ->> 'armedExpiresOn')::date < target.shift_date
    )
$$;

create function private.import_scope_assignment_overlap_conflicts(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  with employee_shifts as (
    select
      shift.shift_candidate_id,
      shift.starts_at,
      shift.ends_at,
      employee_key.value employee_mapping_key
    from private.import_scope_effective_shift_decisions(
      target_import_run_id, target_from_date, target_through_date
    ) shift
    cross join lateral jsonb_array_elements_text(
      coalesce(shift.effective_decision -> 'employeeMappingKeys', '[]'::jsonb)
    ) employee_key(value)
    where shift.effective_decision ->> 'disposition' in ('employee', 'multiple_employees')
  )
  select count(*)
  from employee_shifts earlier
  join employee_shifts later
    on later.employee_mapping_key = earlier.employee_mapping_key
    and later.shift_candidate_id::text > earlier.shift_candidate_id::text
    and tstzrange(later.starts_at, later.ends_at, '[)')
      && tstzrange(earlier.starts_at, earlier.ends_at, '[)')
$$;

create function public.get_import_shift_exception_queue(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  page_size integer default 100,
  page_offset integer default 0
)
returns table (
  candidate_id uuid,
  source_payload jsonb,
  effective_mapping jsonb,
  current_override jsonb,
  overlap_conflict boolean,
  qualification_conflict boolean,
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
    raise check_violation using message = 'Invalid shift exception page request.';
  end if;

  return query
  with effective as (
    select * from private.import_scope_effective_shift_decisions(
      target_import_run_id, target_from_date, target_through_date
    )
  ), employee_shifts as (
    select
      shift.shift_candidate_id,
      shift.starts_at,
      shift.ends_at,
      employee_key.value employee_mapping_key
    from effective shift
    cross join lateral jsonb_array_elements_text(
      coalesce(shift.effective_decision -> 'employeeMappingKeys', '[]'::jsonb)
    ) employee_key(value)
    where shift.effective_decision ->> 'disposition' in ('employee', 'multiple_employees')
  ), overlap_ids as (
    select earlier.shift_candidate_id from employee_shifts earlier
    join employee_shifts later
      on later.employee_mapping_key = earlier.employee_mapping_key
      and later.shift_candidate_id::text > earlier.shift_candidate_id::text
      and tstzrange(later.starts_at, later.ends_at, '[)')
        && tstzrange(earlier.starts_at, earlier.ends_at, '[)')
    union
    select later.shift_candidate_id from employee_shifts earlier
    join employee_shifts later
      on later.employee_mapping_key = earlier.employee_mapping_key
      and later.shift_candidate_id::text > earlier.shift_candidate_id::text
      and tstzrange(later.starts_at, later.ends_at, '[)')
        && tstzrange(earlier.starts_at, earlier.ends_at, '[)')
  ), qualification_ids as (
    select distinct shift.shift_candidate_id
    from effective shift
    join private.import_candidates site_candidate
      on site_candidate.import_run_id = target_import_run_id
      and site_candidate.kind = 'site'
      and site_candidate.payload ->> 'siteKeyCandidate' = shift.site_key
    join private.current_import_mappings site_mapping
      on site_mapping.import_run_id = target_import_run_id
      and site_mapping.mapping_type = 'site'
      and site_mapping.mapping_key = 'candidate:' || site_candidate.id::text
    cross join lateral jsonb_array_elements_text(
      coalesce(shift.effective_decision -> 'employeeMappingKeys', '[]'::jsonb)
    ) employee_key(value)
    left join private.current_import_mappings employee_mapping
      on employee_mapping.import_run_id = target_import_run_id
      and employee_mapping.mapping_type = 'employee'
      and employee_mapping.mapping_key = employee_key.value
    where (site_mapping.decision ->> 'requiresArmed')::boolean
      and shift.effective_decision ->> 'disposition' in ('employee', 'multiple_employees')
      and (
        employee_mapping.id is null
        or employee_mapping.decision ->> 'armedStatus' <> 'active'
        or (employee_mapping.decision ->> 'armedExpiresOn')::date < shift.shift_date
      )
  ), exceptions as (
    select
      shift.*,
      exists (select 1 from overlap_ids conflict where conflict.shift_candidate_id = shift.shift_candidate_id) has_overlap,
      exists (select 1 from qualification_ids conflict where conflict.shift_candidate_id = shift.shift_candidate_id) has_qualification_conflict
    from effective shift
  )
  select
    candidate.id,
    candidate.payload,
    exception.effective_decision,
    override_mapping.decision,
    exception.has_overlap,
    exception.has_qualification_conflict,
    count(*) over()
  from exceptions exception
  join private.import_candidates candidate on candidate.id = exception.shift_candidate_id
  left join private.current_import_mappings override_mapping
    on override_mapping.import_run_id = target_import_run_id
    and override_mapping.mapping_type = 'shift_override'
    and override_mapping.mapping_key = 'candidate:' || candidate.id::text
  where exception.has_overlap or exception.has_qualification_conflict
  order by (candidate.payload ->> 'localDate')::date, candidate.payload ->> 'startTime', candidate.id
  limit page_size offset page_offset;
end
$$;

create or replace function public.get_import_mapping_readiness(
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
      (select count(*) from scope_aliases alias join private.import_employee_alias_proposals proposal on proposal.import_run_id = target_import_run_id and proposal.normalized_label = alias.normalized_label left join private.current_import_mappings mapping on mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'assignee_alias' and mapping.mapping_key = alias.normalized_label where mapping.id is null) conservative_alias_suggestions,
      private.import_scope_qualification_conflicts(target_import_run_id, target_from_date, target_through_date) qualification_conflicts,
      private.import_scope_assignment_overlap_conflicts(target_import_run_id, target_from_date, target_through_date) assignment_overlap_conflicts
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
    'qualificationConflictCount', qualification_conflicts,
    'assignmentOverlapConflictCount', assignment_overlap_conflicts,
    'directoryReady', employee_candidates = directory_employee_mappings,
    'scheduleReady', schedule_candidates > 0
      and schedule_candidates = accepted_schedules
      and shift_candidates > 0
      and missing_context_shifts = 0
      and site_keys = site_mappings
      and assignee_labels = alias_mappings
      and qualification_conflicts = 0
      and assignment_overlap_conflicts = 0
  ) into result
  from counts;

  return result;
end
$$;

create function public.promote_import_scope(
  target_import_run_id uuid,
  target_from_date date,
  target_through_date date,
  target_publish boolean,
  target_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  batch_id uuid := gen_random_uuid();
  readiness jsonb;
  employee_mapping record;
  site_group record;
  post_group record;
  schedule_candidate private.import_candidates%rowtype;
  shift_candidate private.import_candidates%rowtype;
  alias_mapping private.import_mapping_decisions%rowtype;
  employee_key text;
  employee_id uuid;
  resolved_site_id uuid;
  resolved_post_id uuid;
  schedule_id uuid;
  shift_id uuid;
  assignment_id uuid;
  credential_id uuid;
  starts_at_value timestamptz;
  ends_at_value timestamptz;
  headcount integer;
  is_open_value boolean;
  mapping_note text;
  employees_created integer := 0;
  sites_created integer := 0;
  posts_created integer := 0;
  schedules_created integer := 0;
  shifts_created integer := 0;
  assignments_created integer := 0;
  shifts_excluded integer := 0;
  source_candidates integer;
  linked_site_count integer;
  linked_post_count integer;
begin
  perform private.require_import_admin();
  if target_through_date < target_from_date then
    raise check_violation using message = 'The promotion date range is invalid.';
  end if;
  if btrim(coalesce(target_note, '')) = '' or char_length(target_note) > 4000 then
    raise check_violation using message = 'A promotion note of 4,000 characters or fewer is required.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('import-promotion:' || target_import_run_id::text, 0));
  if exists (
    select 1 from private.import_promotion_batches batch
    where batch.import_run_id = target_import_run_id
      and daterange(batch.from_date, batch.through_date, '[]') && daterange(target_from_date, target_through_date, '[]')
  ) then
    raise check_violation using message = 'This import date range overlaps an existing promotion batch.';
  end if;

  readiness := public.get_import_mapping_readiness(target_import_run_id, target_from_date, target_through_date);
  if not coalesce((readiness ->> 'scheduleReady')::boolean, false) then
    raise check_violation using message = 'The import scope is not ready for promotion.';
  end if;

  select count(*) into source_candidates
  from private.import_candidates candidate
  where candidate.import_run_id = target_import_run_id
    and (
      (candidate.kind = 'weekly_schedule' and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date)
      or (candidate.kind = 'shift' and (candidate.payload ->> 'localDate')::date between target_from_date and target_through_date)
    );

  for employee_mapping in
    select mapping.*
    from private.current_import_mappings mapping
    where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'employee'
      and not exists (
        select 1 from private.import_entity_links link
        where link.mapping_decision_id = mapping.id and link.entity_table = 'employees'
      )
    order by mapping.id
  loop
    insert into public.employees (
      first_name,
      middle_name,
      last_name,
      preferred_name,
      role,
      employment_type,
      status
    ) values (
      employee_mapping.decision ->> 'firstName',
      employee_mapping.decision ->> 'middleName',
      employee_mapping.decision ->> 'lastName',
      employee_mapping.decision ->> 'preferredName',
      (employee_mapping.decision ->> 'role')::public.app_role,
      (employee_mapping.decision ->> 'employmentType')::public.employment_type,
      (employee_mapping.decision ->> 'status')::public.employee_status
    ) returning id into employee_id;
    employees_created := employees_created + 1;

    if coalesce(employee_mapping.decision ->> 'personalEmail', employee_mapping.decision ->> 'companyEmail', employee_mapping.decision ->> 'mobilePhone') is not null then
      insert into private.employee_contacts (employee_id, personal_email, company_email, mobile_phone)
      values (
        employee_id,
        employee_mapping.decision ->> 'personalEmail',
        employee_mapping.decision ->> 'companyEmail',
        employee_mapping.decision ->> 'mobilePhone'
      );
    end if;

    if employee_mapping.candidate_id is not null then
      insert into private.employee_operational_profiles (
        employee_id,
        source_candidate_id,
        source_mapping_decision_id,
        source_display_name,
        location_text,
        schedule_availability,
        employee_dg,
        expected_hours_text,
        source_notes,
        supervisor_label,
        armed_source_claim
      )
      select
        employee_id,
        candidate.id,
        employee_mapping.id,
        candidate.payload ->> 'name',
        candidate.payload ->> 'location',
        candidate.payload ->> 'scheduleAvailability',
        candidate.payload ->> 'employeeDg',
        candidate.payload ->> 'hours',
        candidate.payload ->> 'notes',
        candidate.payload ->> 'supervisor',
        coalesce((candidate.payload ->> 'armed')::boolean, false)
      from private.import_candidates candidate where candidate.id = employee_mapping.candidate_id;
    else
      insert into private.employee_operational_profiles (
        employee_id,
        source_mapping_decision_id,
        source_display_name,
        armed_source_claim
      ) values (
        employee_id,
        employee_mapping.id,
        employee_mapping.decision ->> 'sourceLabel',
        false
      );
    end if;

    insert into private.import_entity_links (
      import_run_id, promotion_batch_id, candidate_id, mapping_decision_id, entity_table, entity_id, relation
    ) values (
      target_import_run_id, batch_id, employee_mapping.candidate_id, employee_mapping.id,
      'employees', employee_id, 'employee'
    );

    if employee_mapping.decision ->> 'guardLicenseNumber' is not null then
      insert into public.employee_credentials (
        employee_id, kind, status, credential_number, expires_on, verified_at, verified_by, notes
      ) values (
        employee_id,
        'guard_license',
        case
          when (employee_mapping.decision ->> 'guardLicenseExpiresOn')::date < current_date then 'expired'::public.credential_status
          when employee_mapping.decision ->> 'guardLicenseExpiresOn' is null then 'pending'::public.credential_status
          else 'active'::public.credential_status
        end,
        employee_mapping.decision ->> 'guardLicenseNumber',
        (employee_mapping.decision ->> 'guardLicenseExpiresOn')::date,
        case when (employee_mapping.decision ->> 'guardLicenseExpiresOn')::date >= current_date then clock_timestamp() end,
        case when (employee_mapping.decision ->> 'guardLicenseExpiresOn')::date >= current_date then reviewer_id end,
        'Imported from reviewed workbook evidence.'
      ) returning id into credential_id;
      insert into private.import_entity_links (
        import_run_id, promotion_batch_id, candidate_id, mapping_decision_id, entity_table, entity_id, relation
      ) values (
        target_import_run_id, batch_id, employee_mapping.candidate_id, employee_mapping.id,
        'employee_credentials', credential_id, 'guard_license'
      );
    end if;

    if employee_mapping.decision ->> 'armedStatus' in ('pending_verification', 'active') then
      insert into public.employee_credentials (
        employee_id, kind, status, credential_number, expires_on, verified_at, verified_by, notes
      ) values (
        employee_id,
        'armed_guard',
        case when employee_mapping.decision ->> 'armedStatus' = 'active'
          then 'active'::public.credential_status else 'pending'::public.credential_status end,
        employee_mapping.decision ->> 'armedCredentialNumber',
        (employee_mapping.decision ->> 'armedExpiresOn')::date,
        case when employee_mapping.decision ->> 'armedStatus' = 'active' then clock_timestamp() end,
        case when employee_mapping.decision ->> 'armedStatus' = 'active' then reviewer_id end,
        case when employee_mapping.decision ->> 'armedStatus' = 'active'
          then 'Verified during reviewed workbook import.' else 'Source indicates armed status; credential verification is still required.' end
      ) returning id into credential_id;
      insert into private.import_entity_links (
        import_run_id, promotion_batch_id, candidate_id, mapping_decision_id, entity_table, entity_id, relation
      ) values (
        target_import_run_id, batch_id, employee_mapping.candidate_id, employee_mapping.id,
        'employee_credentials', credential_id, 'armed_guard'
      );
    end if;
  end loop;

  for site_group in
    select
      mapping.decision ->> 'canonicalSiteKey' canonical_site_key,
      min(mapping.decision ->> 'siteName') site_name,
      min(mapping.decision ->> 'siteCode') site_code,
      bool_and((mapping.decision ->> 'active')::boolean) active,
      count(distinct mapping.decision ->> 'siteName') name_count,
      count(distinct coalesce(mapping.decision ->> 'siteCode', '')) code_count
    from private.current_import_mappings mapping
    join private.import_candidates candidate on candidate.id = mapping.candidate_id
    where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
      and exists (
        select 1 from private.import_candidates shift
        where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
          and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
          and shift.payload ->> 'siteKeyCandidate' = candidate.payload ->> 'siteKeyCandidate'
      )
    group by mapping.decision ->> 'canonicalSiteKey'
    order by mapping.decision ->> 'canonicalSiteKey'
  loop
    if site_group.name_count <> 1 or site_group.code_count <> 1 then
      raise check_violation using message = 'Mappings for one canonical site disagree on its name or code.';
    end if;
    select min(link.entity_id::text)::uuid, count(distinct link.entity_id)
      into resolved_site_id, linked_site_count
    from private.current_import_mappings mapping
    join private.import_entity_links link
      on link.mapping_decision_id = mapping.id and link.entity_table = 'sites'
    where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
      and mapping.decision ->> 'canonicalSiteKey' = site_group.canonical_site_key;

    if linked_site_count > 1 then
      raise check_violation using message = 'One canonical site key is linked to multiple operational sites.';
    end if;
    if resolved_site_id is null then
      if site_group.site_code is not null and exists (
        select 1 from public.sites existing where existing.code = site_group.site_code
      ) then
        raise unique_violation using message = 'A mapped site code already exists.';
      end if;
      insert into public.sites (code, name, active)
      values (site_group.site_code, site_group.site_name, site_group.active)
      returning id into resolved_site_id;
      sites_created := sites_created + 1;
    elsif not exists (
      select 1 from public.sites existing
      where existing.id = resolved_site_id
        and existing.name = site_group.site_name
        and existing.code is not distinct from site_group.site_code
    ) then
      raise check_violation using message = 'A reused operational site no longer matches its reviewed mapping.';
    end if;

    for post_group in
      select
        mapping.decision ->> 'postName' post_name,
        (mapping.decision ->> 'requiresArmed')::boolean requires_armed,
        min(mapping.id) first_mapping_id
      from private.current_import_mappings mapping
      join private.import_candidates candidate on candidate.id = mapping.candidate_id
      where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
        and mapping.decision ->> 'canonicalSiteKey' = site_group.canonical_site_key
        and exists (
          select 1 from private.import_candidates shift
          where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
            and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
            and shift.payload ->> 'siteKeyCandidate' = candidate.payload ->> 'siteKeyCandidate'
        )
      group by mapping.decision ->> 'postName', (mapping.decision ->> 'requiresArmed')::boolean
      order by mapping.decision ->> 'postName'
    loop
      if exists (
        select 1
        from private.current_import_mappings mapping
        join private.import_candidates candidate on candidate.id = mapping.candidate_id
        where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
          and mapping.decision ->> 'canonicalSiteKey' = site_group.canonical_site_key
          and mapping.decision ->> 'postName' = post_group.post_name
          and (mapping.decision ->> 'requiresArmed')::boolean <> post_group.requires_armed
          and exists (
            select 1 from private.import_candidates shift
            where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
              and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
              and shift.payload ->> 'siteKeyCandidate' = candidate.payload ->> 'siteKeyCandidate'
          )
      ) then
        raise check_violation using message = 'Mappings for one post disagree on its armed requirement.';
      end if;

      select min(link.entity_id::text)::uuid, count(distinct link.entity_id)
        into resolved_post_id, linked_post_count
      from private.current_import_mappings mapping
      join private.import_entity_links link
        on link.mapping_decision_id = mapping.id and link.entity_table = 'posts'
      where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
        and mapping.decision ->> 'canonicalSiteKey' = site_group.canonical_site_key
        and mapping.decision ->> 'postName' = post_group.post_name
        and (mapping.decision ->> 'requiresArmed')::boolean = post_group.requires_armed;

      if linked_post_count > 1 then
        raise check_violation using message = 'One reviewed post mapping is linked to multiple operational posts.';
      end if;
      if resolved_post_id is null then
        insert into public.posts (site_id, name, requires_armed, active)
        values (resolved_site_id, post_group.post_name, post_group.requires_armed, site_group.active)
        returning id into resolved_post_id;
        posts_created := posts_created + 1;
      elsif not exists (
        select 1 from public.posts existing
        where existing.id = resolved_post_id
          and existing.site_id = resolved_site_id
          and existing.name = post_group.post_name
          and existing.requires_armed = post_group.requires_armed
      ) then
        raise check_violation using message = 'A reused operational post no longer matches its reviewed mapping.';
      end if;

      insert into private.import_entity_links (
        import_run_id, promotion_batch_id, candidate_id, mapping_decision_id, entity_table, entity_id, relation
      )
      select
        target_import_run_id,
        batch_id,
        mapping.candidate_id,
        mapping.id,
        'sites',
        resolved_site_id,
        'source:' || mapping.candidate_id::text
      from private.current_import_mappings mapping
      join private.import_candidates candidate on candidate.id = mapping.candidate_id
      where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
        and mapping.decision ->> 'canonicalSiteKey' = site_group.canonical_site_key
        and mapping.decision ->> 'postName' = post_group.post_name
        and (mapping.decision ->> 'requiresArmed')::boolean = post_group.requires_armed
        and exists (
          select 1 from private.import_candidates shift
          where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
            and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
            and shift.payload ->> 'siteKeyCandidate' = candidate.payload ->> 'siteKeyCandidate'
        )
        and not exists (
          select 1 from private.import_entity_links existing_link
          where existing_link.mapping_decision_id = mapping.id and existing_link.entity_table = 'sites'
        );

      insert into private.import_entity_links (
        import_run_id, promotion_batch_id, candidate_id, mapping_decision_id, entity_table, entity_id, relation
      )
      select
        target_import_run_id,
        batch_id,
        mapping.candidate_id,
        mapping.id,
        'posts',
        resolved_post_id,
        'source:' || mapping.candidate_id::text
      from private.current_import_mappings mapping
      join private.import_candidates candidate on candidate.id = mapping.candidate_id
      where mapping.import_run_id = target_import_run_id and mapping.mapping_type = 'site'
        and mapping.decision ->> 'canonicalSiteKey' = site_group.canonical_site_key
        and mapping.decision ->> 'postName' = post_group.post_name
        and (mapping.decision ->> 'requiresArmed')::boolean = post_group.requires_armed
        and exists (
          select 1 from private.import_candidates shift
          where shift.import_run_id = target_import_run_id and shift.kind = 'shift'
            and (shift.payload ->> 'localDate')::date between target_from_date and target_through_date
            and shift.payload ->> 'siteKeyCandidate' = candidate.payload ->> 'siteKeyCandidate'
        )
        and not exists (
          select 1 from private.import_entity_links existing_link
          where existing_link.mapping_decision_id = mapping.id and existing_link.entity_table = 'posts'
        );
    end loop;
  end loop;

  for schedule_candidate in
    select candidate.*
    from private.import_candidates candidate
    where candidate.import_run_id = target_import_run_id and candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date between target_from_date and target_through_date
      and candidate.review_status = 'accepted'
    order by candidate.payload ->> 'weekStartsOn'
  loop
    insert into public.schedules (week_starts_on, status, created_by)
    values ((schedule_candidate.payload ->> 'weekStartsOn')::date, 'draft', reviewer_id)
    returning id into schedule_id;
    schedules_created := schedules_created + 1;
    insert into private.import_entity_links (
      import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
    ) values (
      target_import_run_id, batch_id, schedule_candidate.id, 'schedules', schedule_id, 'schedule'
    );
  end loop;

  for shift_candidate in
    select candidate.*
    from private.import_candidates candidate
    where candidate.import_run_id = target_import_run_id and candidate.kind = 'shift'
      and (candidate.payload ->> 'localDate')::date between target_from_date and target_through_date
    order by candidate.payload ->> 'localDate', candidate.payload ->> 'startTime', candidate.id
  loop
    select link.entity_id into schedule_id
    from private.import_candidates schedule_source
    join private.import_entity_links link
      on link.candidate_id = schedule_source.id and link.entity_table = 'schedules'
    where schedule_source.import_run_id = target_import_run_id
      and schedule_source.kind = 'weekly_schedule'
      and (schedule_source.payload ->> 'weekStartsOn')::date = (shift_candidate.payload -> 'sourceSchedule' ->> 'weekStartsOn')::date
    limit 1;

    select post_link.entity_id into resolved_post_id
    from private.import_candidates site_candidate
    join private.current_import_mappings site_mapping
      on site_mapping.import_run_id = target_import_run_id
      and site_mapping.mapping_type = 'site'
      and site_mapping.mapping_key = 'candidate:' || site_candidate.id::text
    join private.import_entity_links post_link
      on post_link.mapping_decision_id = site_mapping.id and post_link.entity_table = 'posts'
    where site_candidate.import_run_id = target_import_run_id and site_candidate.kind = 'site'
      and site_candidate.payload ->> 'siteKeyCandidate' = shift_candidate.payload ->> 'siteKeyCandidate'
    limit 1;

    if schedule_id is null or resolved_post_id is null then
      raise check_violation using message = 'A shift could not be linked to its reviewed schedule and post.';
    end if;

    alias_mapping := null;
    select mapping.* into alias_mapping
    from private.current_import_mappings mapping
    where mapping.import_run_id = target_import_run_id
      and mapping.mapping_type = 'shift_override'
      and mapping.mapping_key = 'candidate:' || shift_candidate.id::text;

    if alias_mapping.id is null and btrim(coalesce(shift_candidate.payload ->> 'assigneeLabel', '')) <> '' then
      select mapping.* into alias_mapping
      from private.current_import_mappings mapping
      where mapping.import_run_id = target_import_run_id
        and mapping.mapping_type = 'assignee_alias'
        and mapping.mapping_key = private.normalize_import_label(shift_candidate.payload ->> 'assigneeLabel');
      if alias_mapping.id is null then
        raise check_violation using message = 'A shift assignee label has no reviewed mapping.';
      end if;
      if alias_mapping.decision ->> 'disposition' = 'exclude' then
        perform private.reject_import_candidate(
          shift_candidate.id,
          'Excluded by reviewed assignee mapping: ' || alias_mapping.note,
          reviewer_id
        );
        shifts_excluded := shifts_excluded + 1;
        continue;
      end if;
    end if;

    starts_at_value := (
      (shift_candidate.payload ->> 'localDate')::date + (shift_candidate.payload ->> 'startTime')::time
    ) at time zone 'America/Denver';
    ends_at_value := (
      (shift_candidate.payload ->> 'localDate')::date
      + case when coalesce((shift_candidate.payload ->> 'crossesMidnight')::boolean, false) then 1 else 0 end
      + (shift_candidate.payload ->> 'endTime')::time
    ) at time zone 'America/Denver';
    if ends_at_value <= starts_at_value then
      raise check_violation using message = 'A reviewed shift has an invalid time range.';
    end if;

    headcount := case
      when alias_mapping.id is null then 1
      when alias_mapping.decision ->> 'disposition' in ('employee', 'multiple_employees')
        then jsonb_array_length(alias_mapping.decision -> 'employeeMappingKeys')
      else 1
    end;
    is_open_value := alias_mapping.id is null or alias_mapping.decision ->> 'disposition' = 'open';

    insert into public.shifts (
      schedule_id, post_id, starts_at, ends_at, headcount_required, is_open, created_by
    ) values (
      schedule_id, resolved_post_id, starts_at_value, ends_at_value, greatest(headcount, 1), is_open_value, reviewer_id
    ) returning id into shift_id;
    shifts_created := shifts_created + 1;
    insert into private.import_entity_links (
      import_run_id, promotion_batch_id, candidate_id, entity_table, entity_id, relation
    ) values (
      target_import_run_id, batch_id, shift_candidate.id, 'shifts', shift_id, 'shift'
    );

    if alias_mapping.id is not null and alias_mapping.decision ->> 'disposition' in ('employee', 'multiple_employees') then
      for employee_key in
        select value from jsonb_array_elements_text(alias_mapping.decision -> 'employeeMappingKeys')
      loop
        select employee_link.entity_id into employee_id
        from private.current_import_mappings mapping
        join private.import_entity_links employee_link
          on employee_link.mapping_decision_id = mapping.id and employee_link.entity_table = 'employees'
        where mapping.import_run_id = target_import_run_id
          and mapping.mapping_type = 'employee'
          and mapping.mapping_key = employee_key;
        if employee_id is null then
          raise check_violation using message = 'A reviewed assignee has not been promoted to the Directory.';
        end if;
        insert into public.shift_assignments (shift_id, employee_id, assigned_by)
        values (shift_id, employee_id, reviewer_id)
        returning id into assignment_id;
        assignments_created := assignments_created + 1;
        insert into private.import_entity_links (
          import_run_id, promotion_batch_id, candidate_id, mapping_decision_id,
          entity_table, entity_id, relation
        ) values (
          target_import_run_id, batch_id, shift_candidate.id, alias_mapping.id,
          'shift_assignments', assignment_id, 'employee:' || employee_id::text
        );
      end loop;
    end if;

    mapping_note := 'Promoted from reviewed workbook mapping scope ' || target_from_date || ' through ' || target_through_date || '.';
    perform private.accept_mapped_candidate(shift_candidate.id, mapping_note, reviewer_id);
  end loop;

  if target_publish then
    update public.schedules schedule
    set status = 'published', published_at = clock_timestamp(), published_by = reviewer_id
    where schedule.id in (
      select link.entity_id from private.import_entity_links link
      where link.promotion_batch_id = batch_id and link.entity_table = 'schedules'
    );
  end if;

  if schedules_created <> (readiness ->> 'scheduleCandidateCount')::integer
    or shifts_created + shifts_excluded <> (readiness ->> 'shiftCandidateCount')::integer
  then
    raise check_violation using message = 'Promotion reconciliation failed; no operational records were committed.';
  end if;

  insert into private.import_promotion_batches (
    id,
    import_run_id,
    from_date,
    through_date,
    published,
    employee_count,
    site_count,
    post_count,
    schedule_count,
    shift_count,
    assignment_count,
    excluded_shift_count,
    source_candidate_count,
    note,
    promoted_by
  ) values (
    batch_id,
    target_import_run_id,
    target_from_date,
    target_through_date,
    target_publish,
    employees_created,
    sites_created,
    posts_created,
    schedules_created,
    shifts_created,
    assignments_created,
    shifts_excluded,
    source_candidates,
    btrim(target_note),
    reviewer_id
  );

  return jsonb_build_object(
    'promotionBatchId', batch_id,
    'employeesCreated', employees_created,
    'sitesCreated', sites_created,
    'postsCreated', posts_created,
    'schedulesCreated', schedules_created,
    'shiftsCreated', shifts_created,
    'assignmentsCreated', assignments_created,
    'shiftsExcluded', shifts_excluded,
    'published', target_publish
  );
end
$$;

create function public.get_import_promotion_history(target_import_run_id uuid)
returns table (
  id uuid,
  from_date date,
  through_date date,
  published boolean,
  employee_count integer,
  site_count integer,
  post_count integer,
  schedule_count integer,
  shift_count integer,
  assignment_count integer,
  excluded_shift_count integer,
  note text,
  promoted_at timestamptz
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
    batch.id,
    batch.from_date,
    batch.through_date,
    batch.published,
    batch.employee_count,
    batch.site_count,
    batch.post_count,
    batch.schedule_count,
    batch.shift_count,
    batch.assignment_count,
    batch.excluded_shift_count,
    batch.note,
    batch.promoted_at
  from private.import_promotion_batches batch
  where batch.import_run_id = target_import_run_id
  order by batch.promoted_at desc;
end
$$;

revoke all on private.import_promotion_batches, private.employee_operational_profiles from public, anon, authenticated;
grant all on private.import_promotion_batches, private.employee_operational_profiles to service_role;

revoke all on function public.promote_import_scope(uuid, date, date, boolean, text) from public, anon;
revoke all on function public.get_import_promotion_history(uuid) from public, anon;
revoke all on function public.get_import_shift_exception_queue(uuid, date, date, integer, integer) from public, anon;
grant execute on function public.promote_import_scope(uuid, date, date, boolean, text) to authenticated;
grant execute on function public.get_import_promotion_history(uuid) to authenticated;
grant execute on function public.get_import_shift_exception_queue(uuid, date, date, integer, integer) to authenticated;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;

commit;
