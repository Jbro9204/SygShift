create or replace function public.is_supervisor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_app_role() in ('dispatcher', 'supervisor', 'admin'), false)
$$;

create or replace function private.generated_site_code(site_name text, existing_site_id uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  words text[];
  token text;
  base text := '';
  candidate text;
  suffix integer := 2;
begin
  words := array(
    select word
    from regexp_split_to_table(upper(coalesce(site_name, '')), '[^A-Z0-9]+') word
    where word <> ''
      and word not in ('THE', 'AND', 'OF', 'AT', 'A', 'AN', 'TO', 'FOR', 'WITH', 'ARMED', 'UNARMED', 'SECURITY', 'GUARD', 'GUARDS', 'SITE', 'POST')
  );

  if array_length(words, 1) is null then
    base := 'SITE';
  elsif array_length(words, 1) = 1 then
    base := left(words[1], 6);
  else
    foreach token in array words loop
      base := base || left(token, 1);
      exit when length(base) >= 5;
    end loop;
    if length(base) < 3 then
      base := left(words[1], 6);
    end if;
  end if;

  base := left(regexp_replace(base, '[^A-Z0-9]', '', 'g'), 6);
  if base = '' then
    base := 'SITE';
  end if;

  candidate := base;
  while exists (
    select 1
    from public.sites site
    where upper(site.code) = candidate
      and (existing_site_id is null or site.id <> existing_site_id)
  ) loop
    candidate := base || '-' || suffix::text;
    suffix := suffix + 1;
  end loop;

  return candidate;
end
$$;

create or replace function private.assign_site_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := private.generated_site_code(new.name, new.id);
  else
    new.code := upper(regexp_replace(btrim(new.code), '[^A-Za-z0-9-]+', '-', 'g'));
  end if;
  return new;
end
$$;

drop trigger if exists sites_assign_code on public.sites;
create trigger sites_assign_code
before insert or update of name, code on public.sites
for each row execute function private.assign_site_code();

do $$
declare
  site_record record;
begin
  for site_record in
    select id, name
    from public.sites
    where code is null or btrim(code) = ''
    order by name, id
  loop
    update public.sites
    set code = private.generated_site_code(site_record.name, site_record.id)
    where id = site_record.id;
  end loop;
end
$$;

update public.employees
set
  role = 'dispatcher'::public.app_role,
  preferred_name = coalesce(nullif(preferred_name, ''), 'Lori')
where lower(first_name) = 'lorinda'
  and lower(last_name) = 'hood';

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
      or viewer_role in ('dispatcher', 'supervisor', 'admin')
    )
  order by schedule.revision desc
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
          'site', jsonb_build_object(
            'id', site.id,
            'code', site.code,
            'name', site.name
          )
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
              )
            )
            order by employee.last_name, employee.first_name, assignment.id
          ), '[]'::jsonb)
          from public.shift_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
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
    and (
      viewer_role in ('dispatcher', 'supervisor', 'admin')
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
          and employee.role in ('guard', 'dispatcher', 'supervisor', 'admin')
      ),
      '[]'::jsonb
    )
  )
  where public.is_supervisor_or_admin()
$$;

