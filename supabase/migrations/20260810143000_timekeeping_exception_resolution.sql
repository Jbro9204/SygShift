begin;

insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values (
  'time.resolve_exceptions',
  'Time & Attendance',
  'Resolve payroll exceptions',
  'Approve valid timekeeping exceptions, dismiss false positives, and reopen prior decisions without changing original punches.',
  'critical',
  true,
  false,
  true
)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  active = true,
  updated_at = now();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, 'time.resolve_exceptions', true
from public.access_roles role
where role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = now();

create table public.timekeeping_exception_resolutions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  operational_date date not null,
  exception_code text not null,
  occurrence_fingerprint text not null,
  action text not null,
  reason text not null,
  occurrence_snapshot jsonb not null,
  resolved_by uuid not null references public.employees(id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp(),
  constraint timekeeping_exception_resolution_code_present check (btrim(exception_code) <> ''),
  constraint timekeeping_exception_resolution_fingerprint_format check (occurrence_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint timekeeping_exception_resolution_action_check check (action in ('approved_exception', 'dismissed_false_positive', 'reopened')),
  constraint timekeeping_exception_resolution_reason_present check (char_length(btrim(reason)) between 8 and 1000),
  constraint timekeeping_exception_resolution_snapshot_object check (jsonb_typeof(occurrence_snapshot) = 'object')
);

create index timekeeping_exception_resolutions_occurrence_idx
  on public.timekeeping_exception_resolutions (
    employee_id,
    operational_date,
    shift_id,
    exception_code,
    occurrence_fingerprint,
    resolved_at desc,
    id desc
  );

create index timekeeping_exception_resolutions_actor_idx
  on public.timekeeping_exception_resolutions (resolved_by, resolved_at desc);

alter table public.timekeeping_exception_resolutions enable row level security;

create trigger timekeeping_exception_resolutions_audit
after insert on public.timekeeping_exception_resolutions
for each row execute function private.write_audit_event();

create trigger timekeeping_exception_resolutions_append_only
before update or delete on public.timekeeping_exception_resolutions
for each row execute function private.prevent_append_only_change();

revoke all on table public.timekeeping_exception_resolutions from public, anon, authenticated;

create or replace function private.get_timekeeping_occurrence_context(
  target_employee_id uuid,
  target_shift_id uuid,
  target_operational_date date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with effective_events as (
  select
    event.id,
    event.employee_id,
    coalesce((
      select shift_override.shift_id
      from public.time_event_shift_overrides shift_override
      where shift_override.time_event_id = event.id
      order by shift_override.created_at desc, shift_override.id desc
      limit 1
    ), event.shift_id) as shift_id,
    event.kind,
    event.recorded_at,
    coalesce((
      select correction.replacement_time
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided = false
        and correction.replacement_time is not null
      order by correction.approved_at desc, correction.id desc
      limit 1
    ), event.recorded_at) as effective_at,
    exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
    ) as has_approved_correction,
    exists (
      select 1
      from public.time_event_corrections correction
      where correction.time_event_id = event.id
        and correction.approved_at is not null
        and correction.voided
    ) as voided
  from public.time_events event
  where event.employee_id = target_employee_id
),
scoped_events as (
  select event.*
  from effective_events event
  where not event.voided
    and (
      (target_shift_id is not null and event.shift_id = target_shift_id)
      or (
        target_shift_id is null
        and event.shift_id is null
        and (event.effective_at at time zone 'America/Denver')::date = target_operational_date
      )
    )
),
ordered_events as (
  select
    event.*,
    row_number() over (order by event.effective_at, event.recorded_at, event.id) as sequence_number,
    lag(event.kind) over (order by event.effective_at, event.recorded_at, event.id) as previous_kind,
    lead(event.kind) over (order by event.effective_at, event.recorded_at, event.id) as next_kind,
    lead(event.effective_at) over (order by event.effective_at, event.recorded_at, event.id) as next_effective_at,
    sum(case when event.kind = 'clock_in' then 1 else 0 end) over (
      order by event.effective_at, event.recorded_at, event.id
      rows between unbounded preceding and current row
    )::integer as segment_number
  from scoped_events event
),
sequence_summary as (
  select
    count(*)::integer as event_count,
    count(*) filter (where kind = 'clock_in')::integer as segment_count,
    coalesce(bool_and(
      (previous_kind is null and kind = 'clock_in')
      or (previous_kind = 'clock_in' and kind in ('break_start', 'clock_out'))
      or (previous_kind = 'break_start' and kind = 'break_end')
      or (previous_kind = 'break_end' and kind in ('break_start', 'clock_out'))
      or (previous_kind = 'clock_out' and kind = 'clock_in')
    ), false) as valid_sequence,
    (array_agg(kind order by effective_at, recorded_at, id))[1] as first_kind,
    (array_agg(kind order by effective_at desc, recorded_at desc, id desc))[1] as last_kind,
    min(effective_at) filter (where kind = 'clock_in') as first_clock_in,
    max(effective_at) filter (where kind = 'clock_out') as last_clock_out,
    bool_or(has_approved_correction) as has_approved_correction,
    coalesce(sum(
      case
        when kind in ('clock_in', 'break_end')
          and next_kind in ('break_start', 'clock_out')
          and next_effective_at > effective_at
        then extract(epoch from next_effective_at - effective_at) / 60
        else 0
      end
    ), 0)::integer as paid_minutes,
    coalesce(sum(
      case
        when kind = 'break_start'
          and next_kind = 'break_end'
          and next_effective_at > effective_at
        then extract(epoch from next_effective_at - effective_at) / 60
        else 0
      end
    ), 0)::integer as break_minutes
  from ordered_events
),
segment_rows as (
  select
    segment_number,
    min(effective_at) filter (where kind = 'clock_in') as starts_at,
    max(effective_at) filter (where kind = 'clock_out') as ends_at,
    coalesce(sum(
      case
        when kind in ('clock_in', 'break_end')
          and next_kind in ('break_start', 'clock_out')
          and next_effective_at > effective_at
        then extract(epoch from next_effective_at - effective_at) / 60
        else 0
      end
    ), 0)::integer as paid_minutes,
    coalesce(sum(
      case
        when kind = 'break_start'
          and next_kind = 'break_end'
          and next_effective_at > effective_at
        then extract(epoch from next_effective_at - effective_at) / 60
        else 0
      end
    ), 0)::integer as break_minutes
  from ordered_events
  where segment_number > 0
  group by segment_number
),
gap_rows as (
  select
    effective_at as starts_at,
    next_effective_at as ends_at,
    (extract(epoch from next_effective_at - effective_at) / 60)::integer as minutes
  from ordered_events
  where kind = 'clock_out'
    and next_kind = 'clock_in'
    and next_effective_at > effective_at
),
fingerprint_source as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'kind', kind,
    'recordedAt', recorded_at,
    'effectiveAt', effective_at,
    'shiftId', shift_id
  ) order by effective_at, recorded_at, id), '[]'::jsonb) as events
  from ordered_events
)
select jsonb_build_object(
  'eventCount', summary.event_count,
  'segmentCount', summary.segment_count,
  'validSequence', summary.valid_sequence,
  'sequenceComplete', summary.valid_sequence and summary.first_kind = 'clock_in' and summary.last_kind = 'clock_out',
  'firstClockIn', summary.first_clock_in,
  'lastClockOut', summary.last_clock_out,
  'grossMinutes', case
    when summary.first_clock_in is not null and summary.last_clock_out > summary.first_clock_in
    then (extract(epoch from summary.last_clock_out - summary.first_clock_in) / 60)::integer
    else 0
  end,
  'paidMinutes', summary.paid_minutes,
  'breakMinutes', summary.break_minutes,
  'unpaidGapMinutes', coalesce((select sum(gap.minutes)::integer from gap_rows gap), 0),
  'hasApprovedCorrection', summary.has_approved_correction,
  'events', fingerprint.events,
  'segments', coalesce((
    select jsonb_agg(jsonb_build_object(
      'segmentNumber', segment.segment_number,
      'startsAt', segment.starts_at,
      'endsAt', segment.ends_at,
      'paidMinutes', segment.paid_minutes,
      'breakMinutes', segment.break_minutes
    ) order by segment.segment_number)
    from segment_rows segment
  ), '[]'::jsonb),
  'unpaidGaps', coalesce((
    select jsonb_agg(jsonb_build_object(
      'startsAt', gap.starts_at,
      'endsAt', gap.ends_at,
      'minutes', gap.minutes
    ) order by gap.starts_at)
    from gap_rows gap
  ), '[]'::jsonb),
  'occurrenceFingerprint', encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'employeeId', target_employee_id,
        'shiftId', target_shift_id,
        'operationalDate', target_operational_date,
        'events', fingerprint.events
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
)
from sequence_summary summary
cross join fingerprint_source fingerprint
$$;

