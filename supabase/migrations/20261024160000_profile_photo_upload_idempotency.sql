begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists private.employee_photo_upload_operations (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  expected_photo_path text,
  photo_path text not null,
  photo_checksum text not null check (photo_checksum ~ '^[a-f0-9]{64}$'),
  request_id text,
  status text not null default 'prepared' check (status in ('prepared', 'completed', 'conflict')),
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (employee_id, photo_path)
);

alter table private.employee_photo_upload_operations enable row level security;
revoke all on table private.employee_photo_upload_operations from public, anon, authenticated;

-- Persist the candidate and its original predecessor before storage begins.
-- A restarted Worker can therefore recover both the deterministic object and
-- the old photo that becomes safe to remove only after completion is proven.
create or replace function public.service_prepare_employee_photo_upload(
  target_employee_id uuid,
  target_expected_photo_path text,
  target_photo_path text,
  target_photo_checksum text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  operation_record private.employee_photo_upload_operations%rowtype;
  normalized_checksum text := lower(btrim(coalesce(target_photo_checksum, '')));
  normalized_expected_path text := nullif(btrim(coalesce(target_expected_photo_path, '')), '');
  normalized_path text := btrim(coalesce(target_photo_path, ''));
begin
  if target_employee_id is null then
    raise check_violation using message = 'The employee identifier is required.';
  end if;
  if normalized_checksum !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The profile photo checksum is invalid.';
  end if;
  if normalized_path not in (
    target_employee_id::text || '/' || normalized_checksum || '.jpg',
    target_employee_id::text || '/' || normalized_checksum || '.png'
  ) then
    raise check_violation using message = 'The profile photo storage identity is invalid.';
  end if;

  select operation.*
  into operation_record
  from private.employee_photo_upload_operations operation
  where operation.employee_id = target_employee_id
    and operation.photo_path = normalized_path
  for update;
  if found then
    if operation_record.photo_checksum <> normalized_checksum then
      raise check_violation using message = 'The profile photo operation checksum changed.';
    end if;
    select employee.* into employee_record
    from public.employees employee
    where employee.id = target_employee_id;
    return jsonb_build_object(
      'state', operation_record.status,
      'currentPath', employee_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', true
    );
  end if;

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The employee was not found.';
  end if;

  -- A concurrent prepare may have committed while this transaction waited on
  -- the employee row lock. Re-read before inserting the unique operation.
  select operation.*
  into operation_record
  from private.employee_photo_upload_operations operation
  where operation.employee_id = target_employee_id
    and operation.photo_path = normalized_path
  for update;
  if found then
    return jsonb_build_object(
      'state', operation_record.status,
      'currentPath', employee_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', true
    );
  end if;

  insert into private.employee_photo_upload_operations (
    employee_id, expected_photo_path, photo_path, photo_checksum, request_id, status, completed_at
  ) values (
    target_employee_id,
    normalized_expected_path,
    normalized_path,
    normalized_checksum,
    nullif(left(btrim(coalesce(target_request_id, '')), 240), ''),
    case
      when employee_record.photo_path = normalized_path then 'completed'
      when employee_record.photo_path is distinct from normalized_expected_path then 'conflict'
      else 'prepared'
    end,
    case when employee_record.photo_path = normalized_path then clock_timestamp() else null end
  )
  returning * into operation_record;

  return jsonb_build_object(
    'state', operation_record.status,
    'currentPath', employee_record.photo_path,
    'previousPath', operation_record.expected_photo_path,
    'idempotent', false
  );
end
$$;

-- Complete with a compare-and-set against the predecessor preserved by the
-- prepare step. Row locking prevents an older retry from overwriting a newer
-- photo and makes an explicit conflict safe to clean up.
create or replace function public.service_complete_employee_photo_upload(
  target_employee_id uuid,
  target_expected_photo_path text,
  target_photo_path text,
  target_photo_checksum text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  operation_record private.employee_photo_upload_operations%rowtype;
  normalized_checksum text := lower(btrim(coalesce(target_photo_checksum, '')));
  normalized_expected_path text := nullif(btrim(coalesce(target_expected_photo_path, '')), '');
  normalized_path text := btrim(coalesce(target_photo_path, ''));
begin
  select operation.*
  into operation_record
  from private.employee_photo_upload_operations operation
  where operation.employee_id = target_employee_id
    and operation.photo_path = normalized_path
    and operation.photo_checksum = normalized_checksum
  for update;
  if not found then
    raise no_data_found using message = 'The prepared profile photo upload was not found.';
  end if;
  if operation_record.expected_photo_path is distinct from normalized_expected_path then
    raise check_violation using message = 'The profile photo predecessor does not match its prepared operation.';
  end if;

  select employee.*
  into employee_record
  from public.employees employee
  where employee.id = target_employee_id
  for update;
  if not found then
    raise no_data_found using message = 'The employee was not found.';
  end if;

  if employee_record.photo_path = normalized_path then
    update private.employee_photo_upload_operations operation
    set status = 'completed', completed_at = coalesce(operation.completed_at, clock_timestamp())
    where operation.id = operation_record.id;
    return jsonb_build_object(
      'state', 'completed',
      'currentPath', employee_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', true
    );
  end if;

  if employee_record.photo_path is distinct from operation_record.expected_photo_path then
    update private.employee_photo_upload_operations operation
    set status = 'conflict', completed_at = clock_timestamp()
    where operation.id = operation_record.id;
    return jsonb_build_object(
      'state', 'conflict',
      'currentPath', employee_record.photo_path,
      'previousPath', operation_record.expected_photo_path,
      'idempotent', false
    );
  end if;

  update public.employees employee
  set photo_path = normalized_path, updated_at = clock_timestamp()
  where employee.id = target_employee_id;

  update private.employee_photo_upload_operations operation
  set status = 'completed', completed_at = clock_timestamp()
  where operation.id = operation_record.id;

  insert into private.audit_events (
    employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    target_employee_id, 'public', 'employees', 'self_photo_update', target_employee_id::text,
    jsonb_build_object('hasPhoto', employee_record.photo_path is not null),
    jsonb_build_object(
      'hasPhoto', true,
      'checksum', normalized_checksum,
      'requestId', coalesce(
        nullif(left(btrim(coalesce(target_request_id, '')), 240), ''),
        operation_record.request_id
      )
    )
  );

  return jsonb_build_object(
    'state', 'completed',
    'currentPath', normalized_path,
    'previousPath', operation_record.expected_photo_path,
    'idempotent', false
  );
end
$$;

revoke all on function public.service_prepare_employee_photo_upload(uuid, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.service_complete_employee_photo_upload(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.service_prepare_employee_photo_upload(uuid, text, text, text, text)
  to service_role;
grant execute on function public.service_complete_employee_photo_upload(uuid, text, text, text, text)
  to service_role;

comment on function public.service_prepare_employee_photo_upload(uuid, text, text, text, text) is
  'Persists the deterministic profile-photo candidate and its predecessor before storage so retries can reconcile after Worker restart.';
comment on function public.service_complete_employee_photo_upload(uuid, text, text, text, text) is
  'Atomically installs a prepared integrity-addressed profile photo only while its original predecessor remains authoritative.';

commit;
