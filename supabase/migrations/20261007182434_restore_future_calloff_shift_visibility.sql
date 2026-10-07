begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- The 09/25 employee-time-zone release recreated get_timekeeping_dashboard
-- and unintentionally removed the 09/06 contract that keeps the nearest
-- later paid assignment visible. Restore only that informational choice. The
-- record_time_event RPC remains the authority for early-clock eligibility.
do $restore_next_call_off_shift$
declare
  definition text;
  original text := $old$and shift.starts_at <= server_now + interval '12 hours'$old$;
  repair_marker text := $marker$next_assignment.employee_id = viewer_employee_id$marker$;
  canceled_guard_marker text := $marker$and assignment.canceled_at is null
      and ($marker$;
  replacement text := $new$and assignment.canceled_at is null
      and (
        shift.starts_at <= server_now + interval '12 hours'
        or shift.id = (
          select next_shift.id
          from public.shift_assignments next_assignment
          join public.shifts next_shift
            on next_shift.id = next_assignment.shift_id
          join public.schedules next_schedule
            on next_schedule.id = next_shift.schedule_id
          where next_assignment.employee_id = viewer_employee_id
            and next_assignment.status in ('assigned', 'confirmed')
            and next_assignment.canceled_at is null
            and next_schedule.status = 'published'
            and next_shift.canceled_at is null
            and private.shift_assignment_type(next_shift.id) = 'standard'
            and next_shift.starts_at > server_now + interval '12 hours'
          order by next_shift.starts_at, next_shift.id
          limit 1
        )
      )$new$;
begin
  definition := pg_get_functiondef(
    'public.get_timekeeping_dashboard(date)'::regprocedure
  );

  if position(repair_marker in definition) > 0 then
    if position(canceled_guard_marker in definition) = 0 then
      raise exception 'The nearest-later assignment repair is only partially installed; review required.';
    end if;
    raise notice 'The nearest-later employee assignment contract is already present.';
    return;
  end if;

  if position(original in definition) = 0 then
    raise exception 'Time dashboard future-shift contract changed; review required before applying repair.';
  end if;

  if length(definition) - length(replace(definition, original, ''))
       <> length(original) then
    raise exception 'Time dashboard future-shift anchor is not unique; review required before applying repair.';
  end if;

  definition := replace(definition, original, replacement);
  execute definition;
end
$restore_next_call_off_shift$;

-- Accountability history filters and occurrence-entry choices are different
-- concerns. Keep events and exceptions inside the requested review range, but
-- also offer active published assignments beginning in the next fourteen days
-- so a manager can record an upcoming call-off when notice arrives early.
create or replace function public.get_accountability_workspace_v2(
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
  payload jsonb := public.get_accountability_workspace(
    target_from_date,
    target_through_date
  );
  events_payload jsonb;
  shift_payload jsonb;
begin
  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      'reportedLateMinutes', event.reported_late_minutes,
      'expectedArrivalAt', event.expected_arrival_at,
      'actualArrivalAt', event.actual_arrival_at
    ) order by item.ordinality
  ), '[]'::jsonb)
  into events_payload
  from jsonb_array_elements(
    coalesce(payload -> 'events', '[]'::jsonb)
  ) with ordinality item(value, ordinality)
  left join public.attendance_accountability_events event
    on item.value ->> 'sourceTable' = 'attendance_accountability_events'
   and event.id = (item.value ->> 'id')::uuid;

  with existing_choices as (
    select
      item.value,
      (item.value ->> 'startsAt')::timestamptz as starts_at,
      lower(coalesce(item.value ->> 'locationName', '')) as location_sort,
      item.value ->> 'id' as shift_id
    from jsonb_array_elements(
      coalesce(payload -> 'shiftOptions', '[]'::jsonb)
    ) item(value)
    where private.shift_assignment_type((item.value ->> 'id')::uuid) = 'standard'
      and exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = (item.value ->> 'id')::uuid
          and assignment.employee_id = (item.value ->> 'employeeId')::uuid
          and assignment.status in ('assigned', 'confirmed')
          and assignment.canceled_at is null
      )
  ),
  upcoming_choices as (
    select
      jsonb_build_object(
        'id', shift.id,
        'employeeId', assignment.employee_id,
        'operationalDate',
          (shift.starts_at at time zone coalesce(shift.time_zone, 'America/Denver'))::date,
        'startsAt', shift.starts_at,
        'endsAt', shift.ends_at,
        'timeZone', coalesce(shift.time_zone, 'America/Denver'),
        'locationName', coalesce(
          site.name,
          event.location_name,
          event.name,
          post.name,
          'Scheduled shift'
        ),
        'siteCode', site.code,
        'postName', post.name,
        'eventName', event.name
      ) as value,
      shift.starts_at,
      lower(coalesce(
        site.name,
        event.location_name,
        event.name,
        post.name,
        'Scheduled shift'
      )) as location_sort,
      shift.id::text as shift_id
    from public.shifts shift
    join public.schedules schedule
      on schedule.id = shift.schedule_id
     and schedule.status = 'published'
    join public.shift_assignments assignment
      on assignment.shift_id = shift.id
     and assignment.status in ('assigned', 'confirmed')
     and assignment.canceled_at is null
    join public.employees employee
      on employee.id = assignment.employee_id
     and employee.status = 'active'
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    where shift.canceled_at is null
      and private.shift_assignment_type(shift.id) = 'standard'
      and shift.ends_at >= statement_timestamp() - interval '6 hours'
      and shift.starts_at <= statement_timestamp() + interval '14 days'
      and not exists (
        select 1
        from existing_choices existing
        where existing.shift_id = shift.id::text
      )
  ),
  all_choices as (
    select value, starts_at, location_sort, shift_id
    from existing_choices
    union all
    select value, starts_at, location_sort, shift_id
    from upcoming_choices
  )
  select coalesce(
    jsonb_agg(value order by starts_at, location_sort, shift_id),
    '[]'::jsonb
  )
  into shift_payload
  from all_choices;

  payload := jsonb_set(payload, '{events}', events_payload, true);
  return jsonb_set(payload, '{shiftOptions}', shift_payload, true);
