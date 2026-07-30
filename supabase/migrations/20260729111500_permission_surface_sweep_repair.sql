begin;

create or replace function private.require_credential_editor_mfa()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role := public.current_app_role();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to update credentials.';
  end if;

  if not (
    actor_role in ('scheduler', 'supervisor', 'admin', 'recruiting_licensing')
    or public.has_effective_permission('directory.edit_credentials')
    or public.has_effective_permission('licensing.manage')
  ) then
    raise insufficient_privilege using message = 'Credential editor permission with MFA is required.';
  end if;

  return actor_id;
end
$$;

create or replace function public.get_employee_directory()
returns table (
  id uuid,
  employee_number text,
  job_title text,
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
  if not public.has_mfa() then
    raise insufficient_privilege
      using message = 'MFA is required to view the employee directory.';
  end if;

  if not (
    public.current_app_role() in ('dispatcher', 'scheduler', 'supervisor', 'admin', 'recruiting_licensing')
    or public.has_effective_permission('directory.view')
    or public.has_effective_permission('directory.edit_basic')
    or public.has_effective_permission('directory.edit_credentials')
  ) then
    raise insufficient_privilege
      using message = 'Directory permission is required.';
  end if;

  return query
  select
    employee.id,
    employee.employee_number,
    employee.job_title,
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
  where employee.status in ('active', 'leave')
  order by employee.last_name, employee.first_name, employee.id;
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
          and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
      ),
      '[]'::jsonb
    )
  )
  where private.can_manage_schedule_drafts()
    or public.has_effective_permission('scheduler.view')
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
      and (
        private.can_manage_schedule_drafts()
        or public.has_effective_permission('scheduler.view')
      )
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
              ' - ',
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
              case
                when employee.employment_type::text = 'salary' then 'salary employee'
                when employee.employment_type::text = 'flex' then 'flex employee'
                else 'hourly employee'
              end,
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
            + case
                when employee.employment_type::text = 'flex' then 12
                when employee.employment_type::text = 'hourly' then 5
                else 0
              end
          ) score
        from public.employees employee
        left join private.employee_operational_profiles profile on profile.employee_id = employee.id
        where employee.status = 'active'
          and employee.role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')
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
                or selected_shift.local_end <= selected_shift.local_start
                or (unavailable.start_time < selected_shift.local_end and unavailable.end_time > selected_shift.local_start)
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

revoke all on function private.require_credential_editor_mfa() from public, anon, authenticated;
revoke all on function public.get_employee_directory() from public, anon;
revoke all on function public.get_schedule_builder_options() from public, anon;
revoke all on function public.get_schedule_staffing_suggestions(uuid) from public, anon;

grant execute on function public.get_employee_directory() to authenticated;
grant execute on function public.get_schedule_builder_options() to authenticated;
grant execute on function public.get_schedule_staffing_suggestions(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
