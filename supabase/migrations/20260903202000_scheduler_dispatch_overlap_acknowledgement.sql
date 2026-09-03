begin;

create or replace function private.concurrent_dispatch_overlap_preview(
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
  target_shift public.shifts%rowtype;
  target_schedule public.schedules%rowtype;
  target_assignment_type text;
  target_location text;
  overlap_record record;
begin
  select shift.* into target_shift
  from public.shifts shift
  where shift.id = target_shift_id
    and shift.canceled_at is null;

  if target_shift.id is null then
    raise no_data_found using message = 'The selected shift was not found.';
  end if;

  select schedule.* into target_schedule
  from public.schedules schedule
  where schedule.id = target_shift.schedule_id;

  if target_schedule.id is null then
    raise no_data_found using message = 'The selected schedule was not found.';
  end if;

  target_assignment_type := private.shift_assignment_type(target_shift.id);

  select coalesce(site.name || ' / ' || post.name, event.location_name, event.name, 'Selected shift')
  into target_location
  from public.shifts shift
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where shift.id = target_shift.id;

  select
    assignment.id as assignment_id,
    shift.id as shift_id,
    private.shift_assignment_type(shift.id) as assignment_type,
    coalesce(site.name || ' / ' || post.name, event.location_name, event.name, 'Existing shift') as location_label,
    to_char((shift.starts_at at time zone shift.time_zone)::date, 'MM/DD/YYYY') as operational_date,
    to_char(shift.starts_at at time zone shift.time_zone, 'FMHH12:MI AM') as starts_at_label,
    to_char(shift.ends_at at time zone shift.time_zone, 'FMHH12:MI AM') as ends_at_label,
    shift.time_zone
  into overlap_record
  from public.shift_assignments assignment
  join public.shifts shift on shift.id = assignment.shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites site on site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  where assignment.employee_id = target_employee_id
    and assignment.status in ('assigned', 'confirmed', 'completed')
    and shift.id <> target_shift.id
    and shift.canceled_at is null
    and (
      schedule.id = target_schedule.id
      or (
        schedule.status = 'published'
        and schedule.id is distinct from target_schedule.previous_revision_id
        and not (target_schedule.status = 'draft' and schedule.week_starts_on = target_schedule.week_starts_on)
      )
    )
    and tstzrange(shift.starts_at, shift.ends_at, '[)') && tstzrange(target_shift.starts_at, target_shift.ends_at, '[)')
    and (
      (target_assignment_type = 'dispatch_phone_duty' and private.shift_assignment_type(shift.id) = 'standard' and shift.work_type = 'post')
      or (private.shift_assignment_type(shift.id) = 'dispatch_phone_duty' and target_assignment_type = 'standard' and target_shift.work_type = 'post')
    )
  order by shift.starts_at, shift.ends_at, schedule.revision desc, assignment.id
  limit 1;

  return jsonb_build_object(
    'requiresAcknowledgement', overlap_record.assignment_id is not null,
    'employeeId', target_employee_id,
    'targetShiftId', target_shift.id,
    'targetAssignmentType', target_assignment_type,
    'targetLocation', coalesce(target_location, 'Selected shift'),
    'overlappingShiftId', overlap_record.shift_id,
    'overlappingAssignmentType', overlap_record.assignment_type,
    'overlappingLocation', overlap_record.location_label,
    'overlappingDate', overlap_record.operational_date,
    'overlappingStartsAt', overlap_record.starts_at_label,
    'overlappingEndsAt', overlap_record.ends_at_label,
    'overlappingTimeZone', overlap_record.time_zone
  );
end
$$;

revoke all on function private.concurrent_dispatch_overlap_preview(uuid, uuid) from public, anon, authenticated;

create or replace function public.get_concurrent_dispatch_overlap_preview(
  target_shift_id uuid,
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified Scheduler access is required to check concurrent Dispatch duty.';
  end if;

  return private.concurrent_dispatch_overlap_preview(target_shift_id, target_employee_id);
end
$$;

revoke all on function public.get_concurrent_dispatch_overlap_preview(uuid, uuid) from public, anon;
grant execute on function public.get_concurrent_dispatch_overlap_preview(uuid, uuid) to authenticated;

create or replace function public.scheduler_add_draft_shift_assignment_v3(
  target_shift_id uuid,
  target_employee_id uuid,
  target_availability_override_note text default null,
  target_credential_override_note text default null,
  target_overtime_override_note text default null,
  target_dispatch_overlap_acknowledged boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  overlap_preview jsonb;
  result_payload jsonb;
begin
  if actor_id is null or not private.can_manage_schedule_drafts() then
    raise insufficient_privilege using message = 'MFA-verified Scheduler access is required to add an employee.';
  end if;

  overlap_preview := private.concurrent_dispatch_overlap_preview(target_shift_id, target_employee_id);

  if coalesce((overlap_preview ->> 'requiresAcknowledgement')::boolean, false)
    and not coalesce(target_dispatch_overlap_acknowledged, false) then
    raise check_violation using message = format(
      'This assignment creates permitted concurrent Dispatch phone duty with %s on %s from %s to %s. Acknowledge the concurrent responsibility to continue.',
      coalesce(overlap_preview ->> 'overlappingLocation', 'the existing site/post shift'),
      coalesce(overlap_preview ->> 'overlappingDate', 'the same date'),
      coalesce(overlap_preview ->> 'overlappingStartsAt', 'its scheduled start'),
      coalesce(overlap_preview ->> 'overlappingEndsAt', 'its scheduled end')
    );
  end if;

  result_payload := public.scheduler_add_draft_shift_assignment_v2(
    target_shift_id,
    target_employee_id,
    target_availability_override_note,
    target_credential_override_note,
    target_overtime_override_note
  );

  overlap_preview := private.concurrent_dispatch_overlap_preview(target_shift_id, target_employee_id);

  if coalesce((overlap_preview ->> 'requiresAcknowledgement')::boolean, false) then
    if not coalesce(target_dispatch_overlap_acknowledged, false) then
      raise check_violation using message = 'Concurrent Dispatch phone duty changed while the assignment was being saved. Review and acknowledge it before continuing.';
    end if;

    insert into private.audit_events (
      auth_user_id,
      employee_id,
      schema_name,
      table_name,
      operation,
      row_id,
      new_record
    ) values (
      auth.uid(),
      actor_id,
      'public',
      'shift_assignments',
      'ACKNOWLEDGE_CONCURRENT_DISPATCH_PHONE_DUTY',
      target_shift_id::text,
      overlap_preview || jsonb_build_object(
        'assignedEmployeeId', target_employee_id,
        'acknowledged', true,
        'acknowledgedBy', actor_id,
        'acknowledgedAt', clock_timestamp(),
        'payableMinutesAdded', 0
      )
    );
  end if;

  return result_payload;
end
$$;

revoke all on function public.scheduler_add_draft_shift_assignment_v3(uuid, uuid, text, text, text, boolean) from public, anon;
grant execute on function public.scheduler_add_draft_shift_assignment_v3(uuid, uuid, text, text, text, boolean) to authenticated;

comment on function public.get_concurrent_dispatch_overlap_preview(uuid, uuid) is
  'Returns the exact permitted Dispatch-plus-site overlap requiring an authorized Scheduler acknowledgement.';

comment on function public.scheduler_add_draft_shift_assignment_v3(uuid, uuid, text, text, text, boolean) is
  'Allows MFA-verified Schedulers to assign concurrent Dispatch phone duty only after a narrow audited acknowledgement; ordinary overlapping shifts remain blocked.';

notify pgrst, 'reload schema';

commit;