alter function public.get_timekeeping_review(date, date) set schema private;
alter function private.get_timekeeping_review(date, date) rename to get_timekeeping_review_base;
revoke all on function private.get_timekeeping_review_base(date, date) from public, anon, authenticated;

do $patch_exception_resolution_permission$
declare
  function_sql text;
begin
  select pg_get_functiondef('private.get_timekeeping_review_base(date, date)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'private.get_timekeeping_review_base(date, date) was not found.';
  end if;

  if position('time.resolve_exceptions' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '      or public.has_effective_permission(''time.export_payroll'')',
      '      or public.has_effective_permission(''time.export_payroll'')' || chr(10)
        || '      or public.has_effective_permission(''time.resolve_exceptions'')'
    );
  end if;

  if position('time.resolve_exceptions' in function_sql) = 0 then
    raise check_violation using message = 'Exception-resolution permission was not applied to the time review function.';
  end if;

  execute function_sql;
end
$patch_exception_resolution_permission$;

create function public.get_timekeeping_review(
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
  base_payload jsonb;
  base_row jsonb;
  transformed_row jsonb;
  transformed_rows jsonb := '[]'::jsonb;
  occurrence_context jsonb;
  detected_codes text[];
  effective_codes text[];
  code text;
  code_policy text;
  code_fingerprint text;
  latest_resolution public.timekeeping_exception_resolutions%rowtype;
  exception_details jsonb;
  resolved_actions text[];
  review_status text;
  rows_total integer := 0;
  ready_total integer := 0;
  exception_total integer := 0;
  can_view_resolution_history boolean := false;
  resolution_history jsonb := '[]'::jsonb;
begin
  base_payload := private.get_timekeeping_review_base(target_from_date, target_through_date);
  can_view_resolution_history := public.has_mfa() and (
    public.is_supervisor_or_admin()
    or public.has_effective_permission('time.manage')
    or public.has_effective_permission('time.export_payroll')
    or public.has_effective_permission('time.resolve_exceptions')
  );

  for base_row in
    select row_value
    from jsonb_array_elements(coalesce(base_payload -> 'rows', '[]'::jsonb)) row_payload(row_value)
  loop
    if base_row ->> 'rowKind' <> 'time_event' then
      transformed_rows := transformed_rows || jsonb_build_array(base_row);
      continue;
    end if;

    occurrence_context := private.get_timekeeping_occurrence_context(
      (base_row ->> 'employeeId')::uuid,
      nullif(base_row ->> 'shiftId', '')::uuid,
      (base_row ->> 'operationalDate')::date
    );

    select coalesce(array_agg(value), '{}'::text[])
    into detected_codes
    from jsonb_array_elements_text(coalesce(base_row -> 'exceptionCodes', '[]'::jsonb)) code_value(value);

    if coalesce((occurrence_context ->> 'validSequence')::boolean, false)
      and coalesce((occurrence_context ->> 'sequenceComplete')::boolean, false) then
      detected_codes := array_remove(detected_codes, 'invalid_sequence');
      detected_codes := array_remove(detected_codes, 'missing_clock_in');
      detected_codes := array_remove(detected_codes, 'missing_clock_out');
    end if;

    if coalesce((occurrence_context ->> 'segmentCount')::integer, 0) > 1
      and coalesce((occurrence_context ->> 'sequenceComplete')::boolean, false)
      and not ('multiple_work_segments' = any(detected_codes)) then
      detected_codes := array_append(detected_codes, 'multiple_work_segments');
    end if;

    effective_codes := '{}'::text[];
    exception_details := '[]'::jsonb;
    resolved_actions := '{}'::text[];

    foreach code in array detected_codes
    loop
      code_policy := case
        when code in ('unscheduled', 'multiple_work_segments', 'schedule_deviation', 'multiple_locations') then 'reviewable'
        else 'hard'
      end;
      code_fingerprint := encode(
        extensions.digest(
          convert_to((occurrence_context ->> 'occurrenceFingerprint') || ':' || code, 'UTF8'),
          'sha256'
        ),
        'hex'
      );

      latest_resolution := null;
      select resolution.*
      into latest_resolution
      from public.timekeeping_exception_resolutions resolution
      where resolution.employee_id = (base_row ->> 'employeeId')::uuid
        and resolution.operational_date = (base_row ->> 'operationalDate')::date
        and resolution.shift_id is not distinct from nullif(base_row ->> 'shiftId', '')::uuid
        and resolution.exception_code = code
        and resolution.occurrence_fingerprint = code_fingerprint
      order by resolution.resolved_at desc, resolution.id desc
      limit 1;

      if code_policy = 'hard'
        or latest_resolution.id is null
        or latest_resolution.action = 'reopened' then
        effective_codes := array_append(effective_codes, code);
      else
        resolved_actions := array_append(resolved_actions, latest_resolution.action);
      end if;

      exception_details := exception_details || jsonb_build_array(jsonb_build_object(
        'code', code,
        'policy', code_policy,
        'fingerprint', code_fingerprint,
        'status', case
          when code_policy = 'hard' then 'unresolved'
          when latest_resolution.id is null or latest_resolution.action = 'reopened' then 'unresolved'
          when latest_resolution.action = 'approved_exception' then 'approved_exception'
          else 'dismissed_false_positive'
        end,
        'resolutionId', latest_resolution.id,
        'resolvedBy', latest_resolution.resolved_by,
        'resolvedAt', latest_resolution.resolved_at,
        'reason', latest_resolution.reason
      ));
    end loop;

    review_status := case
      when cardinality(effective_codes) > 0 then 'unresolved'
      when 'approved_exception' = any(resolved_actions) then 'approved_exception'
      when cardinality(resolved_actions) > 0 then 'dismissed_false_positive'
      when coalesce((occurrence_context ->> 'hasApprovedCorrection')::boolean, false) then 'corrected'
      else 'ready'
    end;

    transformed_row := base_row || jsonb_build_object(
      'payrollReady', cardinality(effective_codes) = 0
        and coalesce((occurrence_context ->> 'sequenceComplete')::boolean, false)
        and coalesce((occurrence_context ->> 'paidMinutes')::integer, 0) > 0
        and not ('pending_correction' = any(detected_codes)),
      'exceptionCodes', to_jsonb(effective_codes),
      'detectedExceptionCodes', to_jsonb(detected_codes),
      'exceptionDetails', exception_details,
      'reviewStatus', review_status,
      'eventTimeline', occurrence_context -> 'events',
      'workedSegments', occurrence_context -> 'segments',
      'unpaidGaps', occurrence_context -> 'unpaidGaps',
      'unpaidGapMinutes', coalesce((occurrence_context ->> 'unpaidGapMinutes')::integer, 0)
    );
    transformed_rows := transformed_rows || jsonb_build_array(transformed_row);
  end loop;

  select
    count(*)::integer,
    count(*) filter (where coalesce((row_value ->> 'payrollReady')::boolean, false))::integer,
    count(*) filter (where not coalesce((row_value ->> 'payrollReady')::boolean, false))::integer
  into rows_total, ready_total, exception_total
  from jsonb_array_elements(transformed_rows) rows(row_value);

  if can_view_resolution_history then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', resolution.id,
      'employeeId', resolution.employee_id,
      'employeeName', btrim(coalesce(subject.preferred_name, subject.first_name) || ' ' || subject.last_name),
      'shiftId', resolution.shift_id,
      'operationalDate', resolution.operational_date,
      'exceptionCode', resolution.exception_code,
      'occurrenceFingerprint', resolution.occurrence_fingerprint,
      'action', resolution.action,
      'reason', resolution.reason,
      'resolvedBy', resolution.resolved_by,
      'resolvedByName', btrim(coalesce(actor.preferred_name, actor.first_name) || ' ' || actor.last_name),
      'resolvedAt', resolution.resolved_at
    ) order by resolution.resolved_at desc, resolution.id desc), '[]'::jsonb)
    into resolution_history
    from public.timekeeping_exception_resolutions resolution
    join public.employees subject on subject.id = resolution.employee_id
    join public.employees actor on actor.id = resolution.resolved_by
    where resolution.operational_date between target_from_date and target_through_date;
  end if;

  return base_payload || jsonb_build_object(
    'rows', transformed_rows,
    'summary', (base_payload -> 'summary') || jsonb_build_object(
      'rowCount', rows_total,
      'readyCount', ready_total,
      'exceptionCount', exception_total
    ),
    'exceptionResolutionHistory', resolution_history
  );
