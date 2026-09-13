begin;

-- Absence decisions are classifications, not an attendance-point policy.  The
-- explicit unexcused outcome is intentionally additive and does not assign a
-- score or payroll consequence.
alter table public.attendance_accountability_events
  drop constraint if exists attendance_accountability_review_outcome_check;

alter table public.attendance_accountability_events
  add constraint attendance_accountability_review_outcome_check
  check (
    review_outcome is null
    or review_outcome in ('confirmed', 'unexcused', 'excused_protected', 'corrected', 'dismissed')
  );

alter table public.attendance_accountability_event_actions
  drop constraint if exists attendance_accountability_action_check;

alter table public.attendance_accountability_event_actions
  add constraint attendance_accountability_action_check
  check (
    action in (
      'created', 'confirmed', 'unexcused', 'excused_protected', 'corrected',
      'dismissed', 'voided', 'reopened', 'reclassified'
    )
  );

-- Internal marker used to suppress the broad announcement outbox. Coverage
-- delivery is staged by the dedicated Flex-first notification waves below.
insert into public.announcement_templates (
  template_key, name, description, kind, subject_pattern, body_pattern,
  required_fields, recipient_roles, requires_armed_field, is_active, display_order
) values (
  'shift_coverage_staged',
  'Staged absence coverage',
  'Internal template for absence coverage openings delivered by eligibility waves.',
  'open_shift',
  '{{subject}}',
  '{{message}}',
  '[]'::jsonb,
  array['guard']::public.app_role[],
  null,
  false,
  999
)
on conflict (template_key) do update set
  name = excluded.name,
  description = excluded.description,
  kind = excluded.kind,
  subject_pattern = excluded.subject_pattern,
  body_pattern = excluded.body_pattern,
  required_fields = excluded.required_fields,
  recipient_roles = excluded.recipient_roles,
  requires_armed_field = excluded.requires_armed_field,
  is_active = false,
  display_order = excluded.display_order,
  updated_at = clock_timestamp();

-- Coverage occupies its own schedule block.  The source block and assignment
-- remain untouched so the published schedule continues to show who was
-- originally assigned while the linked copy can move through the open pool.
alter table public.shifts
  add column coverage_source_shift_id uuid references public.shifts(id) on delete restrict;

alter table public.shifts
  add constraint shifts_coverage_source_distinct
  check (coverage_source_shift_id is null or coverage_source_shift_id <> id);

create unique index shifts_active_coverage_source_idx
  on public.shifts(schedule_id, coverage_source_shift_id)
  where coverage_source_shift_id is not null and canceled_at is null;

