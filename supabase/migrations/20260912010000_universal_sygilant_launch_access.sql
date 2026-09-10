begin;
set local lock_timeout = '5s';

create temporary table sygilant_launch_role_policy on commit drop as
select *
from (values
  ('system_guard'::text, false),
  ('system_dispatcher'::text, true),
  ('system_scheduler'::text, true),
  ('system_recruiting_licensing'::text, true),
  ('system_supervisor'::text, true),
  ('system_admin'::text, true),
  ('custom_chief'::text, true),
  ('operations_manager'::text, true),
  ('human_resources'::text, true),
  ('human_resources_employee'::text, true)
) expected(role_code, mfa_required);

do $$
begin
  if (
    select count(*)
    from sygilant_launch_role_policy expected
    join public.access_roles access_role
      on access_role.code = expected.role_code
     and access_role.active
     and access_role.mfa_required = expected.mfa_required
  ) <> 10 then
    raise check_violation
      using message = 'One or more approved Sygilant launch roles are unavailable or have an unexpected MFA policy.';
  end if;

  if not exists (
    select 1
    from public.access_roles access_role
    where access_role.code = 'system_guard'
      and access_role.base_app_role = 'guard'
      and access_role.system_role
      and access_role.protected
      and not access_role.mfa_required
      and access_role.active
  ) then
    raise check_violation
      using message = 'The protected Guard role mapping is unavailable; the Guard-only exception was not applied.';
  end if;

  if not exists (
    select 1
    from public.permission_catalog catalog
    where catalog.code = 'apps.sygilant.access'
      and catalog.risk_level = 'critical'
      and catalog.requires_mfa
      and catalog.locked
      and catalog.active
  ) then
    raise check_violation
      using message = 'The protected Sygilant launch permission is unavailable.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygilant.access'
      and role_permission.enabled
      and not exists (
        select 1
        from sygilant_launch_role_policy expected
        where expected.role_code = access_role.code
      )
  ) then
    raise check_violation
      using message = 'An unapproved role already has Sygilant launch access; no universal role release was applied.';
  end if;
end
$$;

create temporary table sygilant_launch_access_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', employee.id::text, employee.username, employee.role::text, employee.status::text),
      '|' order by employee.id
    )), md5(''))
    from public.employees employee
  ) as employee_identity_fingerprint,
  (select count(*) from public.employee_access_roles) as employee_access_role_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', assignment.employee_id::text, assignment.role_id::text, coalesce(assignment.assigned_by::text, ''), assignment.assigned_at::text),
      '|' order by assignment.employee_id, assignment.role_id
    )), md5(''))
    from public.employee_access_roles assignment
  ) as employee_access_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as employee_override_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', permission_override.id::text, permission_override.employee_id::text, permission_override.permission_code, permission_override.effect, permission_override.reason, permission_override.active::text, coalesce(permission_override.created_by::text, ''), permission_override.created_at::text, permission_override.updated_at::text),
      '|' order by permission_override.id
    )), md5(''))
    from public.employee_permission_overrides permission_override
  ) as employee_override_fingerprint,
  (select count(*) from public.access_roles) as access_role_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', access_role.id::text, access_role.code, access_role.name, coalesce(access_role.description, ''), coalesce(access_role.base_app_role::text, ''), access_role.system_role::text, access_role.protected::text, access_role.mfa_required::text, access_role.active::text),
      '|' order by access_role.id
    )), md5(''))
    from public.access_roles access_role
  ) as access_role_fingerprint,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', catalog.code, catalog.category, catalog.name, coalesce(catalog.description, ''), catalog.risk_level, catalog.requires_mfa::text, catalog.locked::text, catalog.active::text),
      '|' order by catalog.code
    )), md5(''))
    from public.permission_catalog catalog
  ) as permission_catalog_fingerprint,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text),
      '|' order by role_permission.role_id, role_permission.permission_code
    )), md5(''))
    from public.access_role_permissions role_permission
    where role_permission.permission_code <> 'apps.sygilant.access'
  ) as unrelated_role_permission_fingerprint;

create temporary table sygilant_launch_target_baseline on commit drop as
select
  access_role.id as role_id,
  access_role.code as role_code,
  expected.mfa_required,
  coalesce(role_permission.enabled, false) as previously_enabled
from sygilant_launch_role_policy expected
join public.access_roles access_role on access_role.code = expected.role_code
left join public.access_role_permissions role_permission
  on role_permission.role_id = access_role.id
 and role_permission.permission_code = 'apps.sygilant.access';

insert into public.access_role_permissions (role_id, permission_code, enabled)
select baseline.role_id, 'apps.sygilant.access', true
from sygilant_launch_target_baseline baseline
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

