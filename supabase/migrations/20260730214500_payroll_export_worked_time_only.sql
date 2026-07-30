begin;

create or replace function public.create_payroll_export_batch(
  target_from_date date,
  target_through_date date,
  target_note text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  clean_note text := nullif(btrim(coalesce(target_note, '')), '');
  review_payload jsonb;
  review_summary jsonb;
  review_rows jsonb;
  worked_rows jsonb;
  export_rows jsonb;
  export_review_payload jsonb;
  rows_total integer;
  ready_total integer;
  exception_total integer;
  pending_correction_total integer;
  gross_minutes_total integer;
  paid_minutes_total integer;
  regular_minutes_total integer;
  overtime_minutes_total integer;
  export_digest text;
  existing_export private.payroll_export_batches%rowtype;
  inserted_export private.payroll_export_batches%rowtype;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'Payroll export permission with MFA is required to lock payroll exports.';
  end if;

  if not (
    public.is_supervisor_or_admin()
    or public.has_effective_permission('time.export_payroll')
  ) then
    raise insufficient_privilege using message = 'Payroll export permission with MFA is required to lock payroll exports.';
  end if;

  if clean_note is null then
    raise check_violation using message = 'A short export note is required.';
  end if;

  if target_from_date is null or target_through_date is null or target_through_date < target_from_date then
    raise check_violation using message = 'A valid date range is required.';
  end if;

  if target_through_date - target_from_date > 45 then
    raise check_violation using message = 'Payroll export ranges are limited to 46 days.';
  end if;

  perform pg_advisory_xact_lock(hashtext('payroll-export:' || target_from_date::text || ':' || target_through_date::text));

  review_payload := public.get_timekeeping_review(target_from_date, target_through_date);
  review_rows := coalesce(review_payload -> 'rows', '[]'::jsonb);
  pending_correction_total := coalesce((review_payload -> 'summary' ->> 'pendingCorrectionCount')::integer, 0);

  select coalesce(jsonb_agg(row_payload.row_value order by row_payload.row_number), '[]'::jsonb)
  into worked_rows
  from jsonb_array_elements(review_rows) with ordinality as row_payload(row_value, row_number)
  where row_payload.row_value ->> 'rowKind' = 'time_event';

  rows_total := jsonb_array_length(worked_rows);

  select
    count(*) filter (
      where coalesce((row_payload.row_value ->> 'payrollReady')::boolean, false)
        and jsonb_array_length(coalesce(row_payload.row_value -> 'exceptionCodes', '[]'::jsonb)) = 0
        and nullif(row_payload.row_value ->> 'firstClockIn', '') is not null
        and nullif(row_payload.row_value ->> 'lastClockOut', '') is not null
        and coalesce((row_payload.row_value ->> 'paidMinutes')::integer, 0) > 0
    )::integer,
    count(*) filter (
      where not coalesce((row_payload.row_value ->> 'payrollReady')::boolean, false)
        or jsonb_array_length(coalesce(row_payload.row_value -> 'exceptionCodes', '[]'::jsonb)) > 0
        or nullif(row_payload.row_value ->> 'firstClockIn', '') is null
        or nullif(row_payload.row_value ->> 'lastClockOut', '') is null
        or coalesce((row_payload.row_value ->> 'paidMinutes')::integer, 0) <= 0
    )::integer
  into ready_total, exception_total
  from jsonb_array_elements(worked_rows) as row_payload(row_value);

  if rows_total = 0 then
    raise check_violation using message = 'There are no completed SygShift clock-in/out records in this range to export.';
  end if;

  if pending_correction_total <> 0 then
    raise check_violation using message = 'Payroll cannot be locked until every pending correction is resolved.';
  end if;

  if ready_total <> rows_total or exception_total <> 0 then
    raise check_violation using message = 'Payroll cannot be locked until every worked-time row is complete, clean, and ready.';
  end if;

  select coalesce(jsonb_agg(row_payload.row_value order by row_payload.row_number), '[]'::jsonb)
  into export_rows
  from jsonb_array_elements(worked_rows) with ordinality as row_payload(row_value, row_number)
  where coalesce((row_payload.row_value ->> 'payrollReady')::boolean, false)
    and jsonb_array_length(coalesce(row_payload.row_value -> 'exceptionCodes', '[]'::jsonb)) = 0
    and nullif(row_payload.row_value ->> 'firstClockIn', '') is not null
    and nullif(row_payload.row_value ->> 'lastClockOut', '') is not null
    and coalesce((row_payload.row_value ->> 'paidMinutes')::integer, 0) > 0;

  select
    coalesce(sum((row_payload.row_value ->> 'grossMinutes')::integer), 0)::integer,
    coalesce(sum((row_payload.row_value ->> 'paidMinutes')::integer), 0)::integer,
    coalesce(sum((row_payload.row_value ->> 'regularMinutes')::integer), 0)::integer,
    coalesce(sum((row_payload.row_value ->> 'overtimeMinutes')::integer), 0)::integer
  into
    gross_minutes_total,
    paid_minutes_total,
    regular_minutes_total,
    overtime_minutes_total
  from jsonb_array_elements(export_rows) as row_payload(row_value);

  review_summary := jsonb_build_object(
    'rowCount', rows_total,
    'readyCount', ready_total,
    'exceptionCount', exception_total,
    'pendingCorrectionCount', pending_correction_total,
    'grossMinutes', gross_minutes_total,
    'paidMinutes', paid_minutes_total,
    'regularMinutes', regular_minutes_total,
    'overtimeMinutes', overtime_minutes_total,
    'timeOffMinutes', 0,
    'salaryDefaultMinutes', 0
  );

  export_review_payload := review_payload || jsonb_build_object(
    'summary', review_summary,
    'rows', export_rows
  );

  export_digest := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'fromDate', target_from_date,
          'throughDate', target_through_date,
          'rows', export_rows
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  select *
    into existing_export
  from private.payroll_export_batches batch
  where batch.from_date = target_from_date
    and batch.through_date = target_through_date
    and batch.digest = export_digest
  order by batch.created_at desc
  limit 1;

  if existing_export.id is not null then
    return jsonb_build_object(
      'id', existing_export.id,
      'fromDate', existing_export.from_date,
      'throughDate', existing_export.through_date,
      'createdAt', existing_export.created_at,
      'createdBy', existing_export.created_by,
      'createdByName', (
        select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
        from public.employees employee
        where employee.id = existing_export.created_by
      ),
      'rowCount', existing_export.row_count,
      'grossMinutes', existing_export.gross_minutes,
      'paidMinutes', existing_export.paid_minutes,
      'digest', existing_export.digest,
      'note', existing_export.note,
      'duplicate', true
    );
  end if;

  insert into private.payroll_export_batches (
    from_date,
    through_date,
    created_by,
    row_count,
    gross_minutes,
    paid_minutes,
    digest,
    note,
    review_payload
  ) values (
    target_from_date,
    target_through_date,
    reviewer_id,
    rows_total,
    gross_minutes_total,
    paid_minutes_total,
    export_digest,
    clean_note,
    export_review_payload
  )
  returning * into inserted_export;

  insert into private.payroll_export_rows (
    batch_id,
    row_number,
    employee_id,
    shift_id,
    operational_date,
    row_payload,
    gross_minutes,
    paid_minutes,
    exception_codes,
    payroll_ready
  )
  select
    inserted_export.id,
    row_with_number.row_number::integer,
    (row_with_number.row_payload ->> 'employeeId')::uuid,
    nullif(row_with_number.row_payload ->> 'shiftId', '')::uuid,
    (row_with_number.row_payload ->> 'operationalDate')::date,
    row_with_number.row_payload,
    (row_with_number.row_payload ->> 'grossMinutes')::integer,
    (row_with_number.row_payload ->> 'paidMinutes')::integer,
    coalesce(
      array(
        select jsonb_array_elements_text(coalesce(row_with_number.row_payload -> 'exceptionCodes', '[]'::jsonb))
      ),
      '{}'::text[]
    ),
    (row_with_number.row_payload ->> 'payrollReady')::boolean
  from jsonb_array_elements(export_rows) with ordinality as row_with_number(row_payload, row_number);

  return jsonb_build_object(
    'id', inserted_export.id,
    'fromDate', inserted_export.from_date,
    'throughDate', inserted_export.through_date,
    'createdAt', inserted_export.created_at,
    'createdBy', inserted_export.created_by,
    'createdByName', (
      select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
      from public.employees employee
      where employee.id = inserted_export.created_by
    ),
    'rowCount', inserted_export.row_count,
    'grossMinutes', inserted_export.gross_minutes,
    'paidMinutes', inserted_export.paid_minutes,
    'digest', inserted_export.digest,
    'note', inserted_export.note,
    'duplicate', false
  );
end
$$;

create or replace function public.get_payroll_export_batch_detail(
  target_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  export_batch private.payroll_export_batches%rowtype;
  export_rows jsonb;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'Payroll export permission with MFA is required to download locked payroll exports.';
  end if;

  if not (
    public.is_supervisor_or_admin()
    or public.has_effective_permission('time.export_payroll')
  ) then
    raise insufficient_privilege using message = 'Payroll export permission with MFA is required to download locked payroll exports.';
  end if;

  if target_batch_id is null then
    raise check_violation using message = 'A payroll export batch is required.';
  end if;

  select *
    into export_batch
  from private.payroll_export_batches batch
  where batch.id = target_batch_id;

  if export_batch.id is null then
    raise no_data_found using message = 'The selected payroll export batch was not found.';
  end if;

  select coalesce(jsonb_agg(row_record.row_payload order by row_record.row_number), '[]'::jsonb)
  into export_rows
  from private.payroll_export_rows row_record
  where row_record.batch_id = export_batch.id
    and row_record.row_payload ->> 'rowKind' = 'time_event'
    and nullif(row_record.row_payload ->> 'firstClockIn', '') is not null
    and nullif(row_record.row_payload ->> 'lastClockOut', '') is not null;

  return jsonb_build_object(
    'batch', jsonb_build_object(
      'id', export_batch.id,
      'fromDate', export_batch.from_date,
      'throughDate', export_batch.through_date,
      'createdAt', export_batch.created_at,
      'createdBy', export_batch.created_by,
      'createdByName', (
        select btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name)
        from public.employees employee
        where employee.id = export_batch.created_by
      ),
      'rowCount', export_batch.row_count,
      'grossMinutes', export_batch.gross_minutes,
      'paidMinutes', export_batch.paid_minutes,
      'digest', export_batch.digest,
      'note', export_batch.note
    ),
    'rows', export_rows
  );
end
$$;

revoke all on function public.create_payroll_export_batch(date, date, text) from public, anon;
revoke all on function public.get_payroll_export_batch_detail(uuid) from public, anon;

grant execute on function public.create_payroll_export_batch(date, date, text) to authenticated;
grant execute on function public.get_payroll_export_batch_detail(uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
