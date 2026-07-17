set search_path = '';

create table if not exists public.employee_availability (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  day_of_week integer,
  start_time time,
  end_time time,
  availability_status text not null default 'unavailable',
  approval_status public.request_status not null default 'pending',
  note text,
  decision_note text,
  submitted_by uuid references public.employees(id) on delete set null,
  decided_by uuid references public.employees(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employee_availability_date_order check (ends_on >= starts_on),
  constraint employee_availability_day_valid check (day_of_week is null or day_of_week between 0 and 6),
  constraint employee_availability_status_valid check (availability_status in ('available', 'unavailable')),
  constraint employee_availability_note_length check (char_length(coalesce(note, '')) <= 2000),
  constraint employee_availability_decision_note_length check (char_length(coalesce(decision_note, '')) <= 2000)
);

create index if not exists employee_availability_employee_date_idx
  on public.employee_availability(employee_id, starts_on, ends_on);

create index if not exists employee_availability_status_idx
  on public.employee_availability(approval_status, starts_on);

create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin'), false)
$$;

alter table public.employee_availability enable row level security;

drop policy if exists employee_availability_read on public.employee_availability;
create policy employee_availability_read on public.employee_availability
for select to authenticated
using (
  employee_id = public.current_employee_id()
  or public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin')
);

drop policy if exists employee_availability_insert_own on public.employee_availability;
create policy employee_availability_insert_own on public.employee_availability
for insert to authenticated
with check (employee_id = public.current_employee_id());

drop policy if exists employee_availability_ops_write on public.employee_availability;
create policy employee_availability_ops_write on public.employee_availability
for all to authenticated
using (public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin'))
with check (public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin'));

drop trigger if exists set_employee_availability_updated_at on public.employee_availability;
create trigger set_employee_availability_updated_at
before update on public.employee_availability
for each row execute function private.set_updated_at();

drop trigger if exists employee_availability_audit on public.employee_availability;
create trigger employee_availability_audit
after insert or update or delete on public.employee_availability
for each row execute function private.write_audit_event();

create or replace function public.get_sites_payload()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', site.id,
    'code', site.code,
    'name', site.name,
    'address_line_1', site.address_line_1,
    'city', site.city,
    'region', site.region,
    'postal_code', site.postal_code,
    'time_zone', site.time_zone,
    'active', site.active,
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', post.id,
        'name', post.name,
        'requires_armed', post.requires_armed,
        'active', post.active,
        'default_start_time', post.default_start_time,
        'default_end_time', post.default_end_time
      ) order by post.name)
      from public.posts post
      where post.site_id = site.id
    ), '[]'::jsonb)
  ) order by site.active desc, site.name), '[]'::jsonb)
  from public.sites site
  where public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin');
$$;

create or replace function public.get_overview_metrics_payload()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  active_clock_count integer;
  open_shift_count integer;
  pending_request_count integer;
  clock_exception_count integer;
begin
  if private.current_employee_id() is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view dashboard metrics.';
  end if;

  with latest_event as (
    select distinct on (event.employee_id)
      event.employee_id,
      event.kind,
      event.effective_at
    from public.time_events event
    where event.voided_at is null
      and event.effective_at >= clock_timestamp() - interval '18 hours'
    order by event.employee_id, event.effective_at desc, event.created_at desc
  )
  select count(*) into active_clock_count
  from latest_event event
  where event.kind in ('clock_in', 'break_start', 'break_end');

  select count(*) into open_shift_count
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  where schedule.status = 'published'
    and shift.is_open
    and shift.ends_at > clock_timestamp();

  select
    (
      select count(*) from public.time_off_requests request where request.status = 'pending'
    )
    + (
      select count(*) from public.shift_requests request
      join public.shifts shift on shift.id = request.shift_id
      where request.status = 'pending'
        and shift.ends_at > clock_timestamp()
    )
    + (
      select count(*) from public.call_off_reports report
      join public.shifts shift on shift.id = report.shift_id
      where report.announcement_id is null
        and report.resolved_at is null
        and shift.ends_at > clock_timestamp()
    )
  into pending_request_count;

  select count(*) into clock_exception_count
  from public.time_event_corrections correction
  where correction.approved_at is null
    and correction.declined_at is null;

  return jsonb_build_object(
    'onDutyNow', active_clock_count,
    'openShifts', open_shift_count,
    'pendingRequests', pending_request_count,
    'clockExceptions', clock_exception_count
  );