create or replace function public.ensure_schedule_draft(target_week_starts_on date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  latest_schedule public.schedules%rowtype;
  new_schedule_id uuid;
  copied_shift public.shifts%rowtype;
  copied_shift_id uuid;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to work on schedule drafts.';
  end if;

  select schedule.* into latest_schedule
  from public.schedules schedule
  where schedule.week_starts_on = target_week_starts_on
  order by schedule.revision desc
  limit 1;

  if found and latest_schedule.status = 'draft' then
    return public.get_weekly_schedule_payload(target_week_starts_on);
  end if;

  insert into public.schedules (
    week_starts_on,
    revision,
    status,
    previous_revision_id,
    created_by
  ) values (
    target_week_starts_on,
    coalesce(latest_schedule.revision, 0) + 1,
    'draft',
    latest_schedule.id,
    actor_id
  )
  returning id into new_schedule_id;

  if latest_schedule.id is not null then
    for copied_shift in
      select *
      from public.shifts shift
      where shift.schedule_id = latest_schedule.id
      order by shift.starts_at, shift.created_at, shift.id
    loop
      insert into public.shifts (
        schedule_id,
        post_id,
        event_id,
        starts_at,
        ends_at,
        headcount_required,
        is_open,
        is_overtime,
        notes,
        created_by
      ) values (
        new_schedule_id,
        copied_shift.post_id,
        copied_shift.event_id,
        copied_shift.starts_at,
        copied_shift.ends_at,
        copied_shift.headcount_required,
        copied_shift.is_open,
        copied_shift.is_overtime,
        copied_shift.notes,
        actor_id
      )
      returning id into copied_shift_id;

      insert into public.shift_assignments (
        shift_id,
        employee_id,
        status,
        assigned_by,
        assigned_at,
        confirmed_at,
        canceled_at,
        cancellation_reason
      )
      select
        copied_shift_id,
        assignment.employee_id,
        assignment.status,
        assignment.assigned_by,
        assignment.assigned_at,
        assignment.confirmed_at,
        assignment.canceled_at,
        assignment.cancellation_reason
      from public.shift_assignments assignment
      where assignment.shift_id = copied_shift.id;
    end loop;
  end if;

  return public.get_weekly_schedule_payload(target_week_starts_on);
end
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
  active_assignment_count integer;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to edit schedule drafts.';
  end if;

  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id;

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
      and employee.role in ('guard', 'dispatcher', 'supervisor', 'admin')
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
    delete from public.shift_assignments
    where shift_id = target_shift_id
      and status <> 'canceled';

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
  else
    select count(*) into active_assignment_count
    from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id
      and assignment.status in ('assigned', 'confirmed', 'completed');

    if active_assignment_count >= target_headcount and coalesce(target_is_open, false) then
      update public.shifts set is_open = false where id = target_shift_id;
    end if;
  end if;

  return public.get_weekly_schedule_payload(target_schedule.week_starts_on);
end
$$;

create or replace function public.publish_schedule_draft(target_schedule_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  draft_schedule public.schedules%rowtype;
  latest_published_id uuid;
begin
  if actor_id is null or not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA-verified operations access is required to publish schedule drafts.';
  end if;

  select schedule.* into draft_schedule
  from public.schedules schedule
  where schedule.id = target_schedule_id;

  if not found or draft_schedule.status <> 'draft' then
    raise check_violation using message = 'Only draft schedules can be published.';
  end if;

  select schedule.id into latest_published_id
  from public.schedules schedule
  where schedule.week_starts_on = draft_schedule.week_starts_on
    and schedule.status = 'published'
  order by schedule.revision desc
  limit 1;

  if latest_published_id is not null then
    update public.schedules
    set status = 'superseded'
    where id = latest_published_id;
  end if;

  update public.schedules
  set
    status = 'published',
    published_at = clock_timestamp(),
    published_by = actor_id
  where id = target_schedule_id;

  return public.get_weekly_schedule_payload(draft_schedule.week_starts_on);
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
      greatest(shift.headcount_required - count(assignment.id) filter (where assignment.status in ('assigned', 'confirmed', 'completed')), 0) open_slots
    from public.shifts shift
    join public.schedules schedule on schedule.id = shift.schedule_id
    left join public.shift_assignments assignment on assignment.shift_id = shift.id
    where shift.schedule_id = target_schedule_id
      and schedule.status = 'draft'
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
            'name', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
            'role', employee.role,
            'employmentType', employee.employment_type,
            'hasArmedCredential', public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date),
            'reason', concat_ws(
              ' · ',
              case when public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date) then 'armed-qualified' else 'unarmed' end,
              case when employee.employment_type = 'salary' then 'salary employee' else 'hourly employee' end,
              nullif(profile.schedule_availability, '')
            )
          ) payload,
          btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) name,
          (
            case when selected_shift.requires_armed and public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date) then 50 else 0 end
            + case when not selected_shift.requires_armed then 20 else 0 end
            + case when lower(coalesce(profile.schedule_availability, '')) like '%' || lower(to_char(selected_shift.starts_at at time zone selected_shift.time_zone, 'Dy')) || '%' then 15 else 0 end
            + case when employee.employment_type = 'hourly' then 5 else 0 end
          ) score
        from public.employees employee
        left join private.employee_operational_profiles profile on profile.employee_id = employee.id
        where employee.status = 'active'
          and employee.role in ('guard', 'dispatcher', 'supervisor', 'admin')
          and (not selected_shift.requires_armed or public.has_valid_credential(employee.id, 'armed_guard', (selected_shift.starts_at at time zone selected_shift.time_zone)::date))
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
  where selected_shift.open_slots > 0
    and public.is_supervisor_or_admin()
