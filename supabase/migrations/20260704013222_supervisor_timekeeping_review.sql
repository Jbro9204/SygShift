begin;

alter table public.time_event_corrections
  add column if not exists declined_by uuid references public.employees(id) on delete restrict,
  add column if not exists declined_at timestamptz,
  add column if not exists decision_note text;

alter table public.time_event_corrections
  drop constraint if exists time_event_corrections_single_decision;

alter table public.time_event_corrections
  add constraint time_event_corrections_single_decision check (
    not (approved_at is not null and declined_at is not null)
    and (approved_at is null or approved_by is not null)
    and (declined_at is null or declined_by is not null)
  );

create index if not exists time_event_corrections_declined_by_fk_idx
  on public.time_event_corrections (declined_by);

drop trigger if exists time_event_corrections_append_only on public.time_event_corrections;

create or replace function private.protect_time_event_correction_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'time_event_corrections is append-only.';
  end if;

  if old.approved_at is not null or old.declined_at is not null then
    raise exception 'Reviewed time corrections cannot be changed.';
  end if;

  if new.time_event_id is distinct from old.time_event_id
    or new.replacement_time is distinct from old.replacement_time
    or new.voided is distinct from old.voided
    or new.reason is distinct from old.reason
    or new.requested_by is distinct from old.requested_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Correction request details cannot be changed.';
  end if;

  if new.approved_at is not null and new.declined_at is not null then
    raise exception 'A correction cannot be both approved and declined.';
  end if;

  if new.approved_at is null and new.declined_at is null then
    raise exception 'Only review decisions may be added to a correction.';
  end if;

  if new.approved_at is not null
    and (
      new.approved_by is null
      or new.declined_by is not null
      or new.declined_at is not null
    )
  then
    raise exception 'Approved corrections require only approval fields.';
  end if;

  if new.declined_at is not null
    and (
      new.declined_by is null
      or new.approved_by is not null
      or new.approved_at is not null
      or btrim(coalesce(new.decision_note, '')) = ''
    )
  then
    raise exception 'Declined corrections require a decision note.';
  end if;

  return new;
end
$$;

create trigger time_event_corrections_append_only
before update or delete on public.time_event_corrections
for each row execute function private.protect_time_event_correction_review();