end
$$;

create or replace function public.get_availability_workspace(
  target_from_date date default current_date,
  target_through_date date default current_date + 42
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := private.current_employee_id();
  viewer_role public.app_role := public.current_app_role();
  privileged boolean := viewer_role in ('dispatcher', 'scheduler', 'supervisor', 'admin');
begin
  if viewer_id is null or viewer_role is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view availability.';
  end if;

  return jsonb_build_object(
    'role', viewer_role,
    'hasMfa', public.has_mfa(),
    'employees', case when privileged then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', employee.id,
        'name', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
        'role', employee.role,
        'employmentType', employee.employment_type,
        'hasArmedCredential', public.has_valid_credential(employee.id, 'armed_guard', target_from_date)
      ) order by employee.last_name, employee.first_name), '[]'::jsonb)
      from public.employees employee
      where employee.status = 'active'
        and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
    ) else '[]'::jsonb end,
    'availability', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', availability.id,
        'employeeId', availability.employee_id,
        'employeeName', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
        'startsOn', availability.starts_on,
        'endsOn', availability.ends_on,
        'dayOfWeek', availability.day_of_week,
        'startTime', availability.start_time,
        'endTime', availability.end_time,
        'availabilityStatus', availability.availability_status,
        'approvalStatus', availability.approval_status,
        'note', availability.note,
        'decisionNote', availability.decision_note,
        'createdAt', availability.created_at
      ) order by availability.starts_on, employee.last_name, employee.first_name), '[]'::jsonb)
      from public.employee_availability availability
      join public.employees employee on employee.id = availability.employee_id
      where availability.ends_on >= target_from_date
        and availability.starts_on <= target_through_date
        and (privileged or availability.employee_id = viewer_id)
    )
  );
end
$$;

