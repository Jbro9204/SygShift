begin;

create or replace function public.service_rename_webauthn_credential(
  target_employee_id uuid,
  target_credential_record_id uuid,
  target_label text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_record private.webauthn_credentials%rowtype;
  previous_label text;
  normalized_label text := btrim(coalesce(target_label, ''));
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if normalized_label = '' or char_length(normalized_label) > 60 then
    raise check_violation using message = 'Security-key names must contain 1 to 60 characters.';
  end if;

  select credential.label into previous_label
  from private.webauthn_credentials credential
  where credential.id = target_credential_record_id
    and credential.employee_id = target_employee_id
    and credential.revoked_at is null
  for update;

  if previous_label is null then
    raise no_data_found using message = 'The security key was not found.';
  end if;

  update private.webauthn_credentials credential
  set label = normalized_label
  where credential.id = target_credential_record_id
    and credential.employee_id = target_employee_id
    and credential.revoked_at is null
  returning * into credential_record;

  insert into private.audit_events (
    employee_id, request_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    target_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'webauthn_credentials',
    'RENAME',
    credential_record.id::text,
    jsonb_build_object('label', previous_label),
    jsonb_build_object('label', credential_record.label)
  );

  return jsonb_build_object(
    'id', credential_record.id,
    'label', credential_record.label,
    'renamed', true
  );
end
$$;

create or replace function public.service_admin_revoke_webauthn_credential(
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_credential_record_id uuid,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  credential_record private.webauthn_credentials%rowtype;
  sessions_revoked_count integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if not exists (
    select 1
    from public.employees employee
    where employee.id = target_actor_employee_id
      and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The reset operator was not an active employee.';
  end if;

  update private.webauthn_credentials credential
  set revoked_at = clock_timestamp(), revoked_by = target_actor_employee_id
  where credential.id = target_credential_record_id
    and credential.employee_id = target_employee_id
    and credential.revoked_at is null
  returning * into credential_record;

  if credential_record.id is null then
    raise no_data_found using message = 'The security key was not found.';
  end if;

  update private.security_key_sessions security_session
  set revoked_at = clock_timestamp(), revoked_by = target_actor_employee_id
  where security_session.employee_id = target_employee_id
    and security_session.revoked_at is null;
  get diagnostics sessions_revoked_count = row_count;

  insert into private.audit_events (
    employee_id, request_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    target_actor_employee_id,
    nullif(btrim(target_request_id), ''),
    'private',
    'webauthn_credentials',
    'ADMIN_REVOKE',
    credential_record.id::text,
    jsonb_build_object(
      'employeeId', target_employee_id,
      'label', credential_record.label,
      'credentialId', credential_record.credential_id
    ),
    jsonb_build_object(
      'revokedBy', target_actor_employee_id,
      'securityKeySessionsRevoked', sessions_revoked_count
    )
  );

  return jsonb_build_object(
    'id', credential_record.id,
    'label', credential_record.label,
    'revoked', true,
    'securityKeySessionsRevoked', sessions_revoked_count
  );
end
$$;

revoke all on function public.service_rename_webauthn_credential(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_admin_revoke_webauthn_credential(uuid, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.service_rename_webauthn_credential(uuid, uuid, text, text) to service_role;
grant execute on function public.service_admin_revoke_webauthn_credential(uuid, uuid, uuid, text) to service_role;

commit;