insert into private.audit_events (
  auth_user_id,
  employee_id,
  request_id,
  schema_name,
  table_name,
  operation,
  row_id,
  old_record,
  new_record
)
select
  null,
  null,
  'migration:20260912010000',
  'public',
  'access_role_permissions',
  'UPDATE',
  baseline.role_id::text,
  jsonb_build_object(
    'enabled', baseline.previously_enabled,
    'permissionCode', 'apps.sygilant.access',
    'roleCode', baseline.role_code,
    'source', 'universal-sygilant-launch-release'
  ),
  jsonb_build_object(
    'enabled', true,
    'mfaRequired', baseline.mfa_required,
    'permissionCode', 'apps.sygilant.access',
    'roleCode', baseline.role_code,
    'source', 'universal-sygilant-launch-release'
  )
from sygilant_launch_target_baseline baseline
where not baseline.previously_enabled;

alter table private.sygilant_shared_launches
  drop constraint sygilant_shared_launch_assurance,
  add constraint sygilant_shared_launch_assurance
    check (assurance_level in ('aal1', 'aal2', 'security_key', 'trusted_device', 'external_mfa')),
  add constraint sygilant_shared_launch_guard_aal1
    check (assurance_level <> 'aal1' or role_id = 'guard');

create or replace function private.sygilant_launch_assurance_allowed(
  target_employee_id uuid,
  target_assurance_level text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_assurance_level in ('aal2', 'security_key', 'trusted_device', 'external_mfa') then true
    when target_assurance_level = 'aal1' then coalesce(exists (
      select 1
      from public.employees employee
      where employee.id = target_employee_id
        and employee.status = 'active'
        and employee.role = 'guard'
        and not private.employee_requires_mfa(employee.id)
    ), false)
    else false
  end
$$;

create or replace function private.enforce_sygilant_launch_assurance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.sygilant_launch_assurance_allowed(new.employee_id, new.assurance_level) then
    raise insufficient_privilege
      using message = 'The Sygilant launch assurance is not authorized for this employee.';
  end if;
  return new;
end
$$;

drop trigger if exists enforce_sygilant_launch_assurance on private.sygilant_shared_launches;
create trigger enforce_sygilant_launch_assurance
before insert or update of employee_id, assurance_level, consumed_at
on private.sygilant_shared_launches
for each row execute function private.enforce_sygilant_launch_assurance();

revoke all on function private.sygilant_launch_assurance_allowed(uuid, text) from public, anon, authenticated;
revoke all on function private.enforce_sygilant_launch_assurance() from public, anon, authenticated;

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
  if coalesce((select auth.role()), '') <> 'service_role' then
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
     or assurance_value not in ('aal1', 'aal2', 'security_key', 'trusted_device', 'external_mfa')
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
      and private.sygilant_launch_assurance_allowed(employee.id, assurance_value)
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

revoke all on function public.service_issue_sygilant_shared_launch(jsonb) from public, anon, authenticated;
grant execute on function public.service_issue_sygilant_shared_launch(jsonb) to service_role;

alter table private.shared_identity_sessions
  drop constraint shared_identity_sessions_assurance_level_check,
  add constraint shared_identity_sessions_assurance_level_check
    check (assurance_level in ('aal1', 'aal2', 'security_key', 'trusted_device', 'external_mfa'));

create or replace function private.shared_identity_session_assurance_allowed(
  target_employee_id uuid,
  target_assurance_level text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when target_assurance_level in ('aal2', 'security_key', 'trusted_device', 'external_mfa') then true
    when target_assurance_level = 'aal1' then coalesce(exists (
      select 1
      from public.employees employee
      where employee.id = target_employee_id
        and employee.status = 'active'
        and employee.role = 'guard'
        and not private.employee_requires_mfa(employee.id)
    ), false)
    else false
  end
$$;

create or replace function public.has_scoped_shared_identity_session(target_scope text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  session_token text := private.request_header('x-sygshift-shared-identity');
  jwt_session_id_text text := (select auth.jwt() ->> 'session_id');
  jwt_session_id uuid;
begin
  if target_scope not in ('platform', 'sygsphere')
    or actor_id is null
    or (select auth.uid()) is null
    or session_token is null
    or jwt_session_id_text is null
    or session_token !~ '^[A-Za-z0-9_-]{40,180}$' then
    return false;
  end if;

  begin
    jwt_session_id := jwt_session_id_text::uuid;
  exception when others then
    return false;
  end;

  return exists (
    select 1
    from private.shared_identity_sessions shared_session
    join private.employee_accounts account
      on account.employee_id = shared_session.employee_id
     and account.auth_user_id = shared_session.auth_user_id
    join public.employees employee
      on employee.id = account.employee_id
    join auth.sessions auth_session
      on auth_session.id = shared_session.auth_session_id
     and auth_session.user_id = shared_session.auth_user_id
     and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
    where shared_session.employee_id = actor_id
      and shared_session.auth_user_id = (select auth.uid())
      and shared_session.auth_session_id = jwt_session_id
      and shared_session.scope = target_scope
      and shared_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
      and shared_session.revoked_at is null
      and shared_session.expires_at > clock_timestamp()
      and account.disabled_at is null
      and not account.must_change_password
      and employee.status = 'active'
      and private.shared_identity_session_assurance_allowed(shared_session.employee_id, shared_session.assurance_level)
  );
end
$$;

create or replace function private.has_high_assurance_shared_identity_session(target_scope text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  session_token text := private.request_header('x-sygshift-shared-identity');
  jwt_session_id uuid;
begin
  begin
    jwt_session_id := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  exception when others then
    return false;
  end;

  return public.has_scoped_shared_identity_session(target_scope)
    and exists (
      select 1
      from private.shared_identity_sessions shared_session
      where shared_session.employee_id = actor_id
        and shared_session.auth_user_id = (select auth.uid())
        and shared_session.auth_session_id = jwt_session_id
        and shared_session.scope = target_scope
        and shared_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
        and shared_session.assurance_level in ('aal2', 'security_key', 'trusted_device', 'external_mfa')
        and shared_session.revoked_at is null
        and shared_session.expires_at > clock_timestamp()
    );
end
$$;

create or replace function public.has_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_aal2()
    or public.has_trusted_device()
    or public.has_security_key_session()
    or private.has_high_assurance_shared_identity_session('platform')
$$;

create or replace function public.service_issue_shared_identity_session(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_auth_session_id uuid,
  target_launch_request_id uuid,
  target_token_hash text,
  target_assurance_level text,
  target_expires_at timestamptz,
  target_scope text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  shared_session_id uuid;
  maximum_expiration interval;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_scope not in ('platform', 'sygsphere') then
    raise check_violation using message = 'The shared session scope was invalid.';
  end if;
  if target_assurance_level not in ('aal1', 'aal2', 'security_key', 'trusted_device', 'external_mfa') then
    raise check_violation using message = 'The shared assurance level was invalid.';
  end if;

  maximum_expiration := case
    when target_assurance_level = 'trusted_device' then interval '14 days 5 minutes'
    else interval '12 hours 5 minutes'
  end;
  if target_expires_at <= clock_timestamp()
    or target_expires_at > clock_timestamp() + maximum_expiration then
    raise check_violation using message = 'The shared session expiration was invalid.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'The shared session token was invalid.';
  end if;
  if not exists (
    select 1
    from private.employee_accounts account
    join public.employees employee on employee.id = account.employee_id
    join auth.sessions auth_session
      on auth_session.id = target_auth_session_id
     and auth_session.user_id = account.auth_user_id
     and (auth_session.not_after is null or auth_session.not_after > clock_timestamp())
    where account.employee_id = target_employee_id
      and account.auth_user_id = target_auth_user_id
      and account.disabled_at is null
      and not account.must_change_password
      and employee.status = 'active'
      and private.shared_identity_session_assurance_allowed(employee.id, target_assurance_level)
  ) then
    raise insufficient_privilege using message = 'The shared identity is not linked to an active SygShift account with the required assurance.';
  end if;

  update private.shared_identity_sessions shared_session
  set revoked_at = clock_timestamp()
  where shared_session.employee_id = target_employee_id
    and shared_session.auth_session_id = target_auth_session_id
    and shared_session.revoked_at is null;

  insert into private.shared_identity_sessions (
    employee_id,
    auth_user_id,
    auth_session_id,
    launch_request_id,
    token_hash,
    assurance_level,
    scope,
    expires_at,
    last_seen_at
  ) values (
    target_employee_id,
    target_auth_user_id,
    target_auth_session_id,
    target_launch_request_id,
    target_token_hash,
    target_assurance_level,
    target_scope,
    target_expires_at,
    clock_timestamp()
  ) returning id into shared_session_id;

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
    target_auth_user_id,
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'shared_identity_sessions',
    'VERIFY',
    shared_session_id::text,
    jsonb_build_object(
      'assuranceLevel', target_assurance_level,
      'authSessionId', target_auth_session_id,
      'expiresAt', target_expires_at,
      'launchRequestId', target_launch_request_id,
      'scope', target_scope
    )
  );

  return jsonb_build_object(
    'id', shared_session_id,
    'expiresAt', target_expires_at,
    'scope', target_scope
  );
exception
  when unique_violation then
    raise insufficient_privilege using message = 'The shared launch request has already been finalized.';
end
$$;

revoke all on function private.shared_identity_session_assurance_allowed(uuid, text) from public, anon, authenticated;
revoke all on function private.has_high_assurance_shared_identity_session(text) from public, anon, authenticated;
revoke all on function public.has_scoped_shared_identity_session(text) from public, anon;
grant execute on function public.has_scoped_shared_identity_session(text) to authenticated;
revoke all on function public.has_mfa() from public, anon;
grant execute on function public.has_mfa() to authenticated;
revoke all on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text, text) from public, anon, authenticated;
grant execute on function public.service_issue_shared_identity_session(uuid, uuid, uuid, uuid, text, text, timestamptz, text, text) to service_role;

do $$
declare
  baseline sygilant_launch_access_baseline%rowtype;
begin
  select * into strict baseline from sygilant_launch_access_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_identity_fingerprint is distinct from (
      select coalesce(md5(string_agg(
        concat_ws(':', employee.id::text, employee.username, employee.role::text, employee.status::text),
        '|' order by employee.id
      )), md5(''))
      from public.employees employee
    )
    or baseline.employee_access_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.employee_access_role_fingerprint is distinct from (
      select coalesce(md5(string_agg(
        concat_ws(':', assignment.employee_id::text, assignment.role_id::text, coalesce(assignment.assigned_by::text, ''), assignment.assigned_at::text),
        '|' order by assignment.employee_id, assignment.role_id
      )), md5(''))
      from public.employee_access_roles assignment
    )
    or baseline.employee_override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.employee_override_fingerprint is distinct from (
      select coalesce(md5(string_agg(
        concat_ws(':', permission_override.id::text, permission_override.employee_id::text, permission_override.permission_code, permission_override.effect, permission_override.reason, permission_override.active::text, coalesce(permission_override.created_by::text, ''), permission_override.created_at::text, permission_override.updated_at::text),
        '|' order by permission_override.id
      )), md5(''))
      from public.employee_permission_overrides permission_override
    )
    or baseline.access_role_count <> (select count(*) from public.access_roles)
    or baseline.access_role_fingerprint is distinct from (
      select coalesce(md5(string_agg(
        concat_ws(':', access_role.id::text, access_role.code, access_role.name, coalesce(access_role.description, ''), coalesce(access_role.base_app_role::text, ''), access_role.system_role::text, access_role.protected::text, access_role.mfa_required::text, access_role.active::text),
        '|' order by access_role.id
      )), md5(''))
      from public.access_roles access_role
    )
    or baseline.permission_catalog_fingerprint is distinct from (
      select coalesce(md5(string_agg(
        concat_ws(':', catalog.code, catalog.category, catalog.name, coalesce(catalog.description, ''), catalog.risk_level, catalog.requires_mfa::text, catalog.locked::text, catalog.active::text),
        '|' order by catalog.code
      )), md5(''))
      from public.permission_catalog catalog
    )
  then
    raise exception 'Universal Sygilant launch access changed protected employee, assignment, override, role, or permission-catalog records.';
  end if;

  if baseline.unrelated_role_permission_fingerprint is distinct from (
    select coalesce(md5(string_agg(
      concat_ws(':', role_permission.role_id::text, role_permission.permission_code, role_permission.enabled::text),
      '|' order by role_permission.role_id, role_permission.permission_code
    )), md5(''))
    from public.access_role_permissions role_permission
    where role_permission.permission_code <> 'apps.sygilant.access'
  ) then
    raise exception 'Universal Sygilant launch access changed an unrelated role permission.';
  end if;

  if (
    select count(*)
    from sygilant_launch_role_policy expected
    join public.access_roles access_role
      on access_role.code = expected.role_code
     and access_role.active
     and access_role.mfa_required = expected.mfa_required
    join public.access_role_permissions role_permission
      on role_permission.role_id = access_role.id
     and role_permission.permission_code = 'apps.sygilant.access'
     and role_permission.enabled
  ) <> 10 then
    raise exception 'Sygilant launch access was not enabled for all ten approved roles with the approved MFA policy.';
  end if;

  if exists (
    select 1
    from public.access_role_permissions role_permission
    join public.access_roles access_role on access_role.id = role_permission.role_id
    where role_permission.permission_code = 'apps.sygilant.access'
      and role_permission.enabled
      and not exists (
        select 1
        from sygilant_launch_role_policy expected
        where expected.role_code = access_role.code
      )
  ) then
    raise exception 'Sygilant launch access was enabled for an unapproved role.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_record
    where constraint_record.conrelid = 'private.sygilant_shared_launches'::regclass
      and constraint_record.conname = 'sygilant_shared_launch_guard_aal1'
      and constraint_record.convalidated
  ) or not exists (
    select 1
    from pg_catalog.pg_trigger trigger_record
    where trigger_record.tgrelid = 'private.sygilant_shared_launches'::regclass
      and trigger_record.tgname = 'enforce_sygilant_launch_assurance'
      and not trigger_record.tgisinternal
  ) then
    raise exception 'The Guard-only outgoing assurance controls were not installed.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