create or replace function public.submit_availability_request(
  target_employee_id uuid,
  target_starts_on date,
  target_ends_on date,
  target_day_of_week integer default null,
  target_start_time time default null,
  target_end_time time default null,
  target_availability_status text default 'unavailable',
  target_note text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role := public.current_app_role();
  availability_id uuid;
  direct_approved boolean := actor_role in ('dispatcher', 'scheduler', 'supervisor', 'admin') and public.has_mfa();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to submit availability.';
  end if;

  if target_employee_id is null then
    target_employee_id := actor_id;
  end if;

  if target_employee_id <> actor_id and not direct_approved then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to enter availability for another employee.';
  end if;

  if target_ends_on < target_starts_on then
    raise check_violation using message = 'Availability end date cannot be before the start date.';
  end if;

  if target_ends_on < current_date then
    raise check_violation using message = 'Availability cannot be submitted for dates that already passed.';
  end if;

  if target_availability_status not in ('available', 'unavailable') then
    raise check_violation using message = 'Availability status must be available or unavailable.';
  end if;

  if target_day_of_week is not null and (target_day_of_week < 0 or target_day_of_week > 6) then
    raise check_violation using message = 'Day of week must be Sunday through Saturday.';
  end if;

  if char_length(coalesce(target_note, '')) > 2000 then
    raise check_violation using message = 'Availability note exceeds 2,000 characters.';
  end if;

  insert into public.employee_availability (
    employee_id,
    starts_on,
    ends_on,
    day_of_week,
    start_time,
    end_time,
    availability_status,
    approval_status,
    note,
    submitted_by,
    decided_by,
    decided_at
  ) values (
    target_employee_id,
    target_starts_on,
    target_ends_on,
    target_day_of_week,
    target_start_time,
    target_end_time,
    target_availability_status,
    case when direct_approved then 'approved'::public.request_status else 'pending'::public.request_status end,
    nullif(btrim(coalesce(target_note, '')), ''),
    actor_id,
    case when direct_approved then actor_id else null end,
    case when direct_approved then clock_timestamp() else null end
  )
  returning id into availability_id;

  return availability_id;
end
$$;

create or replace function public.decide_availability_request(
  target_availability_id uuid,
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
  reviewer_id uuid := private.current_employee_id();
begin
  if reviewer_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to decide availability.';
  end if;

  if target_decision not in ('approved', 'declined') then
    raise check_violation using message = 'Availability can only be approved or declined.';
  end if;

  if target_decision = 'declined' and btrim(coalesce(target_note, '')) = '' then
    raise check_violation using message = 'A decline note is required.';
  end if;

  update public.employee_availability
  set
    approval_status = target_decision,
    decision_note = nullif(btrim(coalesce(target_note, '')), ''),
    decided_by = reviewer_id,
    decided_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = target_availability_id
    and approval_status = 'pending';

  if not found then
    raise check_violation using message = 'The availability request is no longer pending.';
  end if;

  return true;
end
$$;

create or replace function public.get_schedule_builder_options()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'posts',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', post.id,
            'name', post.name,
            'requires_armed', post.requires_armed,
            'site', jsonb_build_object(
              'id', site.id,
              'code', site.code,
              'name', site.name,
              'time_zone', site.time_zone
            )
          )
          order by site.name, post.name
        )
        from public.posts post
        join public.sites site on site.id = post.site_id
        where post.active
          and site.active
      ),
      '[]'::jsonb
    ),
    'employees',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', employee.id,
            'first_name', employee.first_name,
            'last_name', employee.last_name,
            'preferred_name', employee.preferred_name,
            'role', employee.role,
            'employment_type', employee.employment_type,
            'has_armed_guard_credential', public.has_valid_credential(employee.id, 'armed_guard', current_date)
          )
          order by employee.last_name, employee.first_name, employee.id
        )
        from public.employees employee
        where employee.status = 'active'
          and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
      ),
      '[]'::jsonb
    )
  )
  where public.is_supervisor_or_admin()
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
  target_employee_id uuid default null
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
  shift_time_zone text;
  updated_start timestamptz;
  updated_end timestamptz;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to edit schedule drafts.';
  end if;

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

  if target_schedule.status <> 'draft' then
    raise check_violation using message = 'Start a schedule draft before editing this shift.';
  end if;

  if target_headcount is null or target_headcount < 1 or target_headcount > 50 then
    raise check_violation using message = 'Headcount must be between 1 and 50.';
  end if;

  shift_time_zone := target_shift.time_zone;
  updated_start := (shift_operational_date + shift_start_time) at time zone shift_time_zone;
  updated_end := ((shift_operational_date + case when shift_end_time <= shift_start_time then 1 else 0 end) + shift_end_time) at time zone shift_time_zone;

  if target_employee_id is not null and not exists (
    select 1
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
      and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
  ) then
    raise check_violation using message = 'The selected employee is not active.';
  end if;

  if target_employee_id is not null and target_shift.requires_armed and not public.has_valid_credential(
    target_employee_id,
    'armed_guard',
    shift_operational_date
  ) then
    raise check_violation using message = 'The selected employee does not have the armed credential required for this shift.';
  end if;

  delete from public.shift_assignments
  where shift_id = target_shift_id
    and status in ('assigned', 'confirmed', 'completed');

  update public.shifts
  set
    starts_at = updated_start,
    ends_at = updated_end,
    headcount_required = target_headcount,
    is_open = coalesce(target_is_open, target_employee_id is null),
    is_overtime = coalesce(target_is_overtime, false),
    notes = nullif(btrim(coalesce(target_notes, '')), ''),
    updated_at = clock_timestamp()
  where id = target_shift_id;

  if target_employee_id is not null then
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
  end if;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