end
$$;

do $patch_payroll_export_exception_history$
declare
  function_sql text;
begin
  select pg_get_functiondef('public.get_payroll_export_batch_detail(uuid)'::regprocedure)
  into function_sql;

  if function_sql is null then
    raise undefined_function using message = 'public.get_payroll_export_batch_detail(uuid) was not found.';
  end if;

  if position('exceptionResolutionHistory' in function_sql) = 0 then
    function_sql := replace(
      function_sql,
      '''rows'', export_rows',
      '''rows'', export_rows,' || chr(10)
        || '    ''exceptionResolutionHistory'', coalesce(export_batch.review_payload -> ''exceptionResolutionHistory'', ''[]''::jsonb)'
    );
  end if;

  if position('exceptionResolutionHistory' in function_sql) = 0 then
    raise check_violation using message = 'Payroll export exception history was not applied to locked batch detail.';
  end if;

  execute function_sql;
end
$patch_payroll_export_exception_history$;

create function public.resolve_timekeeping_exception(
  target_employee_id uuid,
  target_shift_id uuid,
  target_operational_date date,
  target_exception_code text,
  target_occurrence_fingerprint text,
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
  clean_code text := lower(btrim(coalesce(target_exception_code, '')));
  clean_action text := lower(btrim(coalesce(target_action, '')));
  clean_reason text := btrim(coalesce(target_reason, ''));
  review_payload jsonb;
  matching_row jsonb;
  matching_detail jsonb;
  inserted_resolution public.timekeeping_exception_resolutions%rowtype;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() or not public.has_effective_permission('time.resolve_exceptions') then
    raise insufficient_privilege using message = 'Payroll exception resolution permission with MFA is required.';
  end if;

  if clean_action not in ('approved_exception', 'dismissed_false_positive', 'reopened') then
    raise check_violation using message = 'Choose Approve valid exception, Dismiss false positive, or Reopen.';
  end if;

  if char_length(clean_reason) < 8 then
    raise check_violation using message = 'Enter a clear reason of at least 8 characters.';
  end if;

  if clean_code not in ('unscheduled', 'multiple_work_segments', 'schedule_deviation', 'multiple_locations') then
    raise check_violation using message = 'This is a hard payroll blocker and cannot be bypassed. Correct the time record instead.';
  end if;

  if target_occurrence_fingerprint is null or target_occurrence_fingerprint !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The exception occurrence is invalid. Reload the blocker and try again.';
  end if;

  perform pg_advisory_xact_lock(hashtext('time-exception:' || target_occurrence_fingerprint || ':' || clean_code));

  review_payload := public.get_timekeeping_review(target_operational_date, target_operational_date);

  select row_value
  into matching_row
  from jsonb_array_elements(coalesce(review_payload -> 'rows', '[]'::jsonb)) row_payload(row_value)
  where row_value ->> 'employeeId' = target_employee_id::text
    and (row_value ->> 'operationalDate')::date = target_operational_date
    and nullif(row_value ->> 'shiftId', '')::uuid is not distinct from target_shift_id
  limit 1;

  if matching_row is null then
    raise no_data_found using message = 'This payroll blocker is no longer current. Reload Time Exceptions.';
  end if;

  select detail_value
  into matching_detail
  from jsonb_array_elements(coalesce(matching_row -> 'exceptionDetails', '[]'::jsonb)) detail(detail_value)
  where detail_value ->> 'code' = clean_code
    and detail_value ->> 'fingerprint' = target_occurrence_fingerprint
  limit 1;

  if matching_detail is null then
    raise check_violation using message = 'The punches or schedule changed after this blocker was opened. Reload it before deciding.';
  end if;

  if matching_detail ->> 'policy' <> 'reviewable' then
    raise check_violation using message = 'This is a hard payroll blocker and cannot be bypassed. Correct the time record instead.';
  end if;

  insert into public.timekeeping_exception_resolutions (
    employee_id,
    shift_id,
    operational_date,
    exception_code,
    occurrence_fingerprint,
    action,
    reason,
    occurrence_snapshot,
    resolved_by
  ) values (
    target_employee_id,
    target_shift_id,
    target_operational_date,
    clean_code,
    target_occurrence_fingerprint,
    clean_action,
    clean_reason,
    jsonb_build_object(
      'row', matching_row,
      'exception', matching_detail
    ),
    actor_id
  )
  returning * into inserted_resolution;

  return jsonb_build_object(
    'id', inserted_resolution.id,
    'employeeId', inserted_resolution.employee_id,
    'shiftId', inserted_resolution.shift_id,
    'operationalDate', inserted_resolution.operational_date,
    'exceptionCode', inserted_resolution.exception_code,
    'occurrenceFingerprint', inserted_resolution.occurrence_fingerprint,
    'action', inserted_resolution.action,
    'reason', inserted_resolution.reason,
    'resolvedBy', inserted_resolution.resolved_by,
    'resolvedAt', inserted_resolution.resolved_at
  );
end
$$;

revoke all on function private.get_timekeeping_occurrence_context(uuid, uuid, date) from public, anon, authenticated;
revoke all on function public.get_timekeeping_review(date, date) from public, anon;
revoke all on function public.resolve_timekeeping_exception(uuid, uuid, date, text, text, text, text) from public, anon;

grant execute on function public.get_timekeeping_review(date, date) to authenticated;
grant execute on function public.resolve_timekeeping_exception(uuid, uuid, date, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
