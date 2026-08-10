create table if not exists private.employee_mfa_reset_events (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null,
  factors_removed integer not null check (factors_removed >= 0),
  trusted_devices_revoked integer not null check (trusted_devices_revoked >= 0),
  reset_by uuid not null references public.employees(id) on delete restrict,
  request_id text,
  reset_at timestamptz not null default clock_timestamp()
);

alter table private.employee_mfa_reset_events enable row level security;

drop trigger if exists employee_mfa_reset_events_audit on private.employee_mfa_reset_events;
create trigger employee_mfa_reset_events_audit
after insert on private.employee_mfa_reset_events
for each row execute function private.write_audit_event();

drop trigger if exists employee_mfa_reset_events_append_only on private.employee_mfa_reset_events;
create trigger employee_mfa_reset_events_append_only
before update or delete on private.employee_mfa_reset_events
for each row execute function private.prevent_append_only_change();

create or replace function public.service_record_employee_mfa_reset(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_factor_count integer,
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
  expected_auth_user_id uuid;
  revoked_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if target_factor_count is null or target_factor_count < 0 then
    raise check_violation using message = 'Factor count must be zero or greater.';
  end if;

  if not exists (
    select 1 from public.employees employee
    where employee.id = target_actor_employee_id
      and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The reset operator was not an active employee.';
  end if;

  select account.auth_user_id
  into expected_auth_user_id
  from private.employee_accounts account
  where account.employee_id = target_employee_id;

  if expected_auth_user_id is null or expected_auth_user_id <> target_auth_user_id then
    raise check_violation using message = 'The employee login account did not match the reset request.';
  end if;

  update private.trusted_devices trusted_device
  set
    revoked_at = clock_timestamp(),
    revoked_by = target_actor_employee_id
  where trusted_device.employee_id = target_employee_id
    and trusted_device.revoked_at is null
    and trusted_device.expires_at > now();

  get diagnostics revoked_count = row_count;

  update private.employee_accounts account
  set mfa_enrolled_at = null
  where account.employee_id = target_employee_id;

  insert into private.employee_mfa_reset_events (
    employee_id,
    auth_user_id,
    factors_removed,
    trusted_devices_revoked,
    reset_by,
    request_id
  ) values (
    target_employee_id,
    target_auth_user_id,
    target_factor_count,
    revoked_count,
    target_actor_employee_id,
    nullif(btrim(target_request_id), '')
  );

  return jsonb_build_object(
    'employeeId', target_employee_id,
    'factorsRemoved', target_factor_count,
    'trustedDevicesRevoked', revoked_count,
    'resetBy', target_actor_employee_id
  );
end
$$;

revoke all on table private.employee_mfa_reset_events from public, anon, authenticated;
revoke all on function public.service_record_employee_mfa_reset(uuid, uuid, integer, uuid, text) from public, anon, authenticated;
grant execute on function public.service_record_employee_mfa_reset(uuid, uuid, integer, uuid, text) to service_role;
