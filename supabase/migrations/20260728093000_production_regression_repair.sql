begin;

create or replace function private.can_override_schedule_warnings()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    public.has_mfa()
    and (
      public.has_effective_permission('schedule.override_warnings')
      or public.is_supervisor_or_admin()
    ),
    false
  )
$$;

comment on function private.can_override_schedule_warnings() is
  'Central permission check for documented schedule warning overrides, including armed credential overrides.';

drop function if exists public.admin_separate_employee(uuid, text, date);

create function public.admin_separate_employee(
  target_employee_id uuid,
  separation_reason text default null,
  target_separated_on date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  separation_result jsonb;
begin
  actor_id := private.require_admin_mfa();
  separation_result := private.separate_employee_account_and_future_work(
    target_employee_id,
    actor_id,
    separation_reason,
    target_separated_on
  );

  return private.admin_user_record(target_employee_id) || separation_result;
end
$$;

create or replace function public.admin_update_employee(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_job_title text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  before_record jsonb;
  after_record jsonb;
begin
  actor_id := private.require_admin_mfa();
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
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

  if (before_record ->> 'role') = 'admin'
    and (
      target_role <> 'admin'
      or target_status <> 'active'
    )
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  update public.employees employee
  set
    employee_number = nullif(upper(btrim(coalesce(target_employee_number, ''))), ''),
    job_title = nullif(btrim(coalesce(target_job_title, '')), ''),
    first_name = btrim(target_first_name),
    middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
    last_name = btrim(target_last_name),
    preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
    role = target_role,
    employment_type = target_employment_type,
    status = target_status,
    separated_on = case
      when target_status = 'separated' then coalesce(employee.separated_on, (clock_timestamp() at time zone 'America/Denver')::date)
      when target_status = 'active' then null
      else employee.separated_on
    end,
    updated_at = clock_timestamp()
  where employee.id = target_employee_id;

  insert into private.employee_contacts (
    employee_id,
    personal_email,
    company_email,
    mobile_phone
  ) values (
    target_employee_id,
    nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
    nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
    nullif(btrim(coalesce(target_mobile_phone, '')), '')
  )
  on conflict (employee_id) do update set
    personal_email = excluded.personal_email,
    company_email = excluded.company_email,
    mobile_phone = excluded.mobile_phone,
    updated_at = clock_timestamp();

  if target_status = 'separated' then
    perform private.separate_employee_account_and_future_work(
      target_employee_id,
      actor_id,
      'Employee marked separated from Users & Access.',
      null
    );
  end if;

  after_record := private.admin_user_record(target_employee_id);

  insert into private.audit_log (
    actor_auth_id,
    actor_employee_id,
    schema_name,
    table_name,
    action,
    record_id,
    before_data,
    after_data
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'UPDATE',
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

create or replace function private.enforce_shift_qualification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  shift_date date;
  inherited_assignment boolean := false;
begin
  if tg_table_name = 'shift_assignments' and new.status::text = 'canceled' then
    return new;
  end if;

  if tg_table_name = 'shift_requests'
    and new.status::text in ('withdrawn', 'canceled', 'declined')
  then
    return new;
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = new.shift_id;

  shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;

  if not target_shift.requires_armed
    or public.has_valid_credential(new.employee_id, 'armed_guard', shift_date)
  then
    return new;
  end if;

  if tg_table_name = 'shift_assignments'
    and (
      exists (
        select 1
        from public.schedule_assignment_overrides override_record
        where override_record.shift_id = new.shift_id
          and override_record.employee_id = new.employee_id
          and override_record.override_kind = 'armed_credential'
      )
      or (
        current_setting('app.allow_armed_credential_override', true) = 'on'
        and private.can_override_schedule_warnings()
      )
    )
  then
    return new;
  end if;

  if tg_table_name = 'shift_assignments' then
    select schedule.* into target_schedule
    from public.schedules schedule
    where schedule.id = target_shift.schedule_id;

    if target_schedule.status = 'draft'
      and target_schedule.previous_revision_id is not null
    then
      select exists (
        select 1
        from public.shifts previous_shift
        join public.shift_assignments previous_assignment
          on previous_assignment.shift_id = previous_shift.id
        where previous_shift.schedule_id = target_schedule.previous_revision_id
          and previous_shift.post_id is not distinct from target_shift.post_id
          and previous_shift.event_id is not distinct from target_shift.event_id
          and previous_shift.starts_at = target_shift.starts_at
          and previous_shift.ends_at = target_shift.ends_at
          and previous_shift.time_zone = target_shift.time_zone
          and previous_shift.headcount_required = target_shift.headcount_required
          and previous_shift.requires_armed = target_shift.requires_armed
          and previous_assignment.employee_id = new.employee_id
          and previous_assignment.status::text = new.status::text
          and previous_assignment.status::text in ('assigned', 'confirmed', 'completed')
      ) into inherited_assignment;

      if inherited_assignment then
        return new;
      end if;
    end if;
  end if;

  raise exception 'The employee does not hold a valid armed qualification for this shift.';
end
$$;

create or replace function public.get_weekly_schedule_payload(target_week_starts_on date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private
as $$
declare
  viewer_employee_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  can_view_all_schedule boolean := public.has_effective_permission('schedule.view')
    or viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
  target_schedule public.schedules%rowtype;
  payload jsonb;
begin
  if viewer_employee_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view the schedule.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
    and (
      schedule.status = 'published'
      or (schedule.status = 'draft' and can_view_all_schedule)
    )
  order by
    case schedule.status when 'draft' then 0 else 1 end,
    schedule.revision desc
  limit 1;

  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'id', target_schedule.id,
    'week_starts_on', target_schedule.week_starts_on,
    'revision', target_schedule.revision,
    'status', target_schedule.status,
    'published_at', target_schedule.published_at,
    'shifts', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', shift.id,
        'starts_at', shift.starts_at,
        'ends_at', shift.ends_at,
        'time_zone', shift.time_zone,
        'headcount_required', shift.headcount_required,
        'requires_armed', shift.requires_armed,
        'is_open', shift.is_open,
        'is_overtime', shift.is_overtime,
        'notes', shift.notes,
        'post', case when post.id is null then null else jsonb_build_object(
          'id', post.id,
          'name', post.name,
          'site', jsonb_build_object('id', site.id, 'code', site.code, 'name', site.name)
        ) end,
        'event', case when event.id is null then null else jsonb_build_object(
          'id', event.id,
          'name', event.name,
          'location_name', event.location_name,
          'site', case when event_site.id is null then null else jsonb_build_object(
            'id', event_site.id,
            'code', event_site.code,
            'name', event_site.name
          ) end
        ) end,
        'assignments', (
          select coalesce(jsonb_agg(
            jsonb_build_object(
              'id', assignment.id,
              'status', assignment.status,
              'employee', jsonb_build_object(
                'id', employee.id,
                'first_name', employee.first_name,
                'last_name', employee.last_name,
                'preferred_name', employee.preferred_name
              ),
              'overrides', coalesce(assignment_overrides.records, '[]'::jsonb)
            )
            order by employee.last_name, employee.first_name, assignment.id
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
          left join lateral (
            select jsonb_agg(jsonb_build_object(
              'kind', override_record.override_kind,
              'note', override_record.note,
              'createdAt', to_char(override_record.created_at at time zone 'America/Denver', 'MM/DD/YYYY HH12:MI AM')
            ) order by override_record.created_at desc) as records
            from public.schedule_assignment_overrides override_record
            where override_record.shift_id = assignment.shift_id
              and override_record.employee_id = assignment.employee_id
          ) assignment_overrides on true
          where assignment.shift_id = shift.id
            and assignment.status <> 'canceled'
        )
      )
      order by shift.starts_at, shift.created_at, shift.id
    ) filter (where shift.id is not null), '[]'::jsonb)
  )
  into payload
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.schedule_id = target_schedule.id
    and shift.canceled_at is null
    and (
      can_view_all_schedule
      or not shift.requires_armed
      or public.has_valid_credential(
        viewer_employee_id,
        'armed_guard',
        (shift.starts_at at time zone shift.time_zone)::date
      )
    );

  return payload;
end;
$$;

create or replace function public.update_schedule_draft_shift(
  target_shift_id uuid,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_open boolean,
  target_is_overtime boolean,
  target_notes text,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  updated_start timestamptz;
  updated_end timestamptz;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  availability_conflict_id uuid;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
  for update;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  updated_start := (shift_operational_date + shift_start_time) at time zone target_shift.time_zone;
  updated_end := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone target_shift.time_zone;

  if target_employee_id is null
    or not target_shift.requires_armed
    or public.has_valid_credential(target_employee_id, 'armed_guard', shift_operational_date)
  then
    return public.update_schedule_draft_shift(
      target_shift_id,
      shift_operational_date,
      shift_start_time,
      shift_end_time,
      target_headcount,
      target_is_open,
      target_is_overtime,
      target_notes,
      target_employee_id,
      target_availability_override_note
    );
  end if;

  if actor_id is null or not private.can_override_schedule_warnings() then
    raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
  end if;

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Start a schedule draft before editing this shift.';
  end if;

  if clean_credential_override_note is null then
    raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
  end if;

  if char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  availability_conflict_id := private.assignment_availability_conflict(target_employee_id, updated_start, updated_end, target_shift.time_zone);
  if availability_conflict_id is not null and clean_availability_override_note is null then
    raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
  end if;

  perform public.update_schedule_draft_shift(
    target_shift_id,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_open,
    target_is_overtime,
    target_notes,
    null,
    null
  );

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by
  ) values (
    target_shift_id,
    target_employee_id,
    'armed_credential',
    clean_credential_override_note,
    actor_id
  );

  if availability_conflict_id is not null then
    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      target_shift_id,
      target_employee_id,
      'availability',
      clean_availability_override_note,
      actor_id
    );
  end if;

  insert into public.shift_assignments (
    shift_id,
    employee_id,
    status,
    assigned_by
  ) values (
    target_shift_id,
    target_employee_id,
    'assigned',
    actor_id
  );

  update public.shifts
  set
    is_open = coalesce(target_is_open, target_headcount > 1),
    updated_at = clock_timestamp()
  where id = target_shift_id;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

create or replace function public.create_supervisor_open_shift(
  target_week_starts_on date,
  target_post_id uuid,
  event_name text,
  event_location_name text,
  event_site_id uuid,
  event_time_zone text,
  event_requires_armed boolean,
  shift_operational_date date,
  shift_start_time time,
  shift_end_time time,
  target_headcount integer,
  target_is_overtime boolean,
  target_notes text,
  publish_announcement boolean default true,
  target_employee_id uuid default null,
  target_availability_override_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  shift_time_zone text;
  shift_requires_armed boolean := coalesce(event_requires_armed, false);
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  clean_availability_override_note text := nullif(btrim(coalesce(target_availability_override_note, '')), '');
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  availability_conflict_id uuid;
  created_result jsonb;
  new_shift_id uuid;
  new_assignment_id uuid;
begin
  if target_post_id is not null then
    select site.time_zone, post.requires_armed
      into shift_time_zone, shift_requires_armed
    from public.posts post
    join public.sites site on site.id = post.site_id
    where post.id = target_post_id;
  else
    shift_time_zone := coalesce(nullif(btrim(event_time_zone), ''), 'America/Denver');
  end if;

  shift_starts_at := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  shift_ends_at := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

  if target_employee_id is null
    or not shift_requires_armed
    or public.has_valid_credential(target_employee_id, 'armed_guard', (shift_starts_at at time zone shift_time_zone)::date)
  then
    return public.create_supervisor_open_shift(
      target_week_starts_on,
      target_post_id,
      event_name,
      event_location_name,
      event_site_id,
      event_time_zone,
      event_requires_armed,
      shift_operational_date,
      shift_start_time,
      shift_end_time,
      target_headcount,
      target_is_overtime,
      target_notes,
      publish_announcement,
      target_employee_id,
      target_availability_override_note
    );
  end if;

  if actor_id is null or not private.can_override_schedule_warnings() then
    raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
  end if;

  if clean_credential_override_note is null then
    raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
  end if;

  if char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  availability_conflict_id := private.assignment_availability_conflict(target_employee_id, shift_starts_at, shift_ends_at, shift_time_zone);
  if availability_conflict_id is not null and clean_availability_override_note is null then
    raise check_violation using message = 'This employee is marked unavailable for this shift. Add an availability override note to continue.';
  end if;

  created_result := public.create_supervisor_open_shift(
    target_week_starts_on,
    target_post_id,
    event_name,
    event_location_name,
    event_site_id,
    event_time_zone,
    event_requires_armed,
    shift_operational_date,
    shift_start_time,
    shift_end_time,
    target_headcount,
    target_is_overtime,
    target_notes,
    false,
    null,
    null
  );

  new_shift_id := (created_result ->> 'shift_id')::uuid;

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by
  ) values (
    new_shift_id,
    target_employee_id,
    'armed_credential',
    clean_credential_override_note,
    actor_id
  );

  if availability_conflict_id is not null then
    insert into public.schedule_assignment_overrides (
      shift_id,
      employee_id,
      override_kind,
      note,
      created_by
    ) values (
      new_shift_id,
      target_employee_id,
      'availability',
      clean_availability_override_note,
      actor_id
    );
  end if;

  insert into public.shift_assignments (
    shift_id,
    employee_id,
    status,
    assigned_by
  ) values (
    new_shift_id,
    target_employee_id,
    'assigned',
    actor_id
  )
  returning id into new_assignment_id;

  update public.shifts
  set
    is_open = target_headcount > 1,
    updated_at = clock_timestamp()
  where id = new_shift_id;

  return created_result || jsonb_build_object(
    'assignment_id', new_assignment_id,
    'announcement_id', null
  );
end
$$;

create or replace function public.resolve_schedule_review_shift(
  target_shift_id uuid,
  target_employee_id uuid,
  resolution_note text default null,
  target_credential_override_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  target_shift public.shifts%rowtype;
  shift_date date;
  clean_credential_override_note text := nullif(btrim(coalesce(target_credential_override_note, '')), '');
  resolved_result jsonb;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id;

  if not found then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  shift_date := (target_shift.starts_at at time zone target_shift.time_zone)::date;

  if not target_shift.requires_armed
    or public.has_valid_credential(target_employee_id, 'armed_guard', shift_date)
  then
    return public.resolve_schedule_review_shift(target_shift_id, target_employee_id, resolution_note);
  end if;

  if actor_id is null or not private.can_override_schedule_warnings() then
    raise insufficient_privilege using message = 'MFA-verified schedule override access is required to use an armed credential override.';
  end if;

  if clean_credential_override_note is null then
    raise check_violation using message = 'Add an armed credential override reason to assign this employee.';
  end if;

  if char_length(clean_credential_override_note) > 2000 then
    raise check_violation using message = 'Armed credential override notes must be 2,000 characters or fewer.';
  end if;

  perform set_config('app.allow_armed_credential_override', 'on', true);
  resolved_result := public.resolve_schedule_review_shift(target_shift_id, target_employee_id, resolution_note);

  insert into public.schedule_assignment_overrides (
    shift_id,
    employee_id,
    override_kind,
    note,
    created_by
  ) values (
    (resolved_result ->> 'shift_id')::uuid,
    target_employee_id,
    'armed_credential',
    clean_credential_override_note,
    actor_id
  );

  return resolved_result;
end
$$;

revoke all on function private.can_override_schedule_warnings() from public, anon, authenticated;
revoke all on function public.admin_separate_employee(uuid, text, date) from public, anon;
revoke all on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) from public, anon;
revoke all on function private.enforce_shift_qualification() from public, anon, authenticated;
revoke all on function public.get_weekly_schedule_payload(date) from public, anon;
revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) from public, anon;
revoke all on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) from public, anon;
revoke all on function public.resolve_schedule_review_shift(uuid, uuid, text, text) from public, anon;

grant execute on function public.admin_separate_employee(uuid, text, date) to authenticated;
grant execute on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text, text) to authenticated;
grant execute on function public.get_weekly_schedule_payload(date) to authenticated;
grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid, text, text) to authenticated;
grant execute on function public.create_supervisor_open_shift(date, uuid, text, text, uuid, text, boolean, date, time, time, integer, boolean, text, boolean, uuid, text, text) to authenticated;
grant execute on function public.resolve_schedule_review_shift(uuid, uuid, text, text) to authenticated;

commit;