create or replace function public.get_schedule_staffing_suggestions(target_schedule_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with selected_shift as (
    select
      shift.id,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.headcount_required,
      (shift.starts_at at time zone shift.time_zone)::date as local_date,
      extract(dow from shift.starts_at at time zone shift.time_zone)::integer as local_dow,
      (shift.starts_at at time zone shift.time_zone)::time as local_start,
      (shift.ends_at at time zone shift.time_zone)::time as local_end,
      greatest(shift.headcount_required - count(assignment.id) filter (where assignment.status in ('assigned', 'confirmed', 'completed')), 0) open_slots
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.shift_assignments assignment on assignment.shift_id = shift.id
    where shift.schedule_id = target_schedule_id
      and schedule.status = 'draft'
      and shift.ends_at > clock_timestamp()
    group by shift.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'shiftId', selected_shift.id,
    'openSlots', selected_shift.open_slots,
    'suggestions', coalesce((
      select jsonb_agg(candidate.payload order by candidate.score desc, candidate.name)
      from (
        select
          jsonb_build_object(
            'employeeId', employee.id,
            'name', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
            'role', employee.role,
            'employmentType', employee.employment_type,
            'hasArmedCredential', public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date),
            'reason', concat_ws(
              ' · ',
              case when public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date) then 'armed-qualified' else 'unarmed' end,
              case when exists (
                select 1
                from public.employee_availability availability
                where availability.employee_id = employee.id
                  and availability.approval_status = 'approved'
                  and availability.availability_status = 'available'
                  and availability.starts_on <= selected_shift.local_date
                  and availability.ends_on >= selected_shift.local_date
                  and (availability.day_of_week is null or availability.day_of_week = selected_shift.local_dow)
              ) then 'available on file' end,
              case when employee.employment_type = 'salary' then 'salary employee' else 'hourly employee' end,
              nullif(profile.schedule_availability, '')
            )
          ) payload,
          btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name) name,
          (
            case when selected_shift.requires_armed and public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date) then 50 else 0 end
            + case when not selected_shift.requires_armed then 20 else 0 end
            + case when exists (
                select 1
                from public.employee_availability availability
                where availability.employee_id = employee.id
                  and availability.approval_status = 'approved'
                  and availability.availability_status = 'available'
                  and availability.starts_on <= selected_shift.local_date
                  and availability.ends_on >= selected_shift.local_date
                  and (availability.day_of_week is null or availability.day_of_week = selected_shift.local_dow)
              ) then 35 else 0 end
            + case when lower(coalesce(profile.schedule_availability, '')) like '%' || lower(to_char(selected_shift.starts_at at time zone selected_shift.time_zone, 'Dy')) || '%' then 15 else 0 end
            + case when employee.employment_type = 'hourly' then 5 else 0 end
          ) score
        from public.employees employee
        left join private.employee_operational_profiles profile on profile.employee_id = employee.id
        where employee.status = 'active'
          and employee.role in ('guard', 'dispatcher', 'scheduler', 'supervisor', 'admin')
          and (not selected_shift.requires_armed or public.has_valid_credential(employee.id, 'armed_guard', selected_shift.local_date))
          and not exists (
            select 1
            from public.employee_availability unavailable
            where unavailable.employee_id = employee.id
              and unavailable.approval_status = 'approved'
              and unavailable.availability_status = 'unavailable'
              and unavailable.starts_on <= selected_shift.local_date
              and unavailable.ends_on >= selected_shift.local_date
              and (unavailable.day_of_week is null or unavailable.day_of_week = selected_shift.local_dow)
              and (
                unavailable.start_time is null
                or unavailable.end_time is null
                or tstzrange(
                  (selected_shift.local_date + unavailable.start_time) at time zone selected_shift.time_zone,
                  (selected_shift.local_date + unavailable.end_time) at time zone selected_shift.time_zone,
                  '[)'
                ) && tstzrange(selected_shift.starts_at, selected_shift.ends_at, '[)')
              )
          )
          and not exists (
            select 1
            from public.shift_assignments assignment
            join public.shifts existing_shift on existing_shift.id = assignment.shift_id
            where assignment.employee_id = employee.id
              and assignment.status in ('assigned', 'confirmed', 'completed')
              and existing_shift.id <> selected_shift.id
              and existing_shift.starts_at < selected_shift.ends_at
              and existing_shift.ends_at > selected_shift.starts_at
          )
        order by score desc, employee.last_name, employee.first_name
        limit 5
      ) candidate
    ), '[]'::jsonb)
  ) order by selected_shift.starts_at), '[]'::jsonb)
  from selected_shift
  where selected_shift.open_slots > 0;