create or replace function private.copy_schedule_shift_block(
  source_shift_id uuid,
  destination_schedule_id uuid,
  actor_id uuid,
  include_only_employee_id uuid default null,
  exclude_employee_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  source_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  select shift.* into source_shift
  from public.shifts shift
  where shift.id = source_shift_id and shift.canceled_at is null;

  if source_shift.id is null then return null; end if;

  insert into public.shifts (
    schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, is_overtime, notes,
    work_type, time_zone_source, time_zone_employee_id, assignment_type,
    coverage_source_shift_id, created_by
  ) values (
    destination_schedule_id, source_shift.post_id, source_shift.event_id,
    source_shift.starts_at, source_shift.ends_at, source_shift.time_zone,
    source_shift.headcount_required, source_shift.requires_armed, source_shift.is_open,
    source_shift.is_overtime, source_shift.notes, source_shift.work_type,
    source_shift.time_zone_source, source_shift.time_zone_employee_id,
    source_shift.assignment_type, source_shift.coverage_source_shift_id, actor_id
  ) returning id into copied_shift_id;

  insert into public.schedule_assignment_overrides (
    shift_id, employee_id, override_kind, note, created_by, created_at
  )
  select copied_shift_id, override_record.employee_id, override_record.override_kind,
    override_record.note, override_record.created_by, override_record.created_at
  from public.schedule_assignment_overrides override_record
  where override_record.shift_id = source_shift.id
    and (include_only_employee_id is null or override_record.employee_id = include_only_employee_id)
    and (exclude_employee_id is null or override_record.employee_id <> exclude_employee_id)
    and exists (
      select 1 from public.shift_assignments source_assignment
      where source_assignment.shift_id = source_shift.id
        and source_assignment.employee_id = override_record.employee_id
        and source_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  insert into public.shift_assignments (
    shift_id, employee_id, status, assigned_by, assigned_at,
    confirmed_at, canceled_at, cancellation_reason
  )
  select copied_shift_id, assignment.employee_id, assignment.status,
    assignment.assigned_by, assignment.assigned_at, assignment.confirmed_at,
    assignment.canceled_at, assignment.cancellation_reason
  from public.shift_assignments assignment
  where assignment.shift_id = source_shift.id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and (include_only_employee_id is null or assignment.employee_id = include_only_employee_id)
    and (exclude_employee_id is null or assignment.employee_id <> exclude_employee_id);

  delete from public.schedule_assignment_overrides override_record
  where override_record.shift_id = copied_shift_id
    and not exists (
      select 1 from public.shift_assignments copied_assignment
      where copied_assignment.shift_id = override_record.shift_id
        and copied_assignment.employee_id = override_record.employee_id
        and copied_assignment.status in ('assigned', 'confirmed', 'completed')
    );

  update public.shifts shift
  set is_open = private.active_shift_assignment_count(shift.id) < shift.headcount_required,
      updated_at = clock_timestamp()
  where shift.id = copied_shift_id;

  return copied_shift_id;
end
$$;

create or replace function private.normalize_schedule_duplicate_shift_blocks(target_schedule_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_schedule_status public.schedule_status;
  duplicate_group record;
  duplicate_shift_ids uuid[];
  normalized_blocks integer := 0;
begin
  if target_schedule_id is null then return 0; end if;

  select schedule.status into target_schedule_status
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if target_schedule_status is null or target_schedule_status = 'published' then return 0; end if;

  perform pg_advisory_xact_lock(hashtext('schedule-duplicate-normalize:' || target_schedule_id::text));

  for duplicate_group in
    with active_assignment_counts as (
      select assignment.shift_id,
        count(*) filter (where assignment.status in ('assigned', 'confirmed', 'completed'))::integer as active_assignments
      from public.shift_assignments assignment
      group by assignment.shift_id
    ), grouped_shifts as (
      select
        shift.schedule_id, shift.post_id, shift.event_id, shift.starts_at, shift.ends_at,
        shift.time_zone, shift.requires_armed,
        array_agg(shift.id order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id) as shift_ids,
        (array_agg(shift.id order by coalesce(active_assignment_counts.active_assignments, 0) desc, shift.created_at, shift.id))[1] as survivor_shift_id,
        greatest(max(shift.headcount_required), sum(coalesce(active_assignment_counts.active_assignments, 0))::integer, 1) as normalized_headcount,
        bool_or(shift.is_overtime) as normalized_is_overtime
      from public.shifts shift
      left join active_assignment_counts on active_assignment_counts.shift_id = shift.id
      where shift.schedule_id = target_schedule_id
        and shift.canceled_at is null
        and shift.coverage_source_shift_id is null
      group by shift.schedule_id, shift.post_id, shift.event_id, shift.starts_at,
        shift.ends_at, shift.time_zone, shift.requires_armed
      having count(*) > 1
    )
    select * from grouped_shifts
  loop
    duplicate_shift_ids := array_remove(duplicate_group.shift_ids, duplicate_group.survivor_shift_id);
    if duplicate_shift_ids is null or array_length(duplicate_shift_ids, 1) is null then continue; end if;

    update public.shifts shift
    set headcount_required = duplicate_group.normalized_headcount,
        is_overtime = coalesce(shift.is_overtime, false) or coalesce(duplicate_group.normalized_is_overtime, false),
        is_open = true, updated_at = clock_timestamp()
    where shift.id = duplicate_group.survivor_shift_id;

    update public.schedule_assignment_overrides override_record
    set shift_id = duplicate_group.survivor_shift_id
    where override_record.shift_id = any(duplicate_shift_ids);

    update public.shift_assignments duplicate_assignment
    set status = 'canceled', canceled_at = coalesce(duplicate_assignment.canceled_at, clock_timestamp()),
        cancellation_reason = coalesce(nullif(btrim(duplicate_assignment.cancellation_reason), ''), 'Duplicate schedule block normalized.'),
        updated_at = clock_timestamp()
    where duplicate_assignment.shift_id = any(duplicate_shift_ids)
      and duplicate_assignment.status in ('assigned', 'confirmed', 'completed')
      and exists (
        select 1 from public.shift_assignments survivor_assignment
        where survivor_assignment.shift_id = duplicate_group.survivor_shift_id
          and survivor_assignment.employee_id = duplicate_assignment.employee_id
          and survivor_assignment.status in ('assigned', 'confirmed', 'completed')
      );

    update public.shift_assignments assignment
    set shift_id = duplicate_group.survivor_shift_id, updated_at = clock_timestamp()
    where assignment.shift_id = any(duplicate_shift_ids)
      and assignment.status in ('assigned', 'confirmed', 'completed');

    update public.shifts duplicate_shift
    set is_open = false, canceled_at = coalesce(duplicate_shift.canceled_at, clock_timestamp()),
        canceled_by = coalesce(actor_id, duplicate_shift.created_by),
        cancellation_reason = coalesce(nullif(btrim(duplicate_shift.cancellation_reason), ''),
          'Duplicate schedule block normalized into the primary block.'),
        updated_at = clock_timestamp()
    where duplicate_shift.id = any(duplicate_shift_ids);

    update public.shifts survivor_shift
    set is_open = private.active_shift_assignment_count(survivor_shift.id) < survivor_shift.headcount_required,
        updated_at = clock_timestamp()
    where survivor_shift.id = duplicate_group.survivor_shift_id;

    normalized_blocks := normalized_blocks + 1;
  end loop;

  return normalized_blocks;
end
$$;

create table public.shift_coverage_cases (
  id uuid primary key default gen_random_uuid(),
  call_off_report_id uuid not null unique references public.call_off_reports(id) on delete restrict,
  attendance_event_id uuid references public.attendance_accountability_events(id) on delete restrict,
  source_shift_id uuid not null references public.shifts(id) on delete restrict,
  source_assignment_id uuid not null references public.shift_assignments(id) on delete restrict,
  coverage_shift_id uuid unique references public.shifts(id) on delete restrict,
  absent_employee_id uuid not null references public.employees(id) on delete restrict,
  status text not null default 'draft'
    check (status in ('draft', 'open_pool', 'assigned', 'patrol_review', 'no_replacement', 'closed', 'canceled')),
  coverage_mode text
    check (coverage_mode is null or coverage_mode in ('open_pool', 'assigned_guard', 'patrol_review', 'no_replacement')),
  replacement_employee_id uuid references public.employees(id) on delete restrict,
  replacement_assignment_id uuid references public.shift_assignments(id) on delete restrict,
  announcement_id uuid references public.announcements(id) on delete restrict,
  allow_overtime_wave boolean not null default false,
  original_assignment_snapshot jsonb not null
    check (jsonb_typeof(original_assignment_snapshot) = 'object'),
  last_idempotency_key uuid not null unique,
  opened_by uuid not null references public.employees(id) on delete restrict,
  opened_at timestamptz not null default clock_timestamp(),
  resolved_by uuid references public.employees(id) on delete restrict,
  resolved_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint shift_coverage_resolution_pair check (
    (resolved_by is null and resolved_at is null)
    or (resolved_by is not null and resolved_at is not null)
  )
);

create index shift_coverage_cases_status_shift_idx
  on public.shift_coverage_cases(status, source_shift_id, updated_at desc);
create index shift_coverage_cases_absent_employee_idx
  on public.shift_coverage_cases(absent_employee_id, opened_at desc);
create index shift_coverage_cases_replacement_employee_idx
  on public.shift_coverage_cases(replacement_employee_id, opened_at desc)
  where replacement_employee_id is not null;

create unique index shift_coverage_cases_active_source_idx
  on public.shift_coverage_cases(source_shift_id)
  where status in ('draft', 'open_pool', 'assigned', 'patrol_review');

create table public.shift_coverage_case_actions (
  id uuid primary key default gen_random_uuid(),
  coverage_case_id uuid not null references public.shift_coverage_cases(id) on delete restrict,
  action text not null check (action in (
    'created', 'opened_pool', 'assigned_guard', 'patrol_review_requested',
    'no_replacement', 'request_approved', 'notification_wave_sent',
    'coverage_revision_rebased', 'closed', 'canceled'
  )),
  actor_id uuid references public.employees(id) on delete restrict,
  reason text not null check (char_length(btrim(reason)) between 8 and 2000),
  before_record jsonb check (before_record is null or jsonb_typeof(before_record) = 'object'),
  after_record jsonb not null check (jsonb_typeof(after_record) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index shift_coverage_case_actions_case_idx
  on public.shift_coverage_case_actions(coverage_case_id, created_at, id);

create table private.shift_coverage_notification_waves (
  id uuid primary key default gen_random_uuid(),
  coverage_case_id uuid not null references public.shift_coverage_cases(id) on delete cascade,
  wave_number smallint not null check (wave_number between 1 and 3),
  audience text not null check (audience in ('flex_no_overtime', 'other_no_overtime', 'overtime')),
  due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'canceled', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  recipient_count integer not null default 0 check (recipient_count >= 0),
  claimed_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (coverage_case_id, wave_number)
);

create index shift_coverage_notification_waves_due_idx
  on private.shift_coverage_notification_waves(status, due_at, id)
  where status in ('pending', 'processing');

alter table public.shift_coverage_cases enable row level security;
alter table public.shift_coverage_case_actions enable row level security;

revoke all on table public.shift_coverage_cases from public, anon, authenticated;
revoke all on table public.shift_coverage_case_actions from public, anon, authenticated;
revoke all on table private.shift_coverage_notification_waves from public, anon, authenticated;

create function private.prevent_shift_coverage_action_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise insufficient_privilege using message = 'Coverage history is append-only.';
end
$$;

create trigger shift_coverage_case_actions_immutable
before update or delete on public.shift_coverage_case_actions
for each row execute function private.prevent_shift_coverage_action_mutation();

create function private.shift_coverage_manager_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_employee_id() is not null
    and public.has_mfa()
    and public.has_any_effective_permission(array[
      'requests.manage', 'shift_pool.manage', 'announcements.send', 'schedule.manage'
    ]::text[])
$$;

create function private.shift_coverage_candidate_payload(
  target_shift_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  shift_record public.shifts%rowtype;
  employee_record public.employees%rowtype;
  availability_conflict uuid;
  overlap_conflict jsonb;
  overtime jsonb;
  armed_ready boolean := true;
  already_assigned boolean := false;
  eligible boolean := false;
  block_reason text;
begin
  select * into shift_record
  from public.shifts shift
  where shift.id = target_shift_id and shift.canceled_at is null;

  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id and employee.status = 'active';

  if shift_record.id is null or employee_record.id is null then
    return null;
  end if;

  availability_conflict := private.assignment_availability_conflict(
    employee_record.id, shift_record.starts_at, shift_record.ends_at, shift_record.time_zone
  );
  overlap_conflict := private.assignment_overlap_conflict(null, shift_record.id, employee_record.id);
  overtime := private.scheduled_overtime_preview(shift_record.id, employee_record.id);
  select exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = shift_record.id
      and assignment.employee_id = employee_record.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) into already_assigned;
  if shift_record.requires_armed then
    armed_ready := public.has_valid_credential(
      employee_record.id,
      'armed_guard'::public.credential_kind,
      (shift_record.starts_at at time zone shift_record.time_zone)::date
    );
  end if;

  eligible := employee_record.role = 'guard'
    and not already_assigned
    and availability_conflict is null
    and overlap_conflict is null
    and armed_ready;

  block_reason := case
    when employee_record.role <> 'guard' then 'This employee is not assigned the Guard role.'
    when already_assigned then 'This guard is already assigned to the original shift.'
    when availability_conflict is not null then 'Approved unavailability overlaps this shift.'
    when overlap_conflict is not null then 'Another active assignment overlaps this shift.'
    when not armed_ready then 'The required armed credential is not active for this date.'
    when coalesce((overtime ->> 'requiresOverride')::boolean, false) then 'This assignment would create scheduled overtime.'
    else null
  end;

  return jsonb_build_object(
    'id', employee_record.id,
    'name', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
    'employeeNumber', employee_record.employee_number,
    'employmentType', employee_record.employment_type,
    'workClassification', employee_record.work_classification,
    'isFlex', employee_record.employment_type = 'flex' or employee_record.work_classification = 'flex',
    'available', availability_conflict is null,
    'noOverlap', overlap_conflict is null,
    'armedReady', armed_ready,
    'overtimeMinutes', coalesce((overtime ->> 'overtimeMinutes')::integer, 0),
    'requiresOvertimeApproval', coalesce((overtime ->> 'requiresOverride')::boolean, false),
    'eligible', eligible,
    'recommended', eligible and not coalesce((overtime ->> 'requiresOverride')::boolean, false),
    'blockReason', block_reason
  );
end
$$;

-- Publishing an operational coverage opening must not mutate a published
-- schedule in place or publish a manager's unrelated draft.  Build a focused
-- release from the current published revision, then rebase any working draft.
create function private.create_absence_coverage_shift(
  target_source_shift_id uuid,
  target_actor_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  source_shift public.shifts%rowtype;
  source_schedule public.schedules%rowtype;
  latest_published public.schedules%rowtype;
  existing_draft public.schedules%rowtype;
  copied_shift public.shifts%rowtype;
  release_coverage_shift public.shifts%rowtype;
  release_schedule_id uuid;
  rebased_draft_schedule_id uuid;
  next_revision integer;
begin
  if target_actor_id is null or target_actor_id is distinct from private.current_employee_id() then
    raise insufficient_privilege using message = 'The authenticated coverage manager is required.';
  end if;

  select shift.* into source_shift
  from public.shifts shift
  where shift.id = target_source_shift_id
    and shift.canceled_at is null;

  if source_shift.id is not null then
    select schedule.* into source_schedule
    from public.schedules schedule
    where schedule.id = source_shift.schedule_id;
  end if;

  if source_shift.id is null or source_schedule.status not in ('published', 'superseded') then
    raise check_violation using message = 'Coverage can only be created from a published schedule assignment.';
  end if;

  perform pg_advisory_xact_lock(hashtext('schedule-draft:' || source_schedule.week_starts_on::text));

  select schedule.* into latest_published
  from public.schedules schedule
  where schedule.week_starts_on = source_schedule.week_starts_on
    and schedule.status = 'published'
  order by schedule.revision desc
  limit 1
  for update;

  if latest_published.id is null then
    raise check_violation using message = 'The current published schedule revision could not be found.';
  end if;

  if exists (
    select 1
    from public.shifts shift
    where shift.schedule_id = latest_published.id
      and shift.coverage_source_shift_id = target_source_shift_id
      and shift.canceled_at is null
  ) then
    raise check_violation using message = 'An active coverage shift already exists for this absence.';
  end if;

  select schedule.* into existing_draft
  from public.schedules schedule
  where schedule.week_starts_on = source_schedule.week_starts_on
    and schedule.status = 'draft'
  order by schedule.revision desc
  limit 1
  for update;

  select coalesce(max(schedule.revision), 0) + 1 into next_revision
  from public.schedules schedule
  where schedule.week_starts_on = source_schedule.week_starts_on;

  insert into public.schedules (
    week_starts_on, revision, status, previous_revision_id, created_by
  ) values (
    source_schedule.week_starts_on, next_revision, 'draft', latest_published.id, target_actor_id
  ) returning id into release_schedule_id;

  for copied_shift in
    select shift.*
    from public.shifts shift
    where shift.schedule_id = latest_published.id
      and shift.canceled_at is null
    order by shift.starts_at, shift.created_at, shift.id
  loop
    perform private.copy_schedule_shift_block(
      copied_shift.id, release_schedule_id, target_actor_id, null, null
    );
  end loop;

  insert into public.shifts (
    schedule_id, post_id, event_id, starts_at, ends_at, time_zone,
    headcount_required, requires_armed, is_open, is_overtime, notes,
    work_type, time_zone_source, time_zone_employee_id, assignment_type,
    coverage_source_shift_id, created_by
  ) values (
    release_schedule_id, source_shift.post_id, source_shift.event_id,
    source_shift.starts_at, source_shift.ends_at, source_shift.time_zone,
    1, source_shift.requires_armed, true, source_shift.is_overtime,
    concat_ws(E'\n', nullif(btrim(coalesce(source_shift.notes, '')), ''),
      'Absence coverage copy; the original assignment remains preserved.'),
    source_shift.work_type, source_shift.time_zone_source,
    source_shift.time_zone_employee_id, source_shift.assignment_type,
    target_source_shift_id, target_actor_id
  ) returning * into release_coverage_shift;

  update public.schedules schedule
  set status = 'superseded', updated_at = clock_timestamp()
  where schedule.id = latest_published.id;

  update public.schedules schedule
  set status = 'published', published_at = clock_timestamp(),
      published_by = target_actor_id, updated_at = clock_timestamp()
  where schedule.id = release_schedule_id;

  if existing_draft.id is not null then
    insert into public.schedules (
      week_starts_on, revision, status, previous_revision_id, created_by
    ) values (
      source_schedule.week_starts_on, next_revision + 1, 'draft',
      release_schedule_id, target_actor_id
    ) returning id into rebased_draft_schedule_id;

    -- Ordinary blocks come from the manager's draft. Operational coverage
    -- blocks come from the just-published release so their live state wins.
    for copied_shift in
      select shift.*
      from public.shifts shift
      where shift.schedule_id = existing_draft.id
        and shift.canceled_at is null
        and shift.coverage_source_shift_id is null
      order by shift.starts_at, shift.created_at, shift.id
    loop
      perform private.copy_schedule_shift_block(
        copied_shift.id, rebased_draft_schedule_id, target_actor_id, null, null
      );
    end loop;

    for copied_shift in
      select shift.*
      from public.shifts shift
      where shift.schedule_id = release_schedule_id
        and shift.canceled_at is null
        and shift.coverage_source_shift_id is not null
      order by shift.starts_at, shift.created_at, shift.id
    loop
      perform private.copy_schedule_shift_block(
        copied_shift.id, rebased_draft_schedule_id, target_actor_id, null, null
      );
    end loop;

    perform private.normalize_schedule_duplicate_shift_blocks(rebased_draft_schedule_id);

    update public.schedules schedule
    set status = 'archived', updated_at = clock_timestamp()
    where schedule.id = existing_draft.id;
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id,
    old_record, new_record
  ) values (
    auth.uid(), target_actor_id, 'public', 'schedules',
    'publish_absence_coverage', release_schedule_id::text,
    jsonb_build_object(
      'publishedScheduleId', latest_published.id,
      'workingDraftId', existing_draft.id
    ),
    jsonb_build_object(
      'publishedScheduleId', release_schedule_id,
      'coverageShiftId', release_coverage_shift.id,
      'sourceShiftId', target_source_shift_id,
      'rebasedDraftId', rebased_draft_schedule_id,
      'notificationQueued', false
    )
  );

  return release_coverage_shift.id;
end
$$;

-- A later schedule publication copies operational coverage blocks along with
-- ordinary shifts. Keep the live case, pending requests, and announcement
-- attached to the copy in the newest published revision.
create function private.remap_shift_coverage_revision()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  mapped_shift public.shifts%rowtype;
  case_before public.shift_coverage_cases%rowtype;
  case_after public.shift_coverage_cases%rowtype;
  mapped_assignment_id uuid;
begin
  if new.status <> 'published' or old.status is not distinct from new.status then
    return new;
  end if;

  for mapped_shift in
    select shift.*
    from public.shifts shift
    where shift.schedule_id = new.id
      and shift.coverage_source_shift_id is not null
      and shift.canceled_at is null
    order by shift.created_at, shift.id
  loop
    for case_before in
      select coverage.*
      from public.shift_coverage_cases coverage
      where coverage.source_shift_id = mapped_shift.coverage_source_shift_id
        and coverage.coverage_shift_id is distinct from mapped_shift.id
        and coverage.status in ('open_pool', 'assigned')
      for update
    loop
      mapped_assignment_id := null;
      if case_before.status = 'assigned' and case_before.replacement_employee_id is not null then
        select assignment.id into mapped_assignment_id
        from public.shift_assignments assignment
        where assignment.shift_id = mapped_shift.id
          and assignment.employee_id = case_before.replacement_employee_id
          and assignment.status in ('assigned', 'confirmed', 'completed')
        order by assignment.created_at, assignment.id
        limit 1;
        if mapped_assignment_id is null then
          raise check_violation using message = 'The assigned coverage guard was not preserved in the new schedule revision.';
        end if;
      end if;

      update public.shift_requests request
      set shift_id = mapped_shift.id, updated_at = clock_timestamp()
      where request.shift_id = case_before.coverage_shift_id
        and request.status = 'pending';

      update public.announcements announcement
      set shift_id = mapped_shift.id, updated_at = clock_timestamp()
      where announcement.id = case_before.announcement_id;

      update public.shift_coverage_cases coverage
      set coverage_shift_id = mapped_shift.id,
          replacement_assignment_id = case
            when coverage.status = 'assigned' then mapped_assignment_id
            else coverage.replacement_assignment_id
          end,
          updated_at = clock_timestamp()
      where coverage.id = case_before.id
      returning * into case_after;

      insert into public.shift_coverage_case_actions (
        coverage_case_id, action, actor_id, reason, before_record, after_record
      ) values (
        case_after.id, 'coverage_revision_rebased', private.current_employee_id(),
        'Carried the operational coverage shift into the newly published schedule revision.',
        to_jsonb(case_before), to_jsonb(case_after)
      );

      insert into private.audit_events (
        auth_user_id, employee_id, schema_name, table_name, operation, row_id,
        old_record, new_record
      ) values (
        auth.uid(), private.current_employee_id(), 'public', 'shift_coverage_cases',
        'REBASE_COVERAGE_SHIFT', case_after.id::text,
        jsonb_build_object('coverageShiftId', case_before.coverage_shift_id),
        jsonb_build_object(
          'coverageShiftId', case_after.coverage_shift_id,
          'scheduleId', new.id,
          'replacementAssignmentId', case_after.replacement_assignment_id
        )
      );
    end loop;
  end loop;

  return new;
end
$$;

create trigger schedules_remap_shift_coverage_revision
after update of status on public.schedules
for each row
when (new.status = 'published' and old.status is distinct from 'published')
execute function private.remap_shift_coverage_revision();

create function public.get_call_off_coverage_workspace(target_call_off_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  report_record public.call_off_reports%rowtype;
  shift_record public.shifts%rowtype;
  case_record public.shift_coverage_cases%rowtype;
  coverage_shift public.shifts%rowtype;
  absent_name text;
  site_name text;
  post_name text;
  event_name text;
  location_name text;
  candidates jsonb := '[]'::jsonb;
  actions jsonb := '[]'::jsonb;
begin
  if not private.shift_coverage_manager_allowed() then
    raise insufficient_privilege using message = 'Coverage management permission with MFA is required.';
  end if;

  select * into report_record
  from public.call_off_reports report
  where report.id = target_call_off_id;
  if report_record.id is null then
    raise check_violation using message = 'The call-off could not be found.';
  end if;

  select * into shift_record
  from public.shifts shift
  where shift.id = report_record.shift_id;

  select site.name, post.name, event.name,
         coalesce(event.location_name, site.name, post.name)
  into site_name, post_name, event_name, location_name
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where shift.id = report_record.shift_id;

  select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
  into absent_name
  from public.employees employee where employee.id = report_record.employee_id;

  select * into case_record
  from public.shift_coverage_cases coverage
  where coverage.call_off_report_id = report_record.id;

  if case_record.coverage_shift_id is not null then
    select * into coverage_shift
    from public.shifts shift
    where shift.id = case_record.coverage_shift_id;
  end if;

  select coalesce(jsonb_agg(payload order by
      case when (payload ->> 'recommended')::boolean and (payload ->> 'isFlex')::boolean then 0
           when (payload ->> 'recommended')::boolean then 1
           when (payload ->> 'eligible')::boolean then 2 else 3 end,
      lower(payload ->> 'name')), '[]'::jsonb)
  into candidates
  from (
    select private.shift_coverage_candidate_payload(shift_record.id, employee.id) payload
    from public.employees employee
    where employee.status = 'active'
      and employee.role = 'guard'
      and employee.id <> report_record.employee_id
  ) candidate_rows
  where payload is not null;

  if case_record.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', action.id,
      'action', action.action,
      'actorId', action.actor_id,
      'actorName', coalesce(
        btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name),
        'System'
      ),
      'reason', action.reason,
      'createdAt', action.created_at
    ) order by action.created_at, action.id), '[]'::jsonb)
    into actions
    from public.shift_coverage_case_actions action
    left join public.employees actor on actor.id = action.actor_id
    where action.coverage_case_id = case_record.id;
  end if;

  return jsonb_build_object(
    'callOff', jsonb_build_object(
      'id', report_record.id,
      'employeeId', report_record.employee_id,
      'employeeName', absent_name,
      'reason', report_record.reason,
      'reportedAt', report_record.reported_at,
      'replacementNeeded', report_record.replacement_needed
    ),
    'shift', jsonb_build_object(
      'id', shift_record.id,
      'startsAt', shift_record.starts_at,
      'endsAt', shift_record.ends_at,
      'timeZone', shift_record.time_zone,
      'title', coalesce(event_name, post_name, 'Scheduled shift'),
      'location', coalesce(location_name, 'Location not recorded'),
      'requiresArmed', shift_record.requires_armed,
      'isOpen', coalesce(coverage_shift.is_open, false)
    ),
    'coverageCase', case when case_record.id is null then null else jsonb_build_object(
      'id', case_record.id,
      'status', case_record.status,
      'coverageMode', case_record.coverage_mode,
      'replacementEmployeeId', case_record.replacement_employee_id,
      'replacementAssignmentId', case_record.replacement_assignment_id,
      'coverageShiftId', case_record.coverage_shift_id,
      'announcementId', case_record.announcement_id,
      'allowOvertimeWave', case_record.allow_overtime_wave,
      'originalAssignment', case_record.original_assignment_snapshot,
      'openedAt', case_record.opened_at,
      'resolvedAt', case_record.resolved_at
    ) end,
    'candidates', candidates,
    'actions', actions,
    'attendancePolicy', jsonb_build_object(
      'pointsActive', false,
      'message', 'No attendance-point policy is currently active. An unexcused decision records the classification only.'
    ),
    'patrolFallback', jsonb_build_object(
      'available', shift_record.post_id is not null,
      'message', case when shift_record.post_id is null
        then 'A site or post link is required before Dispatch can review patrol fallback.'
        else 'Dispatch can review this site for a one-night patrol plan without changing the standing route.' end
    )
  );
end
$$;

create function public.resolve_call_off_coverage(
  target_call_off_id uuid,
  target_mode text,
  target_replacement_employee_id uuid,
  announcement_title text,
  announcement_body text,
  target_reason text,
  target_allow_overtime boolean,
  target_idempotency_key uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_mode text := btrim(coalesce(target_mode, ''));
  clean_reason text := btrim(coalesce(target_reason, ''));
  report_record public.call_off_reports%rowtype;
  shift_record public.shifts%rowtype;
  coverage_shift public.shifts%rowtype;
  original_assignment public.shift_assignments%rowtype;
  before_case public.shift_coverage_cases%rowtype;
  coverage_case public.shift_coverage_cases%rowtype;
  candidate jsonb;
  created_assignment_id uuid;
  created_announcement_id uuid;
  source_snapshot jsonb;
  action_name text;
begin
  if not private.shift_coverage_manager_allowed() then
    raise insufficient_privilege using message = 'Coverage management permission with MFA is required.';
  end if;
  if target_idempotency_key is null then
    raise check_violation using message = 'A stable request identifier is required.';
  end if;
  if clean_mode not in ('open_pool', 'assigned_guard', 'patrol_review', 'no_replacement') then
    raise check_violation using message = 'Choose how this absence should be covered.';
  end if;
  if char_length(clean_reason) < 8 or char_length(clean_reason) > 2000 then
    raise check_violation using message = 'Enter a clear coverage note of 8 to 2,000 characters.';
  end if;

  select * into coverage_case
  from public.shift_coverage_cases coverage
  where coverage.last_idempotency_key = target_idempotency_key;
  if coverage_case.id is not null then
    return jsonb_build_object(
      'coverageCaseId', coverage_case.id,
      'status', coverage_case.status,
      'coverageMode', coverage_case.coverage_mode,
      'coverageShiftId', coverage_case.coverage_shift_id,
      'announcementId', coverage_case.announcement_id,
      'replacementAssignmentId', coverage_case.replacement_assignment_id,
      'idempotentReplay', true
    );
  end if;

  select * into report_record
  from public.call_off_reports report
  where report.id = target_call_off_id and report.canceled_at is null
  for update;
  if report_record.id is null then
    raise check_violation using message = 'This call-off is no longer available.';
  end if;

  select * into shift_record
  from public.shifts shift
  where shift.id = report_record.shift_id and shift.canceled_at is null
  for update;
  if shift_record.id is null or shift_record.ends_at <= clock_timestamp() then
    raise check_violation using message = 'The called-off shift has ended or is no longer active.';
  end if;

  select * into coverage_case
  from public.shift_coverage_cases coverage
  where coverage.call_off_report_id = report_record.id
  for update;
  before_case := coverage_case;

  if coverage_case.id is null then
    select * into original_assignment
    from public.shift_assignments assignment
    where assignment.shift_id = shift_record.id
      and assignment.employee_id = report_record.employee_id
      and assignment.status in ('assigned', 'confirmed')
    for update;
    if original_assignment.id is null then
      raise check_violation using message = 'The original assignment is no longer active.';
    end if;

    select jsonb_build_object(
      'assignmentId', original_assignment.id,
      'employeeId', report_record.employee_id,
      'employeeName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
      'employeeNumber', employee.employee_number,
      'assignmentStatus', original_assignment.status,
      'shiftId', shift_record.id,
      'scheduleId', shift_record.schedule_id,
      'startsAt', shift_record.starts_at,
      'endsAt', shift_record.ends_at,
      'timeZone', shift_record.time_zone,
      'postId', shift_record.post_id,
      'eventId', shift_record.event_id,
      'requiresArmed', shift_record.requires_armed,
      'capturedAt', clock_timestamp()
    ) into source_snapshot
    from public.employees employee where employee.id = report_record.employee_id;

    insert into public.shift_coverage_cases (
      call_off_report_id, attendance_event_id, source_shift_id, source_assignment_id,
      absent_employee_id, original_assignment_snapshot, last_idempotency_key, opened_by
    ) values (
      report_record.id,
      (select event.id from public.attendance_accountability_events event
       where event.call_off_report_id = report_record.id order by event.created_at desc limit 1),
      shift_record.id, original_assignment.id, report_record.employee_id,
      source_snapshot, target_idempotency_key, actor_id
    ) returning * into coverage_case;

    insert into public.shift_coverage_case_actions (
      coverage_case_id, action, actor_id, reason, before_record, after_record
    ) values (
      coverage_case.id, 'created', actor_id, clean_reason, null, to_jsonb(coverage_case)
    );
  else
    update public.shift_coverage_cases
    set last_idempotency_key = target_idempotency_key, updated_at = clock_timestamp()
    where id = coverage_case.id
    returning * into coverage_case;
  end if;

  if coverage_case.status in ('assigned', 'no_replacement', 'closed', 'canceled') then
    raise check_violation using message = 'This coverage case is already complete.';
  end if;

  if (coverage_case.status = 'open_pool' and clean_mode = 'open_pool')
     or (coverage_case.status = 'patrol_review' and clean_mode = 'patrol_review') then
    return jsonb_build_object(
      'coverageCaseId', coverage_case.id,
      'status', coverage_case.status,
      'coverageMode', coverage_case.coverage_mode,
      'coverageShiftId', coverage_case.coverage_shift_id,
      'announcementId', coverage_case.announcement_id,
      'replacementAssignmentId', coverage_case.replacement_assignment_id,
      'idempotentReplay', true
    );
  end if;

  if clean_mode in ('open_pool', 'assigned_guard') then
    if coverage_case.coverage_shift_id is not null then
      select * into coverage_shift
      from public.shifts shift
      where shift.id = coverage_case.coverage_shift_id
        and shift.canceled_at is null
      for update;
    end if;

    if coverage_shift.id is null then
      coverage_shift.id := private.create_absence_coverage_shift(shift_record.id, actor_id);

      select shift.* into coverage_shift
      from public.shifts shift
      where shift.id = coverage_shift.id;

      update public.shift_coverage_cases
      set coverage_shift_id = coverage_shift.id,
          updated_at = clock_timestamp()
      where id = coverage_case.id
      returning * into coverage_case;
    end if;
  end if;

  if clean_mode = 'assigned_guard' then
    if target_replacement_employee_id is null then
      raise check_violation using message = 'Choose the guard who accepted this shift.';
    end if;
    if target_replacement_employee_id = report_record.employee_id then
      raise check_violation using message = 'The absent employee cannot be selected as the replacement.';
    end if;
    candidate := private.shift_coverage_candidate_payload(coverage_shift.id, target_replacement_employee_id);
    if candidate is null or not coalesce((candidate ->> 'eligible')::boolean, false) then
      raise check_violation using message = coalesce(candidate ->> 'blockReason', 'The selected guard is not eligible for this shift.');
    end if;
    if coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false) and not target_allow_overtime then
      raise check_violation using message = 'This guard would enter scheduled overtime. Confirm the overtime approval before assigning them.';
    end if;

    insert into public.shift_assignments (shift_id, employee_id, status, assigned_by)
    values (coverage_shift.id, target_replacement_employee_id, 'assigned', actor_id)
    on conflict (shift_id, employee_id) do update
      set status = 'assigned', assigned_by = excluded.assigned_by,
          assigned_at = clock_timestamp(), canceled_at = null, cancellation_reason = null,
          updated_at = clock_timestamp()
    returning id into created_assignment_id;

    update public.shifts set is_open = false, updated_at = clock_timestamp()
    where id = coverage_shift.id;
    update public.shift_requests
    set status = 'declined', decided_by = actor_id, decided_at = clock_timestamp(),
        decision_note = 'Coverage was assigned directly by management.', updated_at = clock_timestamp()
    where shift_id = coverage_shift.id and status = 'pending';
    update public.announcements set expires_at = least(coalesce(expires_at, clock_timestamp()), clock_timestamp()),
      updated_at = clock_timestamp()
    where id = coverage_case.announcement_id;
    update private.shift_coverage_notification_waves set status = 'canceled', processed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where coverage_case_id = coverage_case.id and status in ('pending', 'processing');

    update public.shift_coverage_cases
    set status = 'assigned', coverage_mode = clean_mode,
        replacement_employee_id = target_replacement_employee_id,
        replacement_assignment_id = created_assignment_id,
        allow_overtime_wave = target_allow_overtime,
        resolved_by = actor_id, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = coverage_case.id returning * into coverage_case;
    action_name := 'assigned_guard';
  elsif clean_mode = 'open_pool' then
    if btrim(coalesce(announcement_title, '')) = '' or char_length(announcement_title) > 160 then
      raise check_violation using message = 'Enter an opening title of 160 characters or fewer.';
    end if;
    if btrim(coalesce(announcement_body, '')) = '' or char_length(announcement_body) > 4000 then
      raise check_violation using message = 'Enter an opening message of 4,000 characters or fewer.';
    end if;

    if coverage_case.announcement_id is null then
      insert into public.announcements (
        kind, title, body, shift_id, published_at, expires_at, created_by,
        recipient_roles, requires_armed, audience_mode, template_key
      ) values (
        'open_shift', btrim(announcement_title), btrim(announcement_body), coverage_shift.id,
        clock_timestamp(), shift_record.ends_at, actor_id,
        array['guard'::public.app_role], shift_record.requires_armed, 'roles', 'shift_coverage_staged'
      ) returning id into created_announcement_id;
    else
      created_announcement_id := coverage_case.announcement_id;
      update public.announcements announcement
      set title = btrim(announcement_title), body = btrim(announcement_body),
          shift_id = coverage_shift.id, published_at = clock_timestamp(),
          expires_at = shift_record.ends_at,
          recipient_roles = array['guard'::public.app_role],
          requires_armed = shift_record.requires_armed,
          audience_mode = 'roles', template_key = 'shift_coverage_staged',
          updated_at = clock_timestamp()
      where announcement.id = created_announcement_id;
    end if;

    update public.shifts set is_open = true, updated_at = clock_timestamp()
    where id = coverage_shift.id;
    update public.call_off_reports
    set acknowledged_by = actor_id, acknowledged_at = coalesce(acknowledged_at, clock_timestamp()),
        announcement_id = created_announcement_id, updated_at = clock_timestamp()
    where id = report_record.id;
    update public.shift_coverage_cases
    set status = 'open_pool', coverage_mode = clean_mode, announcement_id = created_announcement_id,
        allow_overtime_wave = target_allow_overtime, resolved_by = null, resolved_at = null,
        updated_at = clock_timestamp()
    where id = coverage_case.id returning * into coverage_case;

    insert into private.shift_coverage_notification_waves (coverage_case_id, wave_number, audience, due_at)
    values
      (coverage_case.id, 1, 'flex_no_overtime', clock_timestamp()),
      (coverage_case.id, 2, 'other_no_overtime', clock_timestamp() + interval '10 minutes')
    on conflict (coverage_case_id, wave_number) do update set
      audience = excluded.audience, due_at = excluded.due_at, status = 'pending',
      attempts = 0, recipient_count = 0, claimed_at = null, processed_at = null,
      last_error = null, updated_at = clock_timestamp();
    if target_allow_overtime then
      insert into private.shift_coverage_notification_waves (coverage_case_id, wave_number, audience, due_at)
      values (coverage_case.id, 3, 'overtime', clock_timestamp() + interval '20 minutes')
      on conflict (coverage_case_id, wave_number) do update set
        audience = excluded.audience, due_at = excluded.due_at, status = 'pending',
        attempts = 0, recipient_count = 0, claimed_at = null, processed_at = null,
        last_error = null, updated_at = clock_timestamp();
    end if;
    action_name := 'opened_pool';
  elsif clean_mode = 'patrol_review' then
    if shift_record.post_id is null then
      raise check_violation using message = 'This shift needs a site or post before Patrol can review it.';
    end if;
    if coverage_case.coverage_shift_id is not null then
      update public.shifts
      set is_open = false, updated_at = clock_timestamp()
      where id = coverage_case.coverage_shift_id;
      update public.shift_requests
      set status = 'declined', decided_by = actor_id, decided_at = clock_timestamp(),
          decision_note = 'Coverage moved to one-night patrol review.', updated_at = clock_timestamp()
      where shift_id = coverage_case.coverage_shift_id and status = 'pending';
    end if;
    update public.announcements
    set expires_at = least(coalesce(expires_at, clock_timestamp()), clock_timestamp()),
        updated_at = clock_timestamp()
    where id = coverage_case.announcement_id;
    update private.shift_coverage_notification_waves
    set status = 'canceled', processed_at = clock_timestamp(), updated_at = clock_timestamp()
    where coverage_case_id = coverage_case.id and status in ('pending', 'processing');
    update public.shift_coverage_cases
    set status = 'patrol_review', coverage_mode = clean_mode, resolved_by = null, resolved_at = null,
        updated_at = clock_timestamp()
    where id = coverage_case.id returning * into coverage_case;
    update public.call_off_reports
    set acknowledged_by = actor_id, acknowledged_at = coalesce(acknowledged_at, clock_timestamp()),
        updated_at = clock_timestamp()
    where id = report_record.id;

    perform private.create_employee_notification(
      employee.id, 'shift_coverage', coverage_case.id,
      concat('shift-coverage-patrol-review:', coverage_case.id, ':', employee.id),
      'Patrol coverage review requested',
      'A scheduled site needs a one-night patrol coverage review. Open Requests for the shift window and protected operational details.',
      'urgent', true, '/requests', 'Review coverage', actor_id, null, shift_record.ends_at
    )
    from public.employees employee
    where employee.status = 'active'
      and 'patrol.assignments.manage' = any(private.employee_effective_permissions(employee.id));
    action_name := 'patrol_review_requested';
  else
    if coverage_case.coverage_shift_id is not null then
      update public.shifts
      set is_open = false, updated_at = clock_timestamp()
      where id = coverage_case.coverage_shift_id;
      update public.shift_requests
      set status = 'declined', decided_by = actor_id, decided_at = clock_timestamp(),
          decision_note = 'Management confirmed no replacement is required.', updated_at = clock_timestamp()
      where shift_id = coverage_case.coverage_shift_id and status = 'pending';
    end if;
    update public.announcements set expires_at = least(coalesce(expires_at, clock_timestamp()), clock_timestamp()),
      updated_at = clock_timestamp()
    where id = coverage_case.announcement_id;
    update private.shift_coverage_notification_waves set status = 'canceled', processed_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where coverage_case_id = coverage_case.id and status in ('pending', 'processing');
    update public.shift_coverage_cases
    set status = 'no_replacement', coverage_mode = clean_mode,
        resolved_by = actor_id, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = coverage_case.id returning * into coverage_case;
    update public.call_off_reports
    set acknowledged_by = actor_id, acknowledged_at = coalesce(acknowledged_at, clock_timestamp()),
        resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = report_record.id;
    action_name := 'no_replacement';
  end if;

  if clean_mode in ('assigned_guard', 'no_replacement') then
    update public.call_off_reports
    set acknowledged_by = actor_id, acknowledged_at = coalesce(acknowledged_at, clock_timestamp()),
        resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    where id = report_record.id;
  end if;

  insert into public.shift_coverage_case_actions (
    coverage_case_id, action, actor_id, reason, before_record, after_record
  ) values (
    coverage_case.id, action_name, actor_id, clean_reason,
    case when before_case.id is null then null else to_jsonb(before_case) end,
    to_jsonb(coverage_case)
  );

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    auth.uid(), actor_id, 'public', 'shift_coverage_cases', 'RESOLVE', coverage_case.id::text,
    case when before_case.id is null then null else jsonb_build_object(
      'status', before_case.status, 'coverageMode', before_case.coverage_mode
    ) end,
    jsonb_build_object(
      'status', coverage_case.status, 'coverageMode', coverage_case.coverage_mode,
      'sourceShiftId', coverage_case.source_shift_id,
      'coverageShiftId', coverage_case.coverage_shift_id,
      'replacementEmployeeId', coverage_case.replacement_employee_id
    )
  );

  return jsonb_build_object(
    'coverageCaseId', coverage_case.id,
    'status', coverage_case.status,
    'coverageMode', coverage_case.coverage_mode,
    'coverageShiftId', coverage_case.coverage_shift_id,
    'announcementId', coverage_case.announcement_id,
    'replacementAssignmentId', coverage_case.replacement_assignment_id,
    'idempotentReplay', false
  );
end
$$;

-- Staged coverage announcements remain visible in the open-shift surface, while
-- the dedicated wave processor controls audible/email delivery to Flex guards
-- first.  All other announcement types retain their established outbox path.
create or replace function private.enqueue_published_announcement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.published_at is not null
    and new.template_key is distinct from 'shift_coverage_staged'
    and (tg_op = 'INSERT' or old.published_at is null)
  then
    insert into private.notification_outbox (
      message_type, aggregate_type, aggregate_id, payload, idempotency_key
    ) values (
      'announcement_published', 'announcement', new.id,
      jsonb_build_object(
        'announcementId', new.id, 'kind', new.kind,
        'shiftId', new.shift_id, 'eventId', new.event_id
      ),
      'announcement:' || new.id::text || ':published'
    );
  end if;
  return new;
end
$$;

create function public.service_process_shift_coverage_notification_waves(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  wave private.shift_coverage_notification_waves%rowtype;
  coverage public.shift_coverage_cases%rowtype;
  shift_record public.shifts%rowtype;
  employee public.employees%rowtype;
  candidate jsonb;
  sent_count integer;
  processed_count integer := 0;
  total_recipients integer := 0;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service-role access is required.';
  end if;

  for wave in
    select * from private.shift_coverage_notification_waves pending
    where pending.status in ('pending', 'processing')
      and pending.due_at <= clock_timestamp()
      and (pending.status = 'pending' or pending.claimed_at < clock_timestamp() - interval '5 minutes')
    order by pending.due_at, pending.id
    for update skip locked
    limit greatest(1, least(coalesce(target_limit, 25), 100))
  loop
    update private.shift_coverage_notification_waves
    set status = 'processing', attempts = attempts + 1, claimed_at = clock_timestamp(),
        updated_at = clock_timestamp(), last_error = null
    where id = wave.id;
    sent_count := 0;

    begin
      select * into coverage from public.shift_coverage_cases where id = wave.coverage_case_id;
      select * into shift_record from public.shifts where id = coverage.coverage_shift_id;
      if coverage.status <> 'open_pool' or not coalesce(shift_record.is_open, false)
         or shift_record.ends_at <= clock_timestamp() then
        update private.shift_coverage_notification_waves
        set status = 'canceled', processed_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = wave.id;
        continue;
      end if;

      for employee in
        select * from public.employees candidate_employee
        where candidate_employee.status = 'active'
          and candidate_employee.role = 'guard'
          and candidate_employee.id <> coverage.absent_employee_id
        order by candidate_employee.id
      loop
        candidate := private.shift_coverage_candidate_payload(shift_record.id, employee.id);
        if candidate is null or not coalesce((candidate ->> 'eligible')::boolean, false) then continue; end if;
        if wave.audience = 'flex_no_overtime' and not (
          coalesce((candidate ->> 'isFlex')::boolean, false)
          and not coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false)
        ) then continue; end if;
        if wave.audience = 'other_no_overtime' and not (
          not coalesce((candidate ->> 'isFlex')::boolean, false)
          and not coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false)
        ) then continue; end if;
        if wave.audience = 'overtime' and not (
          coverage.allow_overtime_wave
          and coalesce((candidate ->> 'requiresOvertimeApproval')::boolean, false)
        ) then continue; end if;

        perform private.create_employee_notification(
          employee.id, 'shift_coverage', coverage.id,
          concat('shift-coverage:', coverage.id, ':wave:', wave.wave_number, ':employee:', employee.id),
          case when wave.audience = 'overtime' then 'Open shift — overtime approval available' else 'Open shift available' end,
          concat(
            'A ', case when shift_record.requires_armed then 'qualified armed ' else 'qualified ' end,
            'guard is needed ', to_char(shift_record.starts_at at time zone shift_record.time_zone, 'Mon FMMonth FMDD at FMHH12:MI AM'),
            '. Review the shift details and request it if you are available.'
          ),
          case when wave.wave_number = 1 then 'important' else 'urgent' end,
          false, '/schedule', 'Review open shift', coverage.opened_by, null, shift_record.ends_at
        );
        sent_count := sent_count + 1;
      end loop;

      update private.shift_coverage_notification_waves
      set status = 'sent', recipient_count = sent_count, processed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      where id = wave.id;
      insert into public.shift_coverage_case_actions (
        coverage_case_id, action, actor_id, reason, before_record, after_record
      ) values (
        coverage.id, 'notification_wave_sent', null,
        format('Notification wave %s completed for %s eligible guard(s).', wave.wave_number, sent_count),
        null, jsonb_build_object('waveNumber', wave.wave_number, 'audience', wave.audience, 'recipientCount', sent_count)
      );
      processed_count := processed_count + 1;
      total_recipients := total_recipients + sent_count;
    exception when others then
      update private.shift_coverage_notification_waves
      set status = case when attempts >= 5 then 'failed' else 'pending' end,
          due_at = case when attempts >= 5 then due_at else clock_timestamp() + interval '2 minutes' end,
          last_error = left(sqlerrm, 1000), updated_at = clock_timestamp()
      where id = wave.id;
    end;
  end loop;

  return jsonb_build_object('processed', processed_count, 'recipients', total_recipients);