$$;

create or replace function public.get_announcement_composer()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Only dispatchers, supervisors, and admins can compose announcements.';
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
        order by created_at desc
        limit 12
      ) announcement
      join public.employees author on author.id = announcement.created_by
    )
  );
end
$$;

create or replace function public.preview_announcement_template(
  target_template_key text,
  target_fields jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  template public.announcement_templates%rowtype;
  clean_fields jsonb := coalesce(target_fields, '{}'::jsonb);
  subject text;
  body text;
  armed_required boolean;
begin
  if not public.is_supervisor_or_admin() then
    raise insufficient_privilege using message = 'Only dispatchers, supervisors, and admins can preview announcements.';
  end if;

  select * into template
  from public.announcement_templates
  where template_key = target_template_key
    and is_active;

  if not found then
    raise check_violation using message = 'Choose an approved announcement template.';
  end if;

  perform private.validate_template_fields(template, clean_fields);

  subject := private.render_announcement_template(template.subject_pattern, clean_fields);
  body := private.render_announcement_template(template.body_pattern, clean_fields);
  armed_required := private.template_requires_armed(template, clean_fields);

  return jsonb_build_object(
    'templateKey', template.template_key,
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', private.count_announcement_recipients(template.recipient_roles, armed_required)
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
    and is_active;

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
    'title', subject,
    'body', body,
    'kind', template.kind,
    'recipientRoles', template.recipient_roles,
    'requiresArmed', armed_required,
    'recipientCount', recipient_count
  );
end
$$;

create or replace function public.service_get_employee_login_email_target(
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Only the service role can read login email targets.';
  end if;

  return (
    select jsonb_build_object(
      'employeeId', employee.id,
      'username', employee.username,
      'authEmail', employee.username || '@accounts.sygshift.invalid',
      'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
      'role', employee.role,
      'employmentType', employee.employment_type,
      'status', employee.status,
      'existingAuthUserId', account.auth_user_id,
      'contactEmail', coalesce(nullif(contact.company_email, ''), nullif(contact.personal_email, ''))
    )
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    left join private.employee_contacts contact on contact.employee_id = employee.id
    where employee.id = target_employee_id
      and employee.status = 'active'
  );
end
$$;

create or replace function public.service_get_employee_login_email_targets(
  target_include_existing boolean default true
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.role()) <> 'service_role' then
      jsonb_build_array()
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', employee.id,
        'username', employee.username,
        'authEmail', employee.username || '@accounts.sygshift.invalid',
        'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
        'role', employee.role,
        'employmentType', employee.employment_type,
        'status', employee.status,
        'existingAuthUserId', account.auth_user_id,
        'contactEmail', coalesce(nullif(contact.company_email, ''), nullif(contact.personal_email, ''))
      ) order by employee.last_name, employee.first_name)
      from public.employees employee
      left join private.employee_accounts account on account.employee_id = employee.id
      left join private.employee_contacts contact on contact.employee_id = employee.id
      where employee.status = 'active'
        and (target_include_existing or account.employee_id is null)
        and coalesce(nullif(contact.company_email, ''), nullif(contact.personal_email, '')) is not null
    ), '[]'::jsonb)
  end
$$;

revoke all on function public.ensure_schedule_draft(date) from public, anon;
revoke all on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid) from public, anon;
revoke all on function public.publish_schedule_draft(uuid) from public, anon;
revoke all on function public.get_schedule_staffing_suggestions(uuid) from public, anon;
revoke all on function public.service_get_employee_login_email_target(uuid) from public, anon, authenticated;
revoke all on function public.service_get_employee_login_email_targets(boolean) from public, anon, authenticated;
grant execute on function public.ensure_schedule_draft(date) to authenticated;
grant execute on function public.update_schedule_draft_shift(uuid, date, time, time, integer, boolean, boolean, text, uuid) to authenticated;
grant execute on function public.publish_schedule_draft(uuid) to authenticated;
grant execute on function public.get_schedule_staffing_suggestions(uuid) to authenticated;
grant execute on function public.service_get_employee_login_email_target(uuid) to service_role;
grant execute on function public.service_get_employee_login_email_targets(boolean) to service_role;