end
$$;

revoke all on function public.get_accountability_workspace_v2(date, date)
  from public, anon;
grant execute on function public.get_accountability_workspace_v2(date, date)
  to authenticated;

-- "Unexcused" is an existing human review outcome, but the employee-delivery
-- trigger predated that option. Deliver it through the same protected,
-- idempotent notification route as the other review decisions.
create or replace function private.deliver_accountability_writeup_to_employee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict error
declare
  event_record public.attendance_accountability_events%rowtype;
  created_notification_id uuid;
  action_label text;
  message_body text;
  message_subject text;
begin
  select * into event_record
  from public.attendance_accountability_events event
  where event.id = new.event_id;

  if event_record.id is null
     or event_record.employee_id = new.actor_id
     or new.action not in (
        'created', 'confirmed', 'unexcused', 'excused_protected', 'corrected',
        'dismissed', 'voided', 'reopened', 'reclassified'
      ) then
    return new;
  end if;

  action_label := initcap(replace(new.action, '_', ' '));
  message_subject := case
    when new.action = 'created'
      then '[SygShift] Attendance record documented'
    else '[SygShift] Attendance record updated'
  end;
  message_body := concat(
    case
      when new.action = 'created'
        then 'An attendance or accountability record was documented for you.'
      else 'Your attendance or accountability record was updated.'
    end,
    E'\n\nDate: ', to_char(event_record.operational_date, 'MM/DD/YYYY'),
    E'\nType: ', initcap(replace(event_record.event_type, '_', ' ')),
    E'\nStatus: ', action_label,
    E'\nDetails: Review the protected notification in SygShift. Sensitive record details are not included in email.',
    E'\n\nOpen your SygShift notifications: https://app.sygilant.us/notifications'
  );

  created_notification_id := private.create_employee_notification(
    event_record.employee_id,
    'accountability_writeup',
    event_record.id,
    'accountability-writeup-action:' || new.id::text || ':employee:'
      || event_record.employee_id::text,
    message_subject,
    message_body,
    case when new.action in ('confirmed', 'unexcused')
      then 'important'
      else 'routine'
    end,
    false,
    '/notifications',
    'Open notification',
    new.actor_id
  );

  if created_notification_id is not null then
    insert into public.employee_notification_email_deliveries (
      notification_id,
      recipient_employee_id,
      subject,
      body
    ) values (
      created_notification_id,
      event_record.employee_id,
      message_subject,
      message_body
    ) on conflict (notification_id) do nothing;

    perform private.signal_employee_update(
      event_record.employee_id,
      jsonb_build_object(
        'kind', 'notification',
        'id', created_notification_id,
        'isNew', true
      )
    );
  end if;

  return new;
end
$$;

revoke all on function private.deliver_accountability_writeup_to_employee()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