end
$$;

create or replace function public.publish_call_off_opening(
  target_call_off_id uuid,
  announcement_title text,
  announcement_body text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  result := public.resolve_call_off_coverage(
    target_call_off_id, 'open_pool', null, announcement_title, announcement_body,
    'Published the replacement opening through the preserved absence coverage workflow.',
    false, gen_random_uuid()
  );
  return nullif(result ->> 'announcementId', '')::uuid;
end
$$;

create or replace function public.decide_shift_request(
  target_request_id uuid,
  target_decision public.request_status,
  target_note text default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  request_record public.shift_requests%rowtype;
  required_headcount integer;
  assigned_headcount integer;
  created_assignment_id uuid;
  coverage_before public.shift_coverage_cases%rowtype;
  coverage_after public.shift_coverage_cases%rowtype;
  coverage_candidate jsonb;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to decide shift requests.';
  end if;
  if not public.has_mfa() or not public.has_any_effective_permission(array['requests.manage','shift_pool.manage']::text[]) then
    raise insufficient_privilege using message = 'Request management permission with MFA is required to decide shift requests.';
  end if;
  if target_decision not in ('approved', 'declined') then
    raise check_violation using message = 'A shift request can only be approved or declined.';
  end if;
  if target_decision = 'declined' and btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A decline note is required.';
  end if;
  if char_length(coalesce(target_note, '')) > 2000 then
    raise check_violation using message = 'The decision note exceeds 2,000 characters.';
  end if;

  select * into request_record from public.shift_requests request
  where request.id = target_request_id and request.status = 'pending' for update;
  if request_record.id is null then
    raise check_violation using message = 'The shift request is no longer pending.';
  end if;

  if target_decision = 'approved' then
    select * into coverage_before from public.shift_coverage_cases coverage
    where coverage.coverage_shift_id = request_record.shift_id and coverage.status = 'open_pool'
    for update;
    if coverage_before.id is not null then
      coverage_candidate := private.shift_coverage_candidate_payload(request_record.shift_id, request_record.employee_id);
      if coverage_candidate is null or not coalesce((coverage_candidate ->> 'eligible')::boolean, false) then
        raise check_violation using message = coalesce(
          coverage_candidate ->> 'blockReason',
          'This guard is no longer eligible for the coverage shift.'
        );
      end if;
      if coalesce((coverage_candidate ->> 'requiresOvertimeApproval')::boolean, false)
         and not coverage_before.allow_overtime_wave then
        raise check_violation using message = 'This approval would create scheduled overtime that was not authorized for this opening.';
      end if;
    end if;

    insert into public.shift_assignments (shift_id, employee_id, assigned_by)
    values (request_record.shift_id, request_record.employee_id, reviewer_id)
    returning id into created_assignment_id;
  end if;

  update public.shift_requests set status = target_decision, decided_by = reviewer_id,
    decided_at = clock_timestamp(), decision_note = nullif(btrim(target_note), ''),
    updated_at = clock_timestamp()
  where id = request_record.id;

  if target_decision = 'approved' then
    select shift.headcount_required into required_headcount from public.shifts shift where shift.id = request_record.shift_id;
    select count(*) into assigned_headcount from public.shift_assignments assignment
    where assignment.shift_id = request_record.shift_id and assignment.status in ('assigned','confirmed','completed');
    if assigned_headcount >= required_headcount then
      update public.shifts set is_open = false, updated_at = clock_timestamp() where id = request_record.shift_id;
      update public.shift_requests set status = 'declined', decided_by = reviewer_id,
        decided_at = clock_timestamp(), decision_note = 'The opening was filled by another approved request.',
        updated_at = clock_timestamp()
      where shift_id = request_record.shift_id and id <> request_record.id and status = 'pending';

      if coverage_before.id is not null then
        update public.shift_coverage_cases set status = 'assigned', coverage_mode = 'assigned_guard',
          replacement_employee_id = request_record.employee_id, replacement_assignment_id = created_assignment_id,
          resolved_by = reviewer_id, resolved_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = coverage_before.id returning * into coverage_after;
        update public.call_off_reports set resolved_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = coverage_before.call_off_report_id;
        update public.announcements set expires_at = least(coalesce(expires_at, clock_timestamp()), clock_timestamp()),
          updated_at = clock_timestamp() where id = coverage_before.announcement_id;
        update private.shift_coverage_notification_waves set status = 'canceled', processed_at = clock_timestamp(),
          updated_at = clock_timestamp()
        where coverage_case_id = coverage_before.id and status in ('pending','processing');
        insert into public.shift_coverage_case_actions (
          coverage_case_id, action, actor_id, reason, before_record, after_record
        ) values (
          coverage_after.id, 'request_approved', reviewer_id,
          'Approved the guard request and closed the linked coverage opening.',
          to_jsonb(coverage_before), to_jsonb(coverage_after)
        );
      end if;
    end if;
  end if;
  return true;
end
$$;

create or replace function public.review_attendance_accountability_event(
  target_event_id uuid,
  target_action text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_action text := btrim(coalesce(target_action, ''));
  clean_reason text := btrim(coalesce(target_reason, ''));
  before_record public.attendance_accountability_events%rowtype;
  after_record public.attendance_accountability_events%rowtype;
  next_status text;
  next_outcome text;
begin
  if actor_id is null then raise insufficient_privilege using message = 'An active employee account is required.'; end if;
  if not public.has_mfa() or not public.has_effective_permission('accountability.manage') then
    raise insufficient_privilege using message = 'Accountability management permission with MFA is required.';
  end if;
  if clean_action not in ('confirmed','unexcused','excused_protected','corrected','dismissed','voided','reopened') then
    raise check_violation using message = 'Choose a supported accountability decision.';
  end if;
  if char_length(clean_reason) < 8 then raise check_violation using message = 'Enter a clear reason of at least 8 characters.'; end if;
  if char_length(clean_reason) > 2000 then raise check_violation using message = 'The reason exceeds 2,000 characters.'; end if;

  select * into before_record from public.attendance_accountability_events event
  where event.id = target_event_id for update;
  if before_record.id is null then raise check_violation using message = 'The accountability occurrence could not be found.'; end if;

  if clean_action = 'reopened' then next_status := 'reported'; next_outcome := null;
  elsif clean_action = 'voided' then next_status := 'voided'; next_outcome := null;
  else next_status := 'resolved'; next_outcome := clean_action;
  end if;

  update public.attendance_accountability_events
  set status = next_status, review_outcome = next_outcome, reviewed_by = actor_id,
      reviewed_at = clock_timestamp(), decision_note = clean_reason, updated_at = clock_timestamp()
  where id = before_record.id returning * into after_record;

  insert into public.attendance_accountability_event_actions(event_id, action, reason, actor_id, before_record, after_record)
  values(after_record.id, clean_action, clean_reason, actor_id, to_jsonb(before_record), to_jsonb(after_record));
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values(auth.uid(), actor_id, 'public', 'attendance_accountability_events', 'REVIEW', after_record.id::text,
    jsonb_build_object('status',before_record.status,'reviewOutcome',before_record.review_outcome,'decisionNote',before_record.decision_note),
    jsonb_build_object('status',after_record.status,'reviewOutcome',after_record.review_outcome,'decisionNote',after_record.decision_note,'reviewedBy',after_record.reviewed_by,'reviewedAt',after_record.reviewed_at));
  return jsonb_build_object('id',after_record.id,'status',after_record.status,'reviewOutcome',after_record.review_outcome,
    'decisionNote',after_record.decision_note,'reviewedBy',after_record.reviewed_by,'reviewedAt',after_record.reviewed_at);
end
$$;

revoke all on function public.get_call_off_coverage_workspace(uuid) from public, anon;
revoke all on function public.resolve_call_off_coverage(uuid,text,uuid,text,text,text,boolean,uuid) from public, anon;
revoke all on function public.service_process_shift_coverage_notification_waves(integer) from public, anon, authenticated;
revoke all on function public.publish_call_off_opening(uuid,text,text) from public, anon;
revoke all on function public.decide_shift_request(uuid,public.request_status,text) from public, anon;
revoke all on function public.review_attendance_accountability_event(uuid,text,text) from public, anon;
revoke all on function private.prevent_shift_coverage_action_mutation() from public, anon, authenticated;
revoke all on function private.shift_coverage_manager_allowed() from public, anon, authenticated;
revoke all on function private.shift_coverage_candidate_payload(uuid,uuid) from public, anon, authenticated;
revoke all on function private.create_absence_coverage_shift(uuid,uuid) from public, anon, authenticated;
revoke all on function private.remap_shift_coverage_revision() from public, anon, authenticated;

grant execute on function public.get_call_off_coverage_workspace(uuid) to authenticated;
grant execute on function public.resolve_call_off_coverage(uuid,text,uuid,text,text,text,boolean,uuid) to authenticated;
grant execute on function public.service_process_shift_coverage_notification_waves(integer) to service_role;
grant execute on function public.publish_call_off_opening(uuid,text,text) to authenticated;
grant execute on function public.decide_shift_request(uuid,public.request_status,text) to authenticated;
grant execute on function public.review_attendance_accountability_event(uuid,text,text) to authenticated;

comment on table public.shift_coverage_cases is
  'Preserves the original assignment and links a separate coverage shift to the operational response for an employee absence.';
comment on column public.shifts.coverage_source_shift_id is
  'Links a separate operational coverage block to the immutable shift whose original assignment is being preserved.';
comment on function private.create_absence_coverage_shift(uuid,uuid) is
  'Publishes a focused schedule revision containing a separate absence coverage shift and rebases any unrelated manager draft.';
comment on function private.remap_shift_coverage_revision() is
  'Carries active coverage cases, requests, announcements, and replacement assignments into later published schedule revisions.';
comment on function public.resolve_call_off_coverage(uuid,text,uuid,text,text,text,boolean,uuid) is
  'Atomically preserves an absent employee assignment, creates a separate coverage shift, validates replacement eligibility, and opens, assigns, patrol-routes, or closes coverage.';
comment on function public.service_process_shift_coverage_notification_waves(integer) is
  'Processes bounded, idempotent Flex-first open-shift notifications and revalidates every recipient at delivery time.';

notify pgrst, 'reload schema';

commit;
