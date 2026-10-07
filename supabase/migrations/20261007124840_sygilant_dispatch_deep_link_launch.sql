begin;
set local lock_timeout = '5s';

alter table private.sygilant_shared_launches
  drop constraint if exists sygilant_shared_launch_destination;
alter table private.sygilant_shared_launches
  add constraint sygilant_shared_launch_destination check (
    destination = '/dashboard'
    or destination ~* '^/dispatch[?]call=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or destination ~* '^/daily-activity-reports[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or destination ~* '^/incident-reports[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or destination ~* '^/vehicle-inspections[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) not valid;
alter table private.sygilant_shared_launches
  validate constraint sygilant_shared_launch_destination;

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
  destination_value text := btrim(coalesce(target_payload ->> 'destination', ''));
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
     or not (
       destination_value = '/dashboard'
       or destination_value ~* '^/dispatch[?]call=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or destination_value ~* '^/daily-activity-reports[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or destination_value ~* '^/incident-reports[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or destination_value ~* '^/vehicle-inspections[?]report=[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )
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
    destination_value,
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
      'destination', destination_value,
      'expiresAt', expires_at_value
    )
  );

  return jsonb_build_object(
    'requestId', request_id_value,
    'destination', destination_value,
    'expiresAt', expires_at_value
  );
exception
  when unique_violation then
    raise insufficient_privilege using message = 'The Sygilant launch assertion has already been issued.';
end
$$;

revoke all on function public.service_issue_sygilant_shared_launch(jsonb)
  from public, anon, authenticated;
grant execute on function public.service_issue_sygilant_shared_launch(jsonb)
  to service_role;

comment on function public.service_issue_sygilant_shared_launch(jsonb) is
  'Issues a single-use Sygilant handoff for the dashboard, one exact dispatch call, or one exact operational report after rechecking the live identity, entitlement, session, and assurance level.';

notify pgrst, 'reload schema';
commit;