$$;

update public.announcement_templates
set is_active = false
where template_key = 'welcome_to_sygshift';

create or replace function public.get_announcement_composer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Only dispatchers, schedulers, supervisors, and admins can compose announcements.';
  end if;

  return jsonb_build_object(
    'role', public.current_app_role(),
    'hasMfa', public.has_mfa(),
    'templates', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'key', template.template_key,
        'name', template.name,
        'description', template.description,
        'kind', template.kind,
        'requiredFields', template.required_fields,
        'recipientRoles', template.recipient_roles,
        'displayOrder', template.display_order
      ) order by template.display_order, template.name), '[]'::jsonb)
      from public.announcement_templates template
      where template.is_active
        and template.template_key <> 'welcome_to_sygshift'
    ),
    'recentAnnouncements', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', announcement.id,
        'templateKey', announcement.template_key,
        'title', announcement.title,
        'kind', announcement.kind,
        'publishedAt', announcement.published_at,
        'expiresAt', announcement.expires_at,
        'recipientRoles', announcement.recipient_roles,
        'requiresArmed', announcement.requires_armed,
        'createdBy', coalesce(author.preferred_name, author.first_name) || ' ' || author.last_name
      ) order by announcement.created_at desc), '[]'::jsonb)
      from (
        select *
        from public.announcements
        where coalesce(template_key, '') <> 'welcome_to_sygshift'
        order by created_at desc
        limit 12
      ) announcement
      join public.employees author on author.id = announcement.created_by
    )
  );
end
$$;

create or replace function public.publish_templated_announcement(
  target_template_key text,
  target_fields jsonb,
  target_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  publisher_id uuid := public.current_employee_id();
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
  recipient_count integer;
  announcement_id uuid;
begin
  if not (public.is_supervisor_or_admin() and public.has_mfa()) then
    raise insufficient_privilege using message = 'Operations MFA is required to publish announcements.';
  end if;

  select * into template
  from public.announcement_templates
  where template_key = target_template_key
    and is_active
    and template_key <> 'welcome_to_sygshift';

  if not found then
    raise check_violation using message = 'Choose an approved announcement template.';
  end if;

  perform private.validate_template_fields(template, clean_fields);

  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);
  recipient_count := private.count_announcement_recipients(template.recipient_roles, armed_required);

  if recipient_count <= 0 then
    raise check_violation using message = 'No eligible email recipients match this announcement.';
  end if;

  insert into public.announcements (
    kind,
    title,
    body,
    published_at,
    expires_at,
    created_by,
    template_key,
    template_fields,
    recipient_roles,
    requires_armed
  ) values (
    template.kind,
    subject,
    body,
    clock_timestamp(),
    target_expires_at,
    publisher_id,
    template.template_key,
    clean_fields,
    template.recipient_roles,
    armed_required
  )
  returning id into announcement_id;

  return jsonb_build_object(
    'id', announcement_id,
    'templateKey', template.template_key,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', recipient_count
  );
end
$$;

revoke all on function public.get_sites_payload() from public, anon;
revoke all on function public.get_overview_metrics_payload() from public, anon;
revoke all on function public.get_availability_workspace(date, date) from public, anon;
revoke all on function public.submit_availability_request(uuid, date, date, integer, time, time, text, text) from public, anon;
revoke all on function public.decide_availability_request(uuid, public.request_status, text) from public, anon;

grant execute on function public.get_sites_payload() to authenticated;
grant execute on function public.get_overview_metrics_payload() to authenticated;
grant execute on function public.get_availability_workspace(date, date) to authenticated;
grant execute on function public.submit_availability_request(uuid, date, date, integer, time, time, text, text) to authenticated;
grant execute on function public.decide_availability_request(uuid, public.request_status, text) to authenticated;
