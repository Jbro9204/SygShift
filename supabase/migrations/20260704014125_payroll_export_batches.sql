begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists private.payroll_export_batches (
  id uuid primary key default gen_random_uuid(),
  from_date date not null,
  through_date date not null,
  reviewed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid not null references public.employees(id) on delete restrict,
  row_count integer not null,
  gross_minutes integer not null,
  paid_minutes integer not null,
  digest text not null,
  note text not null,
  review_payload jsonb not null,
  constraint payroll_export_batches_range_valid check (through_date >= from_date),
  constraint payroll_export_batches_row_count_positive check (row_count > 0),
  constraint payroll_export_batches_minutes_nonnegative check (gross_minutes >= 0 and paid_minutes >= 0),
  constraint payroll_export_batches_digest_format check (digest ~ '^[a-f0-9]{64}$'),
  constraint payroll_export_batches_note_present check (btrim(note) <> ''),
  constraint payroll_export_batches_review_object check (jsonb_typeof(review_payload) = 'object'),
  constraint payroll_export_batches_unique_snapshot unique (from_date, through_date, digest)
);

create table if not exists private.payroll_export_rows (
  id bigint generated always as identity primary key,
  batch_id uuid not null references private.payroll_export_batches(id) on delete restrict,
  row_number integer not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  operational_date date not null,
  row_payload jsonb not null,
  gross_minutes integer not null,
  paid_minutes integer not null,
  exception_codes text[] not null default '{}',
  payroll_ready boolean not null,
  constraint payroll_export_rows_row_number_positive check (row_number > 0),
  constraint payroll_export_rows_minutes_nonnegative check (gross_minutes >= 0 and paid_minutes >= 0),
  constraint payroll_export_rows_payload_object check (jsonb_typeof(row_payload) = 'object'),
  constraint payroll_export_rows_ready_only check (payroll_ready),
  constraint payroll_export_rows_unique_row unique (batch_id, row_number)
);

create index if not exists payroll_export_batches_created_at_idx
  on private.payroll_export_batches (created_at desc);

create index if not exists payroll_export_batches_created_by_fk_idx
  on private.payroll_export_batches (created_by);

create index if not exists payroll_export_rows_batch_id_fk_idx
  on private.payroll_export_rows (batch_id);

create index if not exists payroll_export_rows_employee_id_fk_idx
  on private.payroll_export_rows (employee_id);

create index if not exists payroll_export_rows_shift_id_fk_idx
  on private.payroll_export_rows (shift_id);

drop trigger if exists payroll_export_batches_append_only on private.payroll_export_batches;
create trigger payroll_export_batches_append_only
before update or delete on private.payroll_export_batches
for each row execute function private.prevent_append_only_change();

drop trigger if exists payroll_export_rows_append_only on private.payroll_export_rows;
create trigger payroll_export_rows_append_only
before update or delete on private.payroll_export_rows
for each row execute function private.prevent_append_only_change();

drop trigger if exists payroll_export_batches_audit on private.payroll_export_batches;
create trigger payroll_export_batches_audit
after insert on private.payroll_export_batches
for each row execute function private.write_audit_event();

drop trigger if exists payroll_export_rows_audit on private.payroll_export_rows;
create trigger payroll_export_rows_audit
after insert on private.payroll_export_rows
for each row execute function private.write_audit_event();

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
  rows_total integer;
  ready_total integer;
  exception_total integer;
  pending_correction_total integer;
  gross_minutes_total integer;
  paid_minutes_total integer;
  export_digest text;
  existing_export private.payroll_export_batches%rowtype;
  inserted_export private.payroll_export_batches%rowtype;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required to lock payroll exports.';
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
  review_summary := review_payload -> 'summary';
  review_rows := coalesce(review_payload -> 'rows', '[]'::jsonb);

  rows_total := coalesce((review_summary ->> 'rowCount')::integer, 0);
  ready_total := coalesce((review_summary ->> 'readyCount')::integer, 0);
  exception_total := coalesce((review_summary ->> 'exceptionCount')::integer, 0);
  pending_correction_total := coalesce((review_summary ->> 'pendingCorrectionCount')::integer, 0);
  gross_minutes_total := coalesce((review_summary ->> 'grossMinutes')::integer, 0);
  paid_minutes_total := coalesce((review_summary ->> 'paidMinutes')::integer, 0);

  if rows_total = 0 then
    raise check_violation using message = 'There are no time records in this range to export.';
  end if;

  if ready_total <> rows_total or exception_total <> 0 or pending_correction_total <> 0 then
    raise check_violation using message = 'Payroll cannot be locked until every row is ready and all corrections are resolved.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(review_rows) as row_payload(row_value)
    where coalesce((row_value ->> 'payrollReady')::boolean, false) = false
      or jsonb_array_length(coalesce(row_value -> 'exceptionCodes', '[]'::jsonb)) > 0
  ) then
    raise check_violation using message = 'Payroll export rows must be clean before locking.';
  end if;

  export_digest := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          'fromDate', target_from_date,
          'throughDate', target_through_date,
          'rows', review_rows
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
    review_payload
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
  from jsonb_array_elements(review_rows) with ordinality as row_with_number(row_payload, row_number);

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

create or replace function public.get_payroll_export_history(
  target_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  reviewer_id uuid := private.current_employee_id();
  safe_limit integer := least(greatest(coalesce(target_limit, 20), 1), 50);
  export_history jsonb;
begin
  if reviewer_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_supervisor_or_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Supervisor or Admin access with MFA is required to view payroll export history.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', batch.id,
    'fromDate', batch.from_date,
    'throughDate', batch.through_date,
    'createdAt', batch.created_at,
    'createdBy', batch.created_by,
    'createdByName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'rowCount', batch.row_count,
    'grossMinutes', batch.gross_minutes,
    'paidMinutes', batch.paid_minutes,
    'digest', batch.digest,
    'note', batch.note
  ) order by batch.created_at desc), '[]'::jsonb)
  into export_history
  from (
    select *
    from private.payroll_export_batches
    order by created_at desc
    limit safe_limit
  ) batch
  join public.employees employee on employee.id = batch.created_by;

  return export_history;
end
$$;

revoke all on function public.create_payroll_export_batch(date, date, text) from public, anon;
revoke all on function public.get_payroll_export_history(integer) from public, anon;

grant execute on function public.create_payroll_export_batch(date, date, text) to authenticated;
grant execute on function public.get_payroll_export_history(integer) to authenticated;

commit;
