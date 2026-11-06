begin;
set local lock_timeout = '5s';

-- Forward-only return from already-started, unpaid hourly/flex leave. Keep the
-- submitted dates, original approval, payroll and used prefix as historical fact.
create table private.time_off_request_early_returns (
  request_id uuid primary key references public.time_off_requests(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  ended_by uuid not null references public.employees(id) on delete restrict,
  ended_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  note text not null check (btrim(note) <> '' and char_length(note) <= 2000),
  time_zone text not null check (btrim(time_zone) <> ''),
  original_approval jsonb not null check (jsonb_typeof(original_approval) = 'object'),
  original_window tstzrange not null,
  retained_window tstzrange not null,
  released_window tstzrange not null,
  check (not isempty(original_window) and not isempty(retained_window) and not isempty(released_window)),
  check (lower_inc(original_window) and not upper_inc(original_window)
    and lower_inc(retained_window) and not upper_inc(retained_window)
    and lower_inc(released_window) and not upper_inc(released_window)),
  check (lower(original_window) = lower(retained_window)
    and upper(retained_window) = ended_at and lower(released_window) = ended_at
    and upper(released_window) = upper(original_window)
    and lower(original_window) < ended_at and ended_at < upper(original_window)
    and ended_at <= recorded_at)
);
create index time_off_request_early_returns_employee_idx on private.time_off_request_early_returns(employee_id);
create index time_off_request_early_returns_reviewer_idx on private.time_off_request_early_returns(ended_by);
alter table private.time_off_request_early_returns enable row level security;
alter table private.time_off_request_early_returns force row level security;
revoke all on table private.time_off_request_early_returns from public, anon, authenticated, service_role;
create trigger time_off_request_early_returns_append_only
before update or delete on private.time_off_request_early_returns
for each row execute function private.prevent_append_only_change();
create trigger maintenance_write_guard
before insert or update or delete on private.time_off_request_early_returns
for each row execute function private.enforce_maintenance_feature_write('requests');

-- All operational consumers receive exactly the same half-open retained prefix.
-- A later unexpected edit to original bounds fails closed instead of rebasing
-- historical evidence. This helper is not a public authorization surface.
create function private.effective_time_off_window(target_request_id uuid, original_span tstzrange)
returns tstzrange language plpgsql stable security definer set search_path = '' as $$
declare receipt private.time_off_request_early_returns%rowtype;
begin
  select * into receipt from private.time_off_request_early_returns
  where request_id = target_request_id;
  if not found then return original_span; end if;
  if original_span is distinct from receipt.original_window then
    raise check_violation using message = 'This time-off history requires HR review. Its original dates do not match the early-return record.';
  end if;
  return receipt.retained_window;
end
$$;

-- Server-owned action availability is shared by the read payload and mutation.
-- The existing whole-future cancellation RPC remains unchanged.
create function private.time_off_cancellation_context(target_request_id uuid, viewer_id uuid, evaluated_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  request_record public.time_off_requests%rowtype;
  employee_record public.employees%rowtype;
  request_time_zone text;
  request_span tstzrange;
  has_return boolean;
  phase text;
  blocked text;
begin
  select * into request_record from public.time_off_requests where id = target_request_id;
  if not found then return null; end if;
  select * into employee_record from public.employees where id = request_record.employee_id;
  request_time_zone := coalesce(nullif(request_record.submission_snapshot ->> 'timeZone', ''), employee_record.time_zone);
  request_span := private.time_off_window(request_record.starts_on, request_record.ends_on,
    request_record.partial_day_start, request_record.partial_day_end, request_time_zone);
  has_return := exists(select 1 from private.time_off_request_early_returns where request_id = target_request_id);
  phase := case when has_return then 'ended_early'
    when evaluated_at < lower(request_span) then 'future'
    when evaluated_at >= upper(request_span) then 'ended' else 'in_progress' end;
  blocked := case
    when viewer_id is null or not public.has_effective_permission('requests.manage') then 'Time-off review permission is required.'
    when not public.has_mfa() then 'MFA is required to change approved time off.'
    when viewer_id = request_record.employee_id then 'Another authorized reviewer must change your approved time off.'
    when request_record.status <> 'approved' then 'Only an approved request can be changed. Refresh its status.'
    when has_return then 'This leave has already ended early. Its original dates and used leave remain in history.'
    when phase = 'ended' then 'This leave has already ended. HR must review historical corrections.'
    when employee_record.employment_type::text = 'salary' or request_record.employment_type_snapshot = 'salary'
      then 'Salary time off requires HR or Payroll reconciliation; no hours or pay have changed.'
    when employee_record.employment_type::text not in ('hourly','flex')
      or employee_record.employment_type is null
      or (phase = 'in_progress' and (request_record.employment_type_snapshot is null
        or request_record.employment_type_snapshot not in ('hourly','flex')))
      then 'HR must review this employment classification before changing leave.'
    when phase = 'in_progress' and (request_record.pay_treatment is distinct from 'unpaid'
      or request_record.request_type is distinct from 'unpaid_time_off')
      then 'Only unpaid hourly or flex leave can end now. HR must reconcile paid or policy-managed leave.'
    when phase = 'in_progress' and nullif(btrim(request_record.submission_snapshot ->> 'timeZone'),'') is null
      then 'This leave has no saved time zone. HR must review it before ending leave early.'
    when exists(select 1 from private.hr_leave_cases where time_off_request_id = target_request_id)
      then 'This request is linked to an HR leave case. HR must reconcile it before changing leave.'
    when exists(select 1 from private.payroll_export_rows export_row
      join private.payroll_export_batches batch on batch.id = export_row.batch_id
      where export_row.employee_id = request_record.employee_id
        and tstzrange(batch.from_date::timestamp at time zone 'America/Denver',
          (batch.through_date + 1)::timestamp at time zone 'America/Denver','[)') && request_span)
      then 'A locked payroll export covers this employee and date range. Payroll must reconcile it before changing leave.'
    else null end;
  return jsonb_build_object('phase',phase,'canEndNow',blocked is null and phase = 'in_progress',
    'canCancel',blocked is null and phase = 'future','blockReason',blocked,
    'startsAt',lower(request_span),'endsAt',upper(request_span),'timeZone',request_time_zone);
end
$$;

create function public.end_approved_time_off_now(target_request_id uuid, target_note text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  reviewer_id uuid := public.current_employee_id();
  subject_employee_id uuid;
  request_record public.time_off_requests%rowtype;
  receipt private.time_off_request_early_returns%rowtype;
  clean_note text := btrim(coalesce(target_note,''));
  cutoff timestamptz;
  context jsonb;
  original_span tstzrange;
begin
  if reviewer_id is null or not public.has_effective_permission('requests.manage') then
    raise insufficient_privilege using message = 'Time-off review permission is required.';
  end if;
  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to change approved time off.';
  end if;
  if clean_note = '' or char_length(clean_note) > 2000 then
    raise check_violation using message = 'Enter an early-return reason of 1 to 2,000 characters.';
  end if;
  select employee_id into subject_employee_id from public.time_off_requests where id = target_request_id;
  if not found then raise no_data_found using message = 'The time-off request could not be found.'; end if;
  perform private.lock_employee_schedule_time_off(subject_employee_id);
  select * into request_record from public.time_off_requests where id = target_request_id for update;
  -- Share-lock the classification used by eligibility until this transaction commits.
  perform 1 from public.employees where id = subject_employee_id for share;
  if reviewer_id = request_record.employee_id then
    raise insufficient_privilege using message = 'Another authorized reviewer must change your approved time off.';
  end if;
  select * into receipt from private.time_off_request_early_returns where request_id = target_request_id;
  if found then
    if receipt.ended_by = reviewer_id and receipt.note = clean_note then return true; end if;
    raise check_violation using message = 'This leave has already ended early. Its original dates and used leave remain in history.';
  end if;
  cutoff := clock_timestamp();
  context := private.time_off_cancellation_context(target_request_id,reviewer_id,cutoff);
  if not coalesce((context ->> 'canEndNow')::boolean,false) then
    raise check_violation using message = coalesce(context ->> 'blockReason',
      'This leave has not started. Use Cancel approved time off for a future request.');
  end if;
  original_span := tstzrange((context ->> 'startsAt')::timestamptz,(context ->> 'endsAt')::timestamptz,'[)');
  insert into private.time_off_request_early_returns
    (request_id,employee_id,ended_by,ended_at,recorded_at,note,time_zone,original_approval,
      original_window,retained_window,released_window)
  values(target_request_id,subject_employee_id,reviewer_id,cutoff,cutoff,clean_note,context ->> 'timeZone',
    jsonb_build_object('decidedBy',request_record.decided_by,'decidedAt',request_record.decided_at,
      'decisionNote',request_record.decision_note,'decisionSnapshot',request_record.decision_snapshot),
    original_span,tstzrange(lower(original_span),cutoff,'[)'),tstzrange(cutoff,upper(original_span),'[)'));
  insert into private.audit_events
    (auth_user_id,employee_id,schema_name,table_name,operation,row_id,old_record,new_record)
  values((select auth.uid()),reviewer_id,'public','time_off_requests','END_APPROVED_NOW',target_request_id::text,
    jsonb_build_object('status',request_record.status,'startsOn',request_record.starts_on,
      'endsOn',request_record.ends_on,'decisionSnapshot',request_record.decision_snapshot),
    jsonb_build_object('status',request_record.status,'endedAt',cutoff,'endedBy',reviewer_id,
      'subjectEmployeeId',subject_employee_id,'note',clean_note,
      'originalStartsAt',lower(original_span),'originalEndsAt',upper(original_span),
      'retainedStartsAt',lower(original_span),'retainedEndsAt',cutoff,
      'releasedStartsAt',cutoff,'releasedEndsAt',upper(original_span)));
  return true;
end
$$;

create function public.get_request_center_payload_v3()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  viewer_id uuid := public.current_employee_id();
  can_manage boolean := public.has_effective_permission('requests.manage');
  evaluated_at timestamptz := statement_timestamp();
  payload jsonb;
  requests jsonb;
begin
  if viewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view requests.';
  end if;
  payload := public.get_request_center_payload_v2();
  select coalesce(jsonb_agg(item.value || jsonb_build_object(
    'earlyReturn',case when receipt.request_id is null then null else jsonb_build_object(
      'endedAt',receipt.ended_at,'recordedAt',receipt.recorded_at,'endedByName',
        coalesce(nullif(reviewer.preferred_name,''),reviewer.first_name)||' '||reviewer.last_name,
      'note',receipt.note,'timeZone',receipt.time_zone) end,
    'cancellationContext',private.time_off_cancellation_context((item.value ->> 'id')::uuid,viewer_id,evaluated_at)
    ) order by item.ordinality),'[]'::jsonb)
  into requests
  from jsonb_array_elements(payload -> 'timeOff') with ordinality item(value,ordinality)
  left join private.time_off_request_early_returns receipt on receipt.request_id = (item.value ->> 'id')::uuid
    and (receipt.employee_id = viewer_id or can_manage)
  left join public.employees reviewer on reviewer.id = receipt.ended_by;
  return jsonb_set(payload,'{timeOff}',requests);
end
$$;

-- Patch only the existing-request overlap expression in each authoritative
-- consumer. Exact-match guards stop deployment if production has drifted; all
-- other code, ACLs, capacity checks, payroll policy and notification behavior stay.
do $migration$
declare entry record; definition text;
begin
  for entry in select * from (values
    ('private.enforce_assignment_capacity_and_overlap()',
      $old$private.time_off_window(
        request.starts_on,
        request.ends_on,
        request.partial_day_start,
        request.partial_day_end,
        coalesce(
          nullif(request.submission_snapshot ->> 'timeZone', ''),
          target_employee_time_zone
        )
      )$old$),
    ('private.salaried_shift_assignment_has_approved_time_off(uuid)',
      $old$private.time_off_window(
        request.starts_on,
        request.ends_on,
        request.partial_day_start,
        request.partial_day_end,
        coalesce(
          nullif(request.submission_snapshot ->> 'timeZone', ''),
          employee.time_zone
        )
      )$old$),
    ('public.submit_time_off_request_v2(text,date,date,time without time zone,time without time zone,date,text)',
      $old$private.time_off_window(
        existing.starts_on,
        existing.ends_on,
        existing.partial_day_start,
        existing.partial_day_end,
        coalesce(
          nullif(existing.submission_snapshot ->> 'timeZone', ''),
          employee_record.time_zone
        )
      )$old$),
    ('public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)',
      $old$private.time_off_window(
              request.starts_on,
              request.ends_on,
              request.partial_day_start,
              request.partial_day_end,
              coalesce(
                nullif(request.submission_snapshot ->> 'timeZone', ''),
                source_assignment.employee_time_zone
              )
            )$old$)
  ) items(signature,old_expression) loop
    definition := pg_get_functiondef(to_regprocedure(entry.signature));
    if definition is null or length(definition)-length(replace(definition,entry.old_expression,'')) <> length(entry.old_expression) then
      raise exception 'Early-return migration requires exactly one known overlap expression in %.',entry.signature;
    end if;
    execute replace(definition,entry.old_expression,'private.effective_time_off_window('
      || case when entry.signature like 'public.submit_%' then 'existing.id,' else 'request.id,' end
      || entry.old_expression || ')');
  end loop;

  definition := pg_get_functiondef('private.get_attendance_events(date,date)'::regprocedure);
  if strpos(definition,$old$greatest(request.starts_on, target_from_date) as operational_date,
      null::timestamptz as starts_at,
      null::timestamptz as ends_at,
      'America/Denver'::text as time_zone,$old$) = 0
    or strpos(definition,$old$from public.time_off_requests request
    join public.employees employee on employee.id = request.employee_id
    where request.status in ('pending', 'approved')
      and daterange(request.starts_on, request.ends_on, '[]') && daterange(target_from_date, target_through_date, '[]')$old$) = 0 then
    raise exception 'Early-return migration requires the known attendance time-off projection.';
  end if;
  definition := replace(definition,$old$greatest(request.starts_on, target_from_date) as operational_date,
      null::timestamptz as starts_at,
      null::timestamptz as ends_at,
      'America/Denver'::text as time_zone,$old$,
    $new$case when early_return.request_id is null then greatest(request.starts_on, target_from_date)
        else greatest((lower(leave_window.span) at time zone early_return.time_zone)::date, target_from_date) end as operational_date,
      case when early_return.request_id is null then null::timestamptz else lower(leave_window.span) end as starts_at,
      case when early_return.request_id is null then null::timestamptz else upper(leave_window.span) end as ends_at,
      case when early_return.request_id is null then 'America/Denver'::text else early_return.time_zone end as time_zone,$new$);
  definition := replace(definition,$old$from public.time_off_requests request
    join public.employees employee on employee.id = request.employee_id
    where request.status in ('pending', 'approved')
      and daterange(request.starts_on, request.ends_on, '[]') && daterange(target_from_date, target_through_date, '[]')$old$,
    $new$from public.time_off_requests request
    join public.employees employee on employee.id = request.employee_id
    left join private.time_off_request_early_returns early_return on early_return.request_id = request.id
    cross join lateral (
      select case when early_return.request_id is null then null::tstzrange
        else private.effective_time_off_window(request.id,private.time_off_window(
          request.starts_on,request.ends_on,request.partial_day_start,request.partial_day_end,
          coalesce(nullif(request.submission_snapshot ->> 'timeZone',''),employee.time_zone))) end as span
    ) leave_window
    where request.status in ('pending', 'approved')
      and ((early_return.request_id is null
          and daterange(request.starts_on, request.ends_on, '[]') && daterange(target_from_date, target_through_date, '[]'))
        or (early_return.request_id is not null
          and leave_window.span && tstzrange(target_from_date::timestamp at time zone early_return.time_zone,
            (target_through_date + 1)::timestamp at time zone early_return.time_zone,'[)')))$new$);
  execute definition;
end
$migration$;

revoke all on function private.effective_time_off_window(uuid,tstzrange) from public,anon,authenticated,service_role;
revoke all on function private.time_off_cancellation_context(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.end_approved_time_off_now(uuid,text) from public,anon,service_role;
revoke all on function public.get_request_center_payload_v3() from public,anon,service_role;
grant execute on function public.end_approved_time_off_now(uuid,text) to authenticated;
grant execute on function public.get_request_center_payload_v3() to authenticated;
comment on function public.end_approved_time_off_now(uuid,text) is
  'Independent MFA review ends started unpaid hourly/flex leave from the server clock only. Retains original dates, approval and used prefix; changes no payroll, balances, punches or schedules.';
comment on table private.time_off_request_early_returns is
  'Append-only evidence of a forward-only end to approved unpaid hourly/flex leave; not a payroll entitlement adjustment.';
commit;
