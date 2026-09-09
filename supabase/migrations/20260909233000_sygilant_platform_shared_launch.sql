begin;
set local lock_timeout = '5s';

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
  'apps.sygilant.access',
  'Connected Applications',
  'Open Sygilant main platform',
  'Use the protected, single-use shared identity handoff to enter the Sygilant main platform.',
  'critical',
  true,
  true,
  true
)
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = excluded.active,
    updated_at = clock_timestamp();

-- Start closed: administrators can validate the reciprocal production handoff,
-- and additional roles are granted through the existing effective-permission
-- system after their Sygilant destination entitlements are confirmed.
insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'apps.sygilant.access', true
from public.access_roles access_role
where access_role.code = 'system_admin'
on conflict (role_id, permission_code) do update
set enabled = excluded.enabled,
    updated_at = clock_timestamp();

create table if not exists private.sygilant_shared_launches (
  request_id uuid primary key,
  application_id text not null,
  issuer text not null,
  audience text not null,
  destination text not null,
  employee_id uuid not null references public.employees(id) on delete restrict,
  auth_user_id uuid not null references auth.users(id) on delete restrict,
  source_session_id uuid not null,
  username text not null,
  role_id text not null,
  assurance_level text not null,
  assertion_hash text not null unique,
  nonce_hash text not null unique,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  issue_context jsonb not null default '{}'::jsonb,
  consume_context jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint sygilant_shared_launch_application check (application_id = 'sygilant'),
  constraint sygilant_shared_launch_issuer check (issuer = 'https://app.sygilant.us'),
  constraint sygilant_shared_launch_audience check (audience = 'https://sygilant.us'),
  constraint sygilant_shared_launch_destination check (destination = '/dashboard'),
  constraint sygilant_shared_launch_username check (username ~ '^[a-z][a-z0-9]{1,62}$'),
  constraint sygilant_shared_launch_assurance check (assurance_level in ('aal2', 'security_key', 'trusted_device', 'external_mfa')),
  constraint sygilant_shared_launch_assertion_hash check (assertion_hash ~ '^[a-f0-9]{64}$'),
  constraint sygilant_shared_launch_nonce_hash check (nonce_hash ~ '^[a-f0-9]{64}$'),
  constraint sygilant_shared_launch_expiration check (expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'),
  constraint sygilant_shared_launch_consume_time check (consumed_at is null or consumed_at >= issued_at),
  constraint sygilant_shared_launch_issue_context_object check (jsonb_typeof(issue_context) = 'object'),
  constraint sygilant_shared_launch_consume_context_object check (consume_context is null or jsonb_typeof(consume_context) = 'object')
);

-- Preserve safe reruns if an earlier draft created the ledger before source
-- session binding was added. The NOT VALID check protects every new row while
-- allowing expired legacy audit rows to remain immutable.
alter table private.sygilant_shared_launches
  add column if not exists source_session_id uuid;

do $sygilant_source_session_constraint$
begin
  if exists (
    select 1
    from pg_catalog.pg_attribute attribute_record
    where attribute_record.attrelid = 'private.sygilant_shared_launches'::regclass
      and attribute_record.attname = 'source_session_id'
      and not attribute_record.attnotnull
      and not attribute_record.attisdropped
  ) and not exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
      and constraint_record.conname = 'sygilant_shared_launch_source_session_required'
  ) then
    alter table private.sygilant_shared_launches
      add constraint sygilant_shared_launch_source_session_required
      check (source_session_id is not null) not valid;
  end if;
end
$sygilant_source_session_constraint$;

create index if not exists sygilant_shared_launches_expiry_idx
  on private.sygilant_shared_launches(expires_at)
  where consumed_at is null;

alter table private.sygilant_shared_launches enable row level security;
alter table private.sygilant_shared_launches force row level security;
revoke all on table private.sygilant_shared_launches from public, anon, authenticated;