create or replace function public.get_timekeeping_review(
  target_from_date date,
  target_through_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  review_rows jsonb;
  pending_corrections jsonb;
  rows_total integer;
  ready_total integer;
  exception_total integer;
  pending_correction_total integer;
  gross_minutes_total integer;
  paid_minutes_total integer;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required for time review.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Time review ranges are limited to 46 days.';
  end if;

  with effective_events as (
    select
      event.id,
      event.employee_id,
      event.shift_id,
      event.kind,
      event.recorded_at,
      coalesce((
        select correction.replacement_time
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
          and correction.voided = false
          and correction.replacement_time is not null
        order by correction.approved_at desc
        limit 1
      ), event.recorded_at) as effective_at,
      exists (
        select 1
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is not null
          and correction.voided
      ) as voided,
      exists (
        select 1
        from public.time_event_corrections correction
        where correction.time_event_id = event.id
          and correction.approved_at is null
          and correction.declined_at is null
      ) as pending_correction
    from public.time_events event
  ),
  active_events as (
    select *
    from effective_events event
    where not event.voided
      and (event.effective_at at time zone 'America/Denver')::date between target_from_date and target_through_date
  ),
  sequenced as (
    select
      event.*,
      coalesce(event.shift_id::text, 'unscheduled:' || event.employee_id::text || ':' || (event.effective_at at time zone 'America/Denver')::date::text) as group_key,
      (event.effective_at at time zone 'America/Denver')::date as operational_date,
      lag(event.kind) over (
        partition by event.employee_id, coalesce(event.shift_id::text, 'unscheduled:' || (event.effective_at at time zone 'America/Denver')::date::text)
        order by event.effective_at, event.recorded_at, event.id
      ) as previous_kind,
      lead(event.kind) over (
        partition by event.employee_id, coalesce(event.shift_id::text, 'unscheduled:' || (event.effective_at at time zone 'America/Denver')::date::text)
        order by event.effective_at, event.recorded_at, event.id
      ) as next_kind,
      lead(event.effective_at) over (
        partition by event.employee_id, coalesce(event.shift_id::text, 'unscheduled:' || (event.effective_at at time zone 'America/Denver')::date::text)
        order by event.effective_at, event.recorded_at, event.id
      ) as next_effective_at
    from active_events event
  ),
  grouped as (
    select
      event.employee_id,
      event.shift_id,
      event.group_key,
      min(event.operational_date) as operational_date,
      min(event.effective_at) filter (where event.kind = 'clock_in') as first_clock_in,
      max(event.effective_at) filter (where event.kind = 'clock_out') as last_clock_out,
      count(*)::integer as event_count,
      bool_or(event.shift_id is null) as unscheduled,
      bool_or(event.pending_correction) as has_pending_correction,
      bool_or(
        not (
          (event.previous_kind is null and event.kind = 'clock_in')
          or (event.previous_kind = 'clock_in' and event.kind in ('break_start', 'clock_out'))
          or (event.previous_kind = 'break_start' and event.kind = 'break_end')
          or (event.previous_kind = 'break_end' and event.kind in ('break_start', 'clock_out'))
        )
      ) as invalid_sequence,
      (array_agg(event.kind order by event.effective_at, event.recorded_at, event.id))[1] as first_kind,
      (array_agg(event.kind order by event.effective_at desc, event.recorded_at desc, event.id desc))[1] as last_kind,
      coalesce(sum(
        case
          when event.kind in ('clock_in', 'break_end')
            and event.next_kind in ('break_start', 'clock_out')
            and event.next_effective_at > event.effective_at
          then extract(epoch from event.next_effective_at - event.effective_at) / 60
          else 0
        end
      ), 0)::integer as paid_minutes,
      coalesce(sum(
        case
          when event.kind = 'break_start'
            and event.next_kind = 'break_end'
            and event.next_effective_at > event.effective_at
          then extract(epoch from event.next_effective_at - event.effective_at) / 60
          else 0
        end
      ), 0)::integer as break_minutes
    from sequenced event
    group by event.employee_id, event.shift_id, event.group_key
  ),
  decorated as (
    select
      grouped.*,
      employee.username,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as employee_name,
      employee.role,
      employee.employment_type,
      shift.starts_at as scheduled_starts_at,
      shift.ends_at as scheduled_ends_at,
      shift.time_zone,
      shift.requires_armed,
      shift.is_overtime,
      post.name as post_name,
      site.name as site_name,
      site.code as site_code,
      event.name as event_name,
      coalesce(event.location_name, site.name, post.name, event.name, 'Unscheduled') as location_name,
      case
        when grouped.first_clock_in is not null and grouped.last_clock_out is not null and grouped.last_clock_out > grouped.first_clock_in
        then (extract(epoch from grouped.last_clock_out - grouped.first_clock_in) / 60)::integer
        else 0
      end as gross_minutes
    from grouped
    join public.employees employee on employee.id = grouped.employee_id
    left join public.shifts shift on shift.id = grouped.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events event on event.id = shift.event_id
  ),
  final_rows as (
    select
      *,
      (
        first_kind = 'clock_in'
        and last_kind = 'clock_out'
        and not invalid_sequence
        and not has_pending_correction
        and paid_minutes > 0
      ) as payroll_ready,
      array_remove(array[
        case when unscheduled then 'unscheduled' end,
        case when first_kind is distinct from 'clock_in' then 'missing_clock_in' end,
        case when last_kind is distinct from 'clock_out' then 'missing_clock_out' end,
        case when invalid_sequence then 'invalid_sequence' end,
        case when has_pending_correction then 'pending_correction' end,
        case when paid_minutes = 0 then 'zero_paid_minutes' end
      ], null) as exception_codes
    from decorated
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'employeeId', employee_id,
      'username', username,
      'employeeName', employee_name,
      'role', role,
      'employmentType', employment_type,
      'shiftId', shift_id,
      'operationalDate', operational_date,
      'siteName', site_name,
      'siteCode', site_code,
      'postName', post_name,
      'eventName', event_name,
      'locationName', location_name,
      'scheduledStartsAt', scheduled_starts_at,
      'scheduledEndsAt', scheduled_ends_at,
      'timeZone', coalesce(time_zone, 'America/Denver'),
      'firstClockIn', first_clock_in,
      'lastClockOut', last_clock_out,
      'grossMinutes', gross_minutes,
      'breakMinutes', break_minutes,
      'paidMinutes', paid_minutes,
      'eventCount', event_count,
      'requiresArmed', coalesce(requires_armed, false),
      'isOvertime', coalesce(is_overtime, false),
      'payrollReady', payroll_ready,
      'exceptionCodes', to_jsonb(exception_codes)
    ) order by operational_date, employee_name, first_clock_in), '[]'::jsonb),
    count(*)::integer,
    count(*) filter (where payroll_ready)::integer,
    count(*) filter (where not payroll_ready)::integer,
    coalesce(sum(gross_minutes), 0)::integer,
    coalesce(sum(paid_minutes), 0)::integer
  into review_rows, rows_total, ready_total, exception_total, gross_minutes_total, paid_minutes_total
  from final_rows;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', correction.id,
    'timeEventId', correction.time_event_id,
    'employeeId', event.employee_id,
    'employeeName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'username', employee.username,
    'kind', event.kind,
    'recordedAt', event.recorded_at,
    'replacementTime', correction.replacement_time,
    'voided', correction.voided,
    'reason', correction.reason,
    'requestedBy', correction.requested_by,
    'requestedAt', correction.created_at,
    'shiftId', event.shift_id
  ) order by correction.created_at), '[]'::jsonb)
  into pending_corrections
  from public.time_event_corrections correction
  join public.time_events event on event.id = correction.time_event_id
  join public.employees employee on employee.id = event.employee_id
  where correction.approved_at is null
    and correction.declined_at is null
    and (event.recorded_at at time zone 'America/Denver')::date between target_from_date and target_through_date;

  pending_correction_total := jsonb_array_length(pending_corrections);

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'fromDate', target_from_date,
    'throughDate', target_through_date,
    'operationalTimeZone', 'America/Denver',
    'summary', jsonb_build_object(
      'rowCount', rows_total,
      'readyCount', ready_total,
      'exceptionCount', exception_total,
      'pendingCorrectionCount', pending_correction_total,
      'grossMinutes', gross_minutes_total,
      'paidMinutes', paid_minutes_total
    ),
    'rows', review_rows,
    'pendingCorrections', pending_corrections
  );
