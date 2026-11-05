begin;
set local lock_timeout = '5s';

-- Cancellation is an additional audited lifecycle action, not an edit of the
-- immutable submission or original approval. No entitlement or payroll credit
-- is created or reversed by this workflow.
create table private.time_off_request_cancellations (
  request_id uuid primary key references public.time_off_requests(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  canceled_by uuid not null references public.employees(id) on delete restrict,
  canceled_at timestamptz not null default clock_timestamp(),
  note text not null check (btrim(note) <> '' and char_length(note) <= 2000),
  original_approval jsonb not null check (jsonb_typeof(original_approval) = 'object'),
  request_window tstzrange not null check (not isempty(request_window))
);
create index time_off_request_cancellations_employee_idx on private.time_off_request_cancellations(employee_id);
create index time_off_request_cancellations_reviewer_idx on private.time_off_request_cancellations(canceled_by);
alter table private.time_off_request_cancellations enable row level security;
alter table private.time_off_request_cancellations force row level security;
revoke all on table private.time_off_request_cancellations from public, anon, authenticated, service_role;
create trigger time_off_request_cancellations_append_only
before update or delete on private.time_off_request_cancellations
for each row execute function private.prevent_append_only_change();

create function public.cancel_approved_time_off_request(
  target_request_id uuid,
  target_note text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := public.current_employee_id();
  subject_employee_id uuid;
  request_record public.time_off_requests%rowtype;
  cancellation_record private.time_off_request_cancellations%rowtype;
  request_time_zone text;
  current_employment_type text;
  request_span tstzrange;
  clean_note text := btrim(coalesce(target_note, ''));
  cancellation_time timestamptz;
begin
  if reviewer_id is null or not public.has_effective_permission('requests.manage') then
    raise insufficient_privilege using message = 'Time-off review permission is required.';
  end if;
  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required to cancel approved time off.';
  end if;
  if clean_note = '' or char_length(clean_note) > 2000 then
    raise check_violation using message = 'Enter a cancellation reason of 1 to 2,000 characters.';
  end if;

  select request.employee_id into subject_employee_id
  from public.time_off_requests request where request.id = target_request_id;
  if not found then
    raise no_data_found using message = 'The time-off request could not be found.';
  end if;
  perform private.lock_employee_schedule_time_off(subject_employee_id);
  select * into request_record from public.time_off_requests request
  where request.id = target_request_id for update;
  if reviewer_id = request_record.employee_id then
    raise insufficient_privilege using message = 'Another authorized reviewer must cancel your approved time off.';
  end if;
  if request_record.status = 'canceled' then
    select * into cancellation_record from private.time_off_request_cancellations cancellation
    where cancellation.request_id = target_request_id;
    if found and cancellation_record.canceled_by = reviewer_id and cancellation_record.note = clean_note then
      return true;
    end if;
  end if;
  if request_record.status <> 'approved' then
    raise check_violation using message = 'Only an approved request can be canceled. Refresh its status.';
  end if;

  select coalesce(nullif(request_record.submission_snapshot ->> 'timeZone', ''), employee.time_zone),
    employee.employment_type::text
  into request_time_zone, current_employment_type
  from public.employees employee where employee.id = request_record.employee_id for share;
  if current_employment_type = 'salary' or request_record.employment_type_snapshot = 'salary' then
    raise check_violation using message = 'Salary time off requires Payroll reconciliation before cancellation because it can affect salary-default hours. Contact HR or Payroll; no hours or pay have changed.';
  end if;
  if current_employment_type is null or current_employment_type not in ('hourly', 'flex') then
    raise check_violation using message = 'HR must review this employment classification before cancellation.';
  end if;
  request_span := private.time_off_window(request_record.starts_on, request_record.ends_on,
    request_record.partial_day_start, request_record.partial_day_end, request_time_zone);
  if lower(request_span) <= clock_timestamp() then
    raise check_violation using message = 'This time off has already started. HR must reconcile any used leave before it can be changed.';
  end if;
  if exists (select 1 from private.hr_leave_cases leave_case where leave_case.time_off_request_id = target_request_id) then
    raise check_violation using message = 'This request is linked to an HR leave case. HR must reconcile the case and any authorized treatment before cancellation.';
  end if;
  if exists (
    select 1 from private.payroll_export_rows export_row
    join private.payroll_export_batches batch on batch.id = export_row.batch_id
    where export_row.employee_id = request_record.employee_id
      and tstzrange(batch.from_date::timestamp at time zone 'America/Denver',
        (batch.through_date + 1)::timestamp at time zone 'America/Denver', '[)') && request_span
  ) then
    raise check_violation using message = 'A locked payroll export covers this employee and date range. Payroll must reconcile it before cancellation.';
  end if;

  cancellation_time := clock_timestamp();
  insert into private.time_off_request_cancellations
    (request_id, employee_id, canceled_by, canceled_at, note, original_approval, request_window)
  values (target_request_id, request_record.employee_id, reviewer_id, cancellation_time, clean_note,
    jsonb_build_object('decidedBy',request_record.decided_by,'decidedAt',request_record.decided_at,
      'decisionNote',request_record.decision_note,'decisionSnapshot',request_record.decision_snapshot), request_span);
  update public.time_off_requests set status = 'canceled' where id = target_request_id;
  insert into private.audit_events
    (auth_user_id,employee_id,schema_name,table_name,operation,row_id,old_record,new_record)
  values ((select auth.uid()),reviewer_id,'public','time_off_requests','CANCEL_APPROVED',target_request_id::text,
    jsonb_build_object('status','approved','decisionSnapshot',request_record.decision_snapshot),
    jsonb_build_object('status','canceled','canceledAt',cancellation_time,'canceledBy',reviewer_id,
      'subjectEmployeeId',request_record.employee_id,'note',clean_note,
      'requestWindowStartsAt',lower(request_span),'requestWindowEndsAt',upper(request_span)));
  return true;
end
$$;

-- Reuse the existing bounded permission/ownership-scoped read exactly once.
-- Only cancellation evidence for rows already visible in that payload is added.
create function public.get_request_center_payload_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := public.current_employee_id();
  can_manage boolean := public.has_effective_permission('requests.manage');
  payload jsonb;
  requests jsonb;
begin
  if viewer_id is null then
    raise insufficient_privilege using message = 'An active SygShift account is required to view requests.';
  end if;
  payload := public.get_request_center_payload();
  select coalesce(jsonb_agg(item.value || jsonb_build_object('cancellation',
    case when cancellation.request_id is null then null else jsonb_build_object(
      'canceledAt',cancellation.canceled_at,'canceledByName',
        coalesce(nullif(employee.preferred_name,''),employee.first_name)||' '||employee.last_name,
      'note',cancellation.note) end) order by item.ordinality),'[]'::jsonb)
  into requests
  from jsonb_array_elements(payload -> 'timeOff') with ordinality item(value,ordinality)
  left join private.time_off_request_cancellations cancellation on cancellation.request_id = (item.value ->> 'id')::uuid
    and (cancellation.employee_id = viewer_id or can_manage)
  left join public.employees employee on employee.id = cancellation.canceled_by;
  return jsonb_set(payload,'{timeOff}',requests);
end
$$;

revoke all on function public.cancel_approved_time_off_request(uuid,text) from public,anon,service_role;
revoke all on function public.get_request_center_payload_v2() from public,anon,service_role;
grant execute on function public.cancel_approved_time_off_request(uuid,text) to authenticated;
grant execute on function public.get_request_center_payload_v2() to authenticated;
comment on function public.cancel_approved_time_off_request(uuid,text) is
  'Independent MFA management cancellation of future unused hourly/flex time off only; original approval, HR leave, payroll, balances, schedules and punches are preserved.';
commit;