create or replace function public.service_issue_sygilant_shared_launch(target_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  request_id_value uuid;
  employee_id_value uuid;
  auth_user_id_value uuid;
  source_session_id_value uuid;
  issued_at_value timestamptz;
  expires_at_value timestamptz;
  username_value text := btrim(coalesce(target_payload ->> 'externalUsername', ''));
  role_id_value text := btrim(coalesce(target_payload ->> 'roleId', ''));
  assurance_value text := btrim(coalesce(target_payload ->> 'assuranceLevel', ''));
  assertion_hash_value text := lower(btrim(coalesce(target_payload ->> 'assertionHash', '')));
  nonce_value text := btrim(coalesce(target_payload ->> 'nonce', ''));
  nonce_hash_value text := lower(btrim(coalesce(target_payload ->> 'nonceHash', '')));
  request_context_value jsonb := coalesce(target_payload -> 'requestContext', '{}'::jsonb);
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_payload is null or jsonb_typeof(target_payload) <> 'object' then
    raise check_violation using message = 'The Sygilant launch payload is invalid.';
  end if;
  if target_payload - array[
    'applicationId', 'assuranceLevel', 'assertionHash', 'audience', 'destination',
    'expiresAt', 'externalEmployeeId', 'externalSubjectId', 'externalUsername',
    'issuedAt', 'issuer', 'nonce', 'nonceHash', 'profileId', 'requestContext',
    'requestId', 'roleId', 'sourceAuthSessionId', 'version'
  ]::text[] <> '{}'::jsonb then
    raise check_violation using message = 'The Sygilant launch payload contains unsupported fields.';
  end if;

  begin
    request_id_value := (target_payload ->> 'requestId')::uuid;
    employee_id_value := (target_payload ->> 'externalEmployeeId')::uuid;
    auth_user_id_value := (target_payload ->> 'externalSubjectId')::uuid;
    source_session_id_value := (target_payload ->> 'sourceAuthSessionId')::uuid;
    issued_at_value := (target_payload ->> 'issuedAt')::timestamptz;
    expires_at_value := (target_payload ->> 'expiresAt')::timestamptz;
  exception when others then
    raise check_violation using message = 'The Sygilant launch identity or time fields are invalid.';
  end;

  if jsonb_typeof(target_payload -> 'version') is distinct from 'number'
     or (target_payload ->> 'version') is distinct from '1'
     or (target_payload ->> 'applicationId') is distinct from 'sygilant'
     or (target_payload ->> 'issuer') is distinct from 'https://app.sygilant.us'
     or (target_payload ->> 'audience') is distinct from 'https://sygilant.us'
     or (target_payload ->> 'destination') is distinct from '/dashboard'
     or (target_payload ->> 'profileId') is distinct from auth_user_id_value::text
     or username_value !~ '^[a-z][a-z0-9]{1,62}$'
     or length(role_id_value) not between 2 and 80
     or assurance_value not in ('aal2', 'security_key', 'trusted_device', 'external_mfa')
     or assertion_hash_value !~ '^[a-f0-9]{64}$'
     or nonce_hash_value !~ '^[a-f0-9]{64}$'
     or length(nonce_value) not between 20 and 180
     or nonce_hash_value <> encode(extensions.digest(nonce_value, 'sha256'), 'hex')
     or jsonb_typeof(request_context_value) is distinct from 'object'
     or pg_column_size(request_context_value) > 16384
     or issued_at_value < clock_timestamp() - interval '2 minutes'
     or issued_at_value > clock_timestamp() + interval '1 minute'
     or expires_at_value <= clock_timestamp()
     or expires_at_value <= issued_at_value
     or expires_at_value > issued_at_value + interval '5 minutes' then
    raise check_violation using message = 'The Sygilant launch assertion metadata is invalid.';
  end if;

  if not exists (
    select 1
    from private.employee_accounts account
    join public.employees employee on employee.id = account.employee_id
    join auth.sessions source_session
      on source_session.id = source_session_id_value
     and source_session.user_id = account.auth_user_id
     and (source_session.not_after is null or source_session.not_after > clock_timestamp())
    where account.employee_id = employee_id_value
      and account.auth_user_id = auth_user_id_value
      and account.disabled_at is null
      and employee.status = 'active'
      and employee.username = username_value
      and employee.role::text = role_id_value
      and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  ) then
    raise insufficient_privilege using message = 'The SygShift identity is not authorized for Sygilant.';
  end if;

  insert into private.sygilant_shared_launches (
    request_id,
    application_id,
    issuer,
    audience,
    destination,
    employee_id,
    auth_user_id,
    source_session_id,
    username,
    role_id,
    assurance_level,
    assertion_hash,
    nonce_hash,
    issued_at,
    expires_at,
    issue_context
  ) values (
    request_id_value,
    'sygilant',
    'https://app.sygilant.us',
    'https://sygilant.us',
    '/dashboard',
    employee_id_value,
    auth_user_id_value,
    source_session_id_value,
    username_value,
    role_id_value,
    assurance_value,
    assertion_hash_value,
    nonce_hash_value,
    issued_at_value,
    expires_at_value,
    request_context_value
  );

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    auth_user_id_value,
    employee_id_value,
    nullif(btrim(request_context_value ->> 'requestId'), ''),
    'private',
    'sygilant_shared_launches',
    'ISSUE',
    request_id_value::text,
    jsonb_build_object(
      'applicationId', 'sygilant',
      'assuranceLevel', assurance_value,
      'destination', '/dashboard',
      'expiresAt', expires_at_value
    )
  );

  return jsonb_build_object('requestId', request_id_value, 'expiresAt', expires_at_value);
