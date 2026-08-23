begin;

create or replace function private.preferred_delivery_email(
  personal_email text,
  company_email text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(candidate.email))
  from unnest(array[personal_email, company_email]) with ordinality as candidate(email, priority)
  where nullif(btrim(candidate.email), '') is not null
    and btrim(candidate.email) ~ '^[^[:space:]@]+@[^[:space:]@]+$'
    and lower(split_part(btrim(candidate.email), '@', 2)) <> 'guardianshipsecurity.net'
  order by candidate.priority
  limit 1
$$;

comment on function private.preferred_delivery_email(text, text) is
  'Returns the personal address first, then an external company address, while company-domain delivery is blocked.';

create or replace function private.count_announcement_recipients(
  roles public.app_role[],
  armed_required boolean
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct employee.id)::integer
  from public.employees employee
  join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.status = 'active'
    and employee.role = any(roles)
    and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
    and (not armed_required or public.has_valid_credential(employee.id, 'armed_guard', current_date))
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
      'contactEmail', private.preferred_delivery_email(contact.personal_email, contact.company_email)
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
        'contactEmail', private.preferred_delivery_email(contact.personal_email, contact.company_email)
      ) order by employee.first_name, employee.last_name)
      from public.employees employee
      left join private.employee_accounts account on account.employee_id = employee.id
      left join private.employee_contacts contact on contact.employee_id = employee.id
      where employee.status = 'active'
        and (target_include_existing or account.employee_id is null)
    ), '[]'::jsonb)
  end
$$;

create or replace function public.service_claim_notification_batch(target_limit integer default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_limit integer := least(greatest(coalesce(target_limit, 10), 1), 25);
  claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'Only the service role can claim notification deliveries.';
  end if;

  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.delivered_at is null
      and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp()
      and outbox.attempt_count < 5
    order by outbox.available_at, outbox.created_at
    limit clean_limit
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set
      attempted_at = clock_timestamp(),
      attempt_count = outbox.attempt_count + 1,
      last_error = null
    from pending
    where outbox.id = pending.id
    returning outbox.*
  ), expanded as (
    select
      outbox.id,
      outbox.message_type,
      outbox.aggregate_type,
      outbox.aggregate_id,
      outbox.attempt_count,
      case
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select jsonb_build_object(
            'subject', 'Call-off reported',
            'text', concat(
              coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              ' reported a call-off. Open SygShift Requests to review and publish replacement coverage.'
            ),
            'html', concat(
              '<p><strong>', coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name,
              '</strong> reported a call-off.</p><p>Open SygShift Requests to review and publish replacement coverage.</p>'
            )
          )
          from public.call_off_reports report
          join public.employees employee on employee.id = report.employee_id
          where report.id = outbox.aggregate_id
        )
        when outbox.message_type = 'announcement_published' then (
          select jsonb_build_object(
            'subject', announcement.title,
            'text', announcement.body,
            'html', concat('<p>', replace(announcement.body, E'\n', '<br>'), '</p>')
          )
          from public.announcements announcement
          where announcement.id = outbox.aggregate_id
        )
        when outbox.message_type = 'schedule_published' then (
          select jsonb_build_object(
            'subject', concat('SygShift schedule updated: ', to_char(schedule.week_starts_on, 'MM/DD/YYYY'), ' week'),
            'text', concat(
              'The SygShift schedule for ',
              to_char(schedule.week_starts_on, 'MM/DD/YYYY'),
              ' through ',
              to_char(schedule.week_starts_on + 6, 'MM/DD/YYYY'),
              ' has been published.',
              E'\n\n',
              'Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.',
              E'\n\n',
              'Revision: ', schedule.revision,
              E'\n',
              'Assigned shifts: ', (
                select count(*)
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
                  and assignment.status <> 'canceled'
              ),
              E'\n',
              'Open slots: ', (
                select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
                from public.shifts shift
                left join lateral (
                  select count(*)::integer as active_assignments
                  from public.shift_assignments assignment
                  where assignment.shift_id = shift.id
                    and assignment.status <> 'canceled'
                ) assignment_counts on true
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
              )
            ),
            'html', concat(
              '<p>The SygShift schedule for <strong>',
              to_char(schedule.week_starts_on, 'MM/DD/YYYY'),
              ' through ',
              to_char(schedule.week_starts_on + 6, 'MM/DD/YYYY'),
              '</strong> has been published.</p>',
              '<p>Open SygShift to review your assigned shifts, open coverage, and any changes that affect your week.</p>',
              '<ul>',
              '<li><strong>Revision:</strong> ', schedule.revision, '</li>',
              '<li><strong>Assigned shifts:</strong> ', (
                select count(*)
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
                  and assignment.status <> 'canceled'
              ), '</li>',
              '<li><strong>Open slots:</strong> ', (
                select coalesce(sum(greatest(shift.headcount_required - assignment_counts.active_assignments, 0)), 0)
                from public.shifts shift
                left join lateral (
                  select count(*)::integer as active_assignments
                  from public.shift_assignments assignment
                  where assignment.shift_id = shift.id
                    and assignment.status <> 'canceled'
                ) assignment_counts on true
                where shift.schedule_id = schedule.id
                  and shift.canceled_at is null
              ), '</li>',
              '</ul>'
            )
          )
          from public.schedules schedule
          where schedule.id = outbox.aggregate_id
        )
        else jsonb_build_object(
          'subject', 'SygShift notification',
          'text', 'Open SygShift for details.',
          'html', '<p>Open SygShift for details.</p>'
        )
      end as message,
      case
        when outbox.message_type = 'call_off_supervisor_alert' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and employee.role in ('supervisor', 'admin')
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
        )
        when outbox.message_type = 'announcement_published' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.announcements announcement
          left join public.shifts shift on shift.id = announcement.shift_id
          join public.employees employee on employee.status = 'active'
          join private.employee_contacts contact on contact.employee_id = employee.id
          where announcement.id = outbox.aggregate_id
            and employee.role in ('guard', 'supervisor', 'admin')
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
            and (
              coalesce(shift.requires_armed, announcement.kind = 'event' and exists (
                select 1 from public.events event where event.id = announcement.event_id and event.requires_armed
              )) is false
              or public.has_valid_credential(employee.id, 'armed_guard', current_date)
            )
        )
        when outbox.message_type = 'schedule_published' then (
          select coalesce(
            jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email)),
            '[]'::jsonb
          )
          from public.employees employee
          join private.employee_contacts contact on contact.employee_id = employee.id
          where employee.status = 'active'
            and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
            and (
              employee.role in ('dispatcher', 'scheduler', 'supervisor', 'admin')
              or exists (
                select 1
                from public.shift_assignments assignment
                join public.shifts shift on shift.id = assignment.shift_id
                where shift.schedule_id = outbox.aggregate_id
                  and shift.canceled_at is null
                  and assignment.employee_id = employee.id
                  and assignment.status <> 'canceled'
              )
            )
        )
        else '[]'::jsonb
      end as recipients
    from touched outbox
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'messageType', message_type,
        'aggregateType', aggregate_type,
        'aggregateId', aggregate_id,
        'attemptCount', attempt_count,
        'recipients', recipients,
        'message', message
      )
      order by id
    ),
    '[]'::jsonb
  )
  into claimed
  from expanded;

  return claimed;
