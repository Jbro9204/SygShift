create table private.mfa_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  code_hash text not null,
  code_hint text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references public.employees(id) on delete restrict,
  used_request_id text,
  revoked_at timestamptz,
  revoked_by uuid references public.employees(id) on delete restrict,
  constraint mfa_recovery_codes_hash_unique unique (code_hash),
  constraint mfa_recovery_codes_hash_format check (code_hash ~ '^[a-f0-9]{64}$'),
  constraint mfa_recovery_codes_hint_format check (code_hint ~ '^\*{4}[A-Z0-9]{4}$'),
  constraint mfa_recovery_codes_expiration check (expires_at > created_at)
);

create index mfa_recovery_codes_employee_active_idx
  on private.mfa_recovery_codes(employee_id, expires_at desc)
  where used_at is null and revoked_at is null;

alter table private.mfa_recovery_codes enable row level security;
revoke all on table private.mfa_recovery_codes from public, anon, authenticated;

create trigger mfa_recovery_codes_audit
after insert or update on private.mfa_recovery_codes
for each row execute function private.write_audit_event();

create trigger mfa_recovery_codes_append_only
before delete on private.mfa_recovery_codes
for each row execute function private.prevent_append_only_change();

create or replace function public.service_replace_mfa_recovery_codes(
  target_employee_id uuid,
  target_batch_id uuid,
  target_codes jsonb,
  target_expires_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_batch_id is null or jsonb_typeof(target_codes) <> 'array' or jsonb_array_length(target_codes) <> 10 then
    raise check_violation using message = 'Exactly ten recovery-code hashes are required.';
  end if;
  if target_expires_at <= now() then
    raise check_violation using message = 'Recovery codes must expire in the future.';
  end if;

  perform 1 from public.employees employee where employee.id = target_employee_id and employee.status in ('active', 'leave');
  if not found then raise foreign_key_violation using message = 'Active employee not found.'; end if;

  update private.mfa_recovery_codes code
  set revoked_at = clock_timestamp(), revoked_by = target_employee_id
  where code.employee_id = target_employee_id
    and code.used_at is null
    and code.revoked_at is null;

  insert into private.mfa_recovery_codes (batch_id, employee_id, created_by, code_hash, code_hint, expires_at)
  select
    target_batch_id,
    target_employee_id,
    target_employee_id,
    lower(item ->> 'hash'),
    item ->> 'hint',
    target_expires_at
  from jsonb_array_elements(target_codes) item;
  get diagnostics inserted_count = row_count;

  return jsonb_build_object('batchId', target_batch_id, 'count', inserted_count, 'expiresAt', target_expires_at);
end;
$$;

create or replace function public.service_consume_mfa_recovery_code(
  target_employee_id uuid,
  target_code_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  matched private.mfa_recovery_codes%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select code.* into matched
  from private.mfa_recovery_codes code
  where code.employee_id = target_employee_id
    and code.code_hash = lower(target_code_hash)
    and code.used_at is null
    and code.revoked_at is null
    and code.expires_at > now()
  for update skip locked;

  if matched.id is null then
    return jsonb_build_object('consumed', false);
  end if;

  update private.mfa_recovery_codes code
  set used_at = clock_timestamp(), used_by = target_employee_id, used_request_id = nullif(btrim(target_request_id), '')
  where code.id = matched.id;

  update private.mfa_recovery_codes code
  set revoked_at = clock_timestamp(), revoked_by = target_employee_id
  where code.employee_id = target_employee_id
    and code.id <> matched.id
    and code.used_at is null
    and code.revoked_at is null;

  return jsonb_build_object('consumed', true, 'batchId', matched.batch_id, 'codeHint', matched.code_hint);
end;
$$;

create or replace function public.service_revoke_mfa_recovery_codes(
  target_employee_id uuid,
  target_actor_employee_id uuid,
  target_request_id text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare revoked_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  update private.mfa_recovery_codes code
  set revoked_at = clock_timestamp(), revoked_by = target_actor_employee_id
  where code.employee_id = target_employee_id and code.used_at is null and code.revoked_at is null;
  get diagnostics revoked_count = row_count;
  return revoked_count;
end;
$$;

revoke all on function public.service_replace_mfa_recovery_codes(uuid, uuid, jsonb, timestamptz, text) from public, anon, authenticated;
revoke all on function public.service_consume_mfa_recovery_code(uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_revoke_mfa_recovery_codes(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.service_replace_mfa_recovery_codes(uuid, uuid, jsonb, timestamptz, text) to service_role;
grant execute on function public.service_consume_mfa_recovery_code(uuid, text, text) to service_role;
grant execute on function public.service_revoke_mfa_recovery_codes(uuid, uuid, text) to service_role;

comment on table private.mfa_recovery_codes is
  'One-time MFA recovery codes. Only SHA-256 hashes and masked hints are stored; raw codes are returned once by the Worker.';
