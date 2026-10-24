begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Bind the account and recipient before a recovery link can be generated or
-- an email provider can be called.  The email dispatch fence proves provider
-- acceptance; this operation fence proves which login that accepted message
-- was actually prepared for.
create table if not exists private.admin_password_reset_operations (
  id uuid primary key,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null,
  reset_by uuid not null references public.employees(id) on delete restrict,
  recipient_email text not null,
  recipient_email_masked text not null,
  state text not null default 'prepared',
  prepared_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint admin_password_reset_operations_recipient_check
    check (
      recipient_email = lower(btrim(recipient_email))
      and length(recipient_email) between 3 and 320
      and recipient_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
  constraint admin_password_reset_operations_mask_check
    check (btrim(recipient_email_masked) <> '' and length(recipient_email_masked) <= 320),
  constraint admin_password_reset_operations_state_check
    check (state in ('prepared', 'completed')),
  constraint admin_password_reset_operations_completion_check
    check (
      (state = 'prepared' and completed_at is null)
      or (state = 'completed' and completed_at is not null)
    )
);

alter table private.admin_password_reset_operations enable row level security;

revoke all on table private.admin_password_reset_operations
  from public, anon, authenticated, service_role;

create or replace function private.mask_admin_password_reset_recipient(target_recipient text)
returns text
language plpgsql
immutable
security definer
set search_path = ''
as $$
declare
  clean_recipient text := lower(btrim(coalesce(target_recipient, '')));
  local_part text;
  domain_part text;
  visible_length integer;
begin
  if length(clean_recipient) < 3
    or length(clean_recipient) > 320
    or clean_recipient !~ '^[^@[:space:]]+@[^@[:space:]]+$'
  then
    raise check_violation using message = 'A valid password-reset recipient is required.';
  end if;
  local_part := split_part(clean_recipient, '@', 1);
  domain_part := split_part(clean_recipient, '@', 2);
  visible_length := least(2, length(local_part));
  return left(local_part, visible_length)
    || repeat('*', greatest(3, length(local_part) - visible_length))
    || '@' || domain_part;
end
$$;

revoke all on function private.mask_admin_password_reset_recipient(text)
  from public, anon, authenticated, service_role;

create or replace function private.admin_password_reset_operation_payload(
  operation private.admin_password_reset_operations
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'recorded', operation.state = 'completed',
    'operationId', operation.id,
    'employeeId', operation.employee_id,
    'authUserId', operation.auth_user_id,
    'actorEmployeeId', operation.reset_by,
    'deliveryEmailMasked', operation.recipient_email_masked,
    'state', operation.state,
    'preparedAt', operation.prepared_at,
    'completedAt', operation.completed_at
  )
$$;

revoke all on function private.admin_password_reset_operation_payload(private.admin_password_reset_operations)
  from public, anon, authenticated, service_role;

create or replace function private.require_admin_password_reset_operation_identity(
  operation private.admin_password_reset_operations,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_recipient_email text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if operation.reset_by is distinct from target_actor_employee_id
    or operation.employee_id is distinct from target_employee_id
    or operation.auth_user_id is distinct from target_auth_user_id
    or operation.recipient_email is distinct from lower(btrim(coalesce(target_recipient_email, '')))
  then
    raise check_violation using message = 'The password-reset operation identity does not match.';
  end if;
end
$$;

revoke all on function private.require_admin_password_reset_operation_identity(
  private.admin_password_reset_operations, uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

create or replace function public.service_prepare_employee_password_reset_operation(
  target_operation_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_recipient_email text,
  target_actor_employee_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_recipient text := lower(btrim(coalesce(target_recipient_email, '')));
  current_auth_user_id uuid;
  operation private.admin_password_reset_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_operation_id is null
    or target_employee_id is null
    or target_auth_user_id is null
    or target_actor_employee_id is null
  then
    raise check_violation using message = 'A complete password-reset operation identity is required.';
  end if;
  -- Validate and canonicalize before persisting the immutable recipient.
  perform private.mask_admin_password_reset_recipient(clean_recipient);

  if not exists (
    select 1 from public.employees employee
    where employee.id = target_actor_employee_id
      and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The reset operator was not an active employee.';
  end if;

  -- The account row is locked while the operation is first established.  It
  -- is checked again at completion because the external provider call cannot
  -- participate in this transaction.
  select account.auth_user_id into current_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_employee_id
    and account.disabled_at is null
  for update;
  if current_auth_user_id is null or current_auth_user_id <> target_auth_user_id then
    raise check_violation using message = 'The employee login account changed before the password reset was prepared.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-password-reset-operation:' || target_operation_id::text, 0)
  );

  insert into private.admin_password_reset_operations(
    id,
    employee_id,
    auth_user_id,
    reset_by,
    recipient_email,
    recipient_email_masked
  ) values (
    target_operation_id,
    target_employee_id,
    target_auth_user_id,
    target_actor_employee_id,
    clean_recipient,
    private.mask_admin_password_reset_recipient(clean_recipient)
  )
  on conflict (id) do nothing;

  select item.* into operation
  from private.admin_password_reset_operations item
  where item.id = target_operation_id
  for update;

  perform private.require_admin_password_reset_operation_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id,
    clean_recipient
  );

  return private.admin_password_reset_operation_payload(operation);
end
$$;

create or replace function public.service_complete_employee_password_reset_operation(
  target_operation_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_recipient_email text,
  target_actor_employee_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  clean_recipient text := lower(btrim(coalesce(target_recipient_email, '')));
  current_auth_user_id uuid;
  event_record private.employee_password_reset_events%rowtype;
  operation private.admin_password_reset_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  -- Check the live employee-to-login binding before returning either a new
  -- success or an exact completed replay.  A replacement account must never
  -- inherit the prior account's accepted recovery email.
  select account.auth_user_id into current_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_employee_id
    and account.disabled_at is null
  for update;
  if current_auth_user_id is null or current_auth_user_id <> target_auth_user_id then
    raise check_violation using message = 'The employee login account changed before the password reset completed.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('employee-password-reset-operation:' || target_operation_id::text, 0)
  );

  select item.* into operation
  from private.admin_password_reset_operations item
  where item.id = target_operation_id
  for update;
  if not found then
    raise no_data_found using message = 'The password-reset operation was not prepared.';
  end if;

  perform private.require_admin_password_reset_operation_identity(
    operation,
    target_actor_employee_id,
    target_employee_id,
    target_auth_user_id,
    clean_recipient
  );

  if operation.state = 'completed' then
    return private.admin_password_reset_operation_payload(operation);
  end if;

  if not exists (
    select 1
    from private.email_recipient_dispatches dispatch
    where dispatch.source_kind = 'inline_email'
      and dispatch.source_id = operation.id
      and dispatch.intended_recipient = operation.recipient_email
      and dispatch.notification_type = 'password_reset'
      and dispatch.related_record_type = 'employee'
      and dispatch.related_record_id = operation.employee_id
      and dispatch.state = 'accepted'
      and dispatch.completed_at is not null
  ) then
    raise check_violation using message = 'Password-reset email acceptance has not been durably confirmed.';
  end if;

  insert into private.employee_password_reset_events(
    operation_id,
    employee_id,
    auth_user_id,
    delivery_email_masked,
    reset_by,
    request_id
  ) values (
    operation.id,
    operation.employee_id,
    operation.auth_user_id,
    operation.recipient_email_masked,
    operation.reset_by,
    operation.id::text
  )
  on conflict (operation_id) do nothing;

  select event.* into event_record
  from private.employee_password_reset_events event
  where event.operation_id = operation.id;
  if not found
    or event_record.employee_id is distinct from operation.employee_id
    or event_record.auth_user_id is distinct from operation.auth_user_id
    or event_record.delivery_email_masked is distinct from operation.recipient_email_masked
    or event_record.reset_by is distinct from operation.reset_by
  then
    raise check_violation using message = 'The password-reset audit identity does not match the prepared operation.';
  end if;

  update private.admin_password_reset_operations item
  set state = 'completed',
      completed_at = coalesce(item.completed_at, event_record.requested_at, clock_timestamp())
  where item.id = operation.id
    and item.state = 'prepared'
  returning item.* into operation;

  if not found then
    select item.* into operation
    from private.admin_password_reset_operations item
    where item.id = target_operation_id;
  end if;

  return private.admin_password_reset_operation_payload(operation);
end
$$;

-- Preserve the old service signature for a maintenance cutover, but make it
-- fail closed unless the new immutable operation was prepared before delivery.
create or replace function public.service_record_employee_password_reset(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_delivery_email_masked text,
  target_actor_employee_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation_id uuid;
  operation private.admin_password_reset_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  begin
    operation_id := nullif(btrim(target_request_id), '')::uuid;
  exception when invalid_text_representation then
    raise check_violation using message = 'A valid password-reset operation id is required.';
  end;

  select item.* into operation
  from private.admin_password_reset_operations item
  where item.id = operation_id;
  if not found then
    raise check_violation using message = 'The password-reset operation was not prepared before delivery.';
  end if;
  if operation.employee_id is distinct from target_employee_id
    or operation.auth_user_id is distinct from target_auth_user_id
    or operation.reset_by is distinct from target_actor_employee_id
    or operation.recipient_email_masked is distinct from btrim(coalesce(target_delivery_email_masked, ''))
  then
    raise check_violation using message = 'The password-reset operation identity does not match.';
  end if;

  return public.service_complete_employee_password_reset_operation(
    operation.id,
    operation.employee_id,
    operation.auth_user_id,
    operation.recipient_email,
    operation.reset_by
  );
end
$$;

revoke all on function public.service_prepare_employee_password_reset_operation(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.service_complete_employee_password_reset_operation(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.service_record_employee_password_reset(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.service_prepare_employee_password_reset_operation(uuid, uuid, uuid, text, uuid)
  to service_role;
grant execute on function public.service_complete_employee_password_reset_operation(uuid, uuid, uuid, text, uuid)
  to service_role;
grant execute on function public.service_record_employee_password_reset(uuid, uuid, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