end
$$;

create or replace function public.service_claim_timekeeping_notification_batch(target_limit integer default 25)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare claimed jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role is required.'; end if;
  with pending as (
    select outbox.*
    from private.notification_outbox outbox
    where outbox.message_type = 'automatic_clock_out_employee'
      and outbox.delivered_at is null and outbox.failed_at is null
      and outbox.available_at <= clock_timestamp() and outbox.attempt_count < 5
    order by outbox.available_at, outbox.created_at
    limit least(greatest(coalesce(target_limit, 25), 1), 50)
    for update skip locked
  ), touched as (
    update private.notification_outbox outbox
    set attempted_at = clock_timestamp(), attempt_count = outbox.attempt_count + 1, last_error = null
    from pending where outbox.id = pending.id returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', outbox.id,
    'messageType', outbox.message_type,
    'aggregateType', outbox.aggregate_type,
    'aggregateId', outbox.aggregate_id,
    'attemptCount', outbox.attempt_count,
    'recipients', coalesce((
      select jsonb_agg(distinct private.preferred_delivery_email(contact.personal_email, contact.company_email))
      from public.timekeeping_operational_exceptions exception
      join private.employee_contacts contact on contact.employee_id = exception.employee_id
      where exception.id = outbox.aggregate_id
        and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null
    ), '[]'::jsonb),
    'message', (
      select jsonb_build_object(
        'subject', 'SygShift automatic clock-out — review your time',
        'text', concat(
          'Hello ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), ',', E'\n\n',
          'Your shift was automatically clocked out at ', to_char(exception.scheduled_end_at at time zone shift.time_zone, 'MM/DD/YYYY HH12:MI AM'),
          ' because SygShift did not receive a clock-out punch.', E'\n\n',
          'Please review your time record and submit a time-adjustment request if a correction is needed.', E'\n\n',
          'Open SygShift: https://app.sygilant.us/time/my-time'
        ),
        'html', concat(
          '<p>Hello ', coalesce(nullif(employee.preferred_name, ''), employee.first_name), ',</p>',
          '<p>Your shift was <strong>automatically clocked out at ', to_char(exception.scheduled_end_at at time zone shift.time_zone, 'MM/DD/YYYY HH12:MI AM'),
          '</strong> because SygShift did not receive a clock-out punch.</p>',
          '<p>Please review your time record and submit a time-adjustment request if a correction is needed.</p>',
          '<p><a href="https://app.sygilant.us/time/my-time">Open My Time in SygShift</a></p>'
        )
      )
      from public.timekeeping_operational_exceptions exception
      join public.employees employee on employee.id = exception.employee_id
      join public.shifts shift on shift.id = exception.shift_id
      where exception.id = outbox.aggregate_id
    )
  ) order by outbox.id), '[]'::jsonb) into claimed
  from touched outbox;
  return claimed;
end
$$;

revoke all on function private.preferred_delivery_email(text, text) from public, anon, authenticated;
revoke all on function public.service_get_employee_login_email_target(uuid) from public, anon, authenticated;
revoke all on function public.service_get_employee_login_email_targets(boolean) from public, anon, authenticated;
revoke all on function public.service_claim_notification_batch(integer) from public, anon, authenticated;
revoke all on function public.service_claim_timekeeping_notification_batch(integer) from public, anon, authenticated;
grant execute on function private.preferred_delivery_email(text, text) to service_role;
grant execute on function public.service_get_employee_login_email_target(uuid) to service_role;
grant execute on function public.service_get_employee_login_email_targets(boolean) to service_role;
grant execute on function public.service_claim_notification_batch(integer) to service_role;
grant execute on function public.service_claim_timekeeping_notification_batch(integer) to service_role;

notify pgrst, 'reload schema';
commit;