end
$$;

create or replace function public.review_time_event_correction(
  target_correction_id uuid,
  target_approved boolean,
  target_decision_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  reviewed_correction public.time_event_corrections%rowtype;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required for correction review.';
  end if;

  if target_approved is null then
    raise check_violation using message = 'Correction decision is required.';
  end if;

  if not target_approved and btrim(coalesce(target_decision_note, '')) = '' then
    raise check_violation using message = 'Declined corrections require a decision note.';
  end if;

  if target_approved then
    update public.time_event_corrections
    set
      approved_by = reviewer_id,
      approved_at = clock_timestamp(),
      decision_note = nullif(btrim(coalesce(target_decision_note, '')), '')
    where id = target_correction_id
      and approved_at is null
      and declined_at is null
    returning * into reviewed_correction;
  else
    update public.time_event_corrections
    set
      declined_by = reviewer_id,
      declined_at = clock_timestamp(),
      decision_note = btrim(target_decision_note)
    where id = target_correction_id
      and approved_at is null
      and declined_at is null
    returning * into reviewed_correction;
  end if;

  if reviewed_correction.id is null then
    raise no_data_found using message = 'The correction is no longer pending review.';
  end if;

  return jsonb_build_object(
    'id', reviewed_correction.id,
    'timeEventId', reviewed_correction.time_event_id,
    'approved', reviewed_correction.approved_at is not null,
    'approvedAt', reviewed_correction.approved_at,
    'declinedAt', reviewed_correction.declined_at,
    'decisionNote', reviewed_correction.decision_note
  );
end
$$;

revoke all on function public.get_timekeeping_review(date, date) from public, anon;
revoke all on function public.review_time_event_correction(uuid, boolean, text) from public, anon;

grant execute on function public.get_timekeeping_review(date, date) to authenticated;
grant execute on function public.review_time_event_correction(uuid, boolean, text) to authenticated;

commit;