exception
  when unique_violation then
    raise insufficient_privilege using message = 'The Sygilant launch assertion has already been issued.';
end
$$;

create or replace function public.service_consume_sygilant_shared_launch(target_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  launch_record private.sygilant_shared_launches%rowtype;
  request_id_value uuid;
  employee_id_value uuid;
  auth_user_id_value uuid;
  issued_at_value timestamptz;
  expires_at_value timestamptz;
  updated_count integer;
  assertion_hash_value text := lower(btrim(coalesce(target_payload ->> 'assertionHash', '')));
  nonce_value text := btrim(coalesce(target_payload ->> 'nonce', ''));
  request_context_value jsonb := coalesce(target_payload -> 'requestContext', '{}'::jsonb);
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_payload is null or jsonb_typeof(target_payload) <> 'object' then
    raise check_violation using message = 'The Sygilant launch payload is invalid.';
  end if;
  if target_payload - array[
    'applicationId', 'assuranceLevel', 'assertionHash', 'audience', 'destination',
    'expiresAt', 'externalEmployeeId', 'externalSubjectId', 'externalUsername',
    'issuedAt', 'issuer', 'nonce', 'profileId', 'requestContext', 'requestId',
    'roleId', 'version'
  ]::text[] <> '{}'::jsonb then
    raise check_violation using message = 'The Sygilant launch payload contains unsupported fields.';
  end if;

  begin
    request_id_value := (target_payload ->> 'requestId')::uuid;
    employee_id_value := (target_payload ->> 'externalEmployeeId')::uuid;
    auth_user_id_value := (target_payload ->> 'externalSubjectId')::uuid;
    issued_at_value := (target_payload ->> 'issuedAt')::timestamptz;
    expires_at_value := (target_payload ->> 'expiresAt')::timestamptz;
  exception when others then
    raise check_violation using message = 'The Sygilant launch identity or time fields are invalid.';
  end;

  if assertion_hash_value !~ '^[a-f0-9]{64}$'
     or length(nonce_value) not between 20 and 180
     or jsonb_typeof(request_context_value) is distinct from 'object'
     or pg_column_size(request_context_value) > 16384 then
    raise check_violation using message = 'The Sygilant launch consumption metadata is invalid.';
  end if;

  select launch.*
  into launch_record
  from private.sygilant_shared_launches launch
  where launch.request_id = request_id_value
    and launch.assertion_hash = assertion_hash_value
  for update;

  if not found
     or launch_record.consumed_at is not null
     or launch_record.expires_at <= clock_timestamp()
     or launch_record.application_id is distinct from (target_payload ->> 'applicationId')
     or launch_record.issuer is distinct from (target_payload ->> 'issuer')
     or launch_record.audience is distinct from (target_payload ->> 'audience')
     or launch_record.destination is distinct from (target_payload ->> 'destination')
     or launch_record.employee_id is distinct from employee_id_value
     or launch_record.auth_user_id is distinct from auth_user_id_value
     or launch_record.auth_user_id::text is distinct from (target_payload ->> 'profileId')
     or launch_record.username is distinct from (target_payload ->> 'externalUsername')
     or launch_record.role_id is distinct from (target_payload ->> 'roleId')
     or launch_record.assurance_level is distinct from (target_payload ->> 'assuranceLevel')
     or launch_record.issued_at is distinct from issued_at_value
     or launch_record.expires_at is distinct from expires_at_value
     or launch_record.nonce_hash is distinct from encode(extensions.digest(nonce_value, 'sha256'), 'hex')
     or jsonb_typeof(target_payload -> 'version') is distinct from 'number'
     or (target_payload ->> 'version') is distinct from '1' then
    raise insufficient_privilege using message = 'The Sygilant launch assertion is invalid, expired, or already used.';
  end if;

  if not exists (
    select 1
    from private.employee_accounts account
    join public.employees employee on employee.id = account.employee_id
    join auth.sessions source_session
      on source_session.id = launch_record.source_session_id
     and source_session.user_id = launch_record.auth_user_id
     and (source_session.not_after is null or source_session.not_after > clock_timestamp())
    where account.employee_id = launch_record.employee_id
      and account.auth_user_id = launch_record.auth_user_id
      and account.disabled_at is null
      and employee.status = 'active'
      and employee.username = launch_record.username
      and employee.role::text = launch_record.role_id
      and 'apps.sygilant.access' = any(private.employee_effective_permissions(employee.id))
  ) then
    raise insufficient_privilege using message = 'The SygShift identity is no longer authorized for Sygilant.';
  end if;

  update private.sygilant_shared_launches launch
  set consumed_at = clock_timestamp(),
      consume_context = request_context_value
  where launch.request_id = launch_record.request_id
    and launch.consumed_at is null
    and launch.expires_at > clock_timestamp();

  get diagnostics updated_count = row_count;
  if updated_count <> 1 then
    raise insufficient_privilege using message = 'The Sygilant launch assertion is invalid, expired, or already used.';
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    request_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    launch_record.auth_user_id,
    launch_record.employee_id,
    nullif(btrim(request_context_value ->> 'requestId'), ''),
    'private',
    'sygilant_shared_launches',
    'CONSUME',
    launch_record.request_id::text,
    jsonb_build_object(
      'applicationId', launch_record.application_id,
      'assuranceLevel', launch_record.assurance_level,
      'destination', launch_record.destination,
      'expiresAt', launch_record.expires_at
    )
  );

  return jsonb_build_object(
    'assuranceLevel', launch_record.assurance_level,
    'authUserId', launch_record.auth_user_id,
    'destination', launch_record.destination,
    'employeeId', launch_record.employee_id,
    'expiresAt', launch_record.expires_at,
    'requestId', launch_record.request_id,
    'roleId', launch_record.role_id,
    'username', launch_record.username
  );
end
$$;

revoke all on function public.service_issue_sygilant_shared_launch(jsonb) from public, anon, authenticated;
revoke all on function public.service_consume_sygilant_shared_launch(jsonb) from public, anon, authenticated;
grant execute on function public.service_issue_sygilant_shared_launch(jsonb) to service_role;
grant execute on function public.service_consume_sygilant_shared_launch(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
