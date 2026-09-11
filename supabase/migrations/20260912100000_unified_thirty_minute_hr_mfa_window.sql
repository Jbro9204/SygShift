-- One recent factor verification authorizes otherwise-permitted HR work for a
-- fixed 30-minute window. Navigation and ordinary activity never extend it.

create index if not exists employee_mfa_reset_events_employee_recency_idx
  on private.employee_mfa_reset_events (employee_id, reset_at desc);

create index if not exists employee_password_reset_events_employee_recency_idx
  on private.employee_password_reset_events (employee_id, requested_at desc);

create index if not exists security_key_sessions_employee_session_recency_idx
  on private.security_key_sessions (employee_id, auth_session_id, created_at desc)
  where revoked_at is null;

create or replace function public.service_verify_recent_hr_mfa(
  target_actor_id uuid,
  target_auth_session_id uuid,
  target_method text,
  target_verified_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  verified_at timestamptz;
  security_cutoff timestamptz;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  select greatest(
    coalesce(account.password_changed_at, '-infinity'::timestamptz),
    coalesce((select max(reset_event.requested_at)
      from private.employee_password_reset_events reset_event
      where reset_event.employee_id = target_actor_id), '-infinity'::timestamptz),
    coalesce((select max(reset_event.reset_at)
      from private.employee_mfa_reset_events reset_event
      where reset_event.employee_id = target_actor_id), '-infinity'::timestamptz)
  )
  into security_cutoff
  from private.employee_accounts account
  where account.employee_id = target_actor_id
    and account.disabled_at is null;

  if security_cutoff is null or target_auth_session_id is null then
    return null;
  end if;

  if target_method = 'authenticator' then
    if target_verified_at is null
      or target_verified_at < clock_timestamp() - interval '30 minutes'
      or target_verified_at > clock_timestamp() + interval '1 minute'
      or target_verified_at <= security_cutoff then
      return null;
    end if;
    return jsonb_build_object('method', 'authenticator', 'verifiedAt', target_verified_at);
  end if;

  if target_method = 'security_key' then
    select security_session.created_at
    into verified_at
    from private.security_key_sessions security_session
    where security_session.employee_id = target_actor_id
      and security_session.auth_session_id = target_auth_session_id
      and security_session.revoked_at is null
      and security_session.expires_at > clock_timestamp()
      and security_session.created_at >= clock_timestamp() - interval '30 minutes'
      and security_session.created_at > security_cutoff
    order by security_session.created_at desc
    limit 1;
  end if;

  if verified_at is null then
    return null;
  end if;

  return jsonb_build_object('method', 'security_key', 'verifiedAt', verified_at);
end
$$;

create or replace function public.service_issue_hr_document_access_grant(
  target_actor_id uuid,
  target_document_id uuid,
  target_action text,
  target_token_hash text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  document_record private.hr_documents%rowtype;
  grant_id uuid;
  expires_at timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  if target_action not in ('preview', 'view', 'download') then raise check_violation using message = 'Unsupported document access action.'; end if;
  if target_mfa_method not in ('authenticator', 'security_key')
    or target_mfa_verified_at is null
    or target_mfa_verified_at < clock_timestamp() - interval '30 minutes'
    or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent MFA verification is required.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' then raise check_violation using message = 'The access token is invalid.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'An access reason is required.'; end if;

  select * into document_record
  from private.hr_documents document
  where document.id = target_document_id and document.archived_at is null;
  if document_record.id is null or document_record.current_version_id is null then raise no_data_found using message = 'The document is unavailable.'; end if;
  perform private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'view');
  if private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean' then
    raise insufficient_privilege using message = 'The document has not passed malware scanning.';
  end if;

  insert into private.hr_document_access_grants (
    token_hash, actor_employee_id, document_id, version_id, action, mfa_method,
    mfa_verified_at, reason, request_id, expires_at
  ) values (
    target_token_hash, target_actor_id, document_record.id, document_record.current_version_id,
    target_action, target_mfa_method, target_mfa_verified_at, target_reason,
    nullif(btrim(target_request_id), ''), expires_at
  ) returning id into grant_id;
  return jsonb_build_object('grantId', grant_id, 'expiresAt', expires_at);
end
$$;

revoke all on function public.service_verify_recent_hr_mfa(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.service_verify_recent_hr_mfa(uuid, uuid, text, timestamptz)
  to service_role;

-- A freshly verified security key belongs to the authenticated Supabase
-- session, not to a browser tab. Sibling tabs can therefore reuse the same
-- 30-minute proof without copying the opaque key token into localStorage.
create or replace function public.has_security_key_session()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  session_token text := private.request_header('x-sygshift-security-key');
  jwt_session_id_text text := (select auth.jwt() ->> 'session_id');
  jwt_session_id uuid;
begin
  if actor_id is null or jwt_session_id_text is null then
    return false;
  end if;

  begin
    jwt_session_id := jwt_session_id_text::uuid;
  exception when others then
    return false;
  end;

  return exists (
    select 1
    from private.security_key_sessions security_session
    where security_session.employee_id = actor_id
      and security_session.auth_session_id = jwt_session_id
      and security_session.revoked_at is null
      and security_session.expires_at > clock_timestamp()
      and (
        security_session.created_at >= clock_timestamp() - interval '30 minutes'
        or (
          session_token is not null
          and session_token ~ '^[A-Za-z0-9_-]{40,180}$'
          and security_session.token_hash = encode(extensions.digest(session_token, 'sha256'), 'hex')
        )
      )
  );
end
$$;

revoke all on function public.has_security_key_session() from public, anon;
grant execute on function public.has_security_key_session() to authenticated;

create or replace function private.hr_compensation_require_recent_mfa(target_method text, target_verified_at timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '30 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'Recent MFA verification is required for compensation access.';
  end if;
end
$$;

create or replace function private.hr_stage8_require_recent_mfa(target_method text, target_verified_at timestamptz, target_scope text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '30 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = format('Recent MFA verification is required for %s access.', target_scope);
  end if;
end
$$;

create or replace function private.hr_stage9_require_recent_mfa(target_method text, target_verified_at timestamptz, target_scope text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '30 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = format('Recent MFA verification is required for %s access.', target_scope);
  end if;
end
$$;

create or replace function private.hr_stage10_require_recent_mfa(target_method text, target_verified_at timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'totp', 'security_key', 'webauthn', 'recovery_code')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '30 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'Recent MFA verification is required for payroll integration access.';
  end if;
end
$$;

-- Keep the legacy third parameter for deployed callers, but deliberately use
-- one fixed maximum age so elevated documents do not create a stricter timer.
create or replace function private.document_studio_require_recent_mfa(
  target_method text,
  target_verified_at timestamptz,
  target_maximum_age interval default interval '30 minutes'
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if target_method not in ('authenticator', 'security_key')
    or target_verified_at is null
    or target_verified_at < clock_timestamp() - interval '30 minutes'
    or target_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent identity verification is required.';
  end if;
end
$$;

create or replace function public.service_issue_my_hr_document_access_grant(
  target_actor_id uuid,
  target_assignment_id uuid,
  target_action text,
  target_token_hash text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  assignment_record private.hr_document_assignments%rowtype;
  grant_id uuid;
  grant_expires_at timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  perform private.service_require_active_hr_document_employee(target_actor_id);
  select * into assignment_record from private.hr_document_assignments
  where id = target_assignment_id and employee_id = target_actor_id and status in ('pending', 'completed');
  if assignment_record.id is null then raise insufficient_privilege using message = 'The assigned document is unavailable.'; end if;
  if target_action not in ('preview', 'view', 'download') then raise check_violation using message = 'Unsupported document action.'; end if;
  if target_mfa_method not in ('authenticator', 'security_key')
    or target_mfa_verified_at is null
    or target_mfa_verified_at < clock_timestamp() - interval '30 minutes'
    or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent MFA verification is required.';
  end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' or btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'The protected access request is incomplete.'; end if;
  if private.hr_document_latest_scan_state(assignment_record.version_id) <> 'clean' then raise insufficient_privilege using message = 'The document is unavailable.'; end if;
  insert into private.hr_document_access_grants(token_hash, actor_employee_id, document_id, version_id, action, mfa_method,
    mfa_verified_at, reason, request_id, expires_at, authorization_source, assignment_id)
  values (target_token_hash, target_actor_id, assignment_record.document_id, assignment_record.version_id, target_action,
    target_mfa_method, target_mfa_verified_at, target_reason, nullif(btrim(target_request_id), ''), grant_expires_at,
    'assignment', assignment_record.id)
  returning id into grant_id;
  return jsonb_build_object('grantId', grant_id, 'expiresAt', grant_expires_at);
end
$$;

create or replace function public.service_complete_hr_document_assignment(
  target_actor_id uuid,
  target_assignment_id uuid,
  target_action text,
  target_legal_name text,
  target_confirmed boolean,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  assignment_record private.hr_document_assignments%rowtype;
  version_record private.hr_document_versions%rowtype;
  legal_name text;
  evidence_id uuid;
  expected_action text;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  perform private.service_require_active_hr_document_employee(target_actor_id);
  select * into assignment_record from private.hr_document_assignments where id = target_assignment_id and employee_id = target_actor_id for update;
  if assignment_record.id is null or assignment_record.status <> 'pending' then raise check_violation using message = 'This document assignment is not pending.'; end if;
  expected_action := case assignment_record.requirement_type when 'acknowledgment' then 'acknowledge' else 'sign' end;
  if target_action <> expected_action or not coalesce(target_confirmed, false) then raise check_violation using message = 'Confirm the exact required document action.'; end if;
  select concat_ws(' ', employee.first_name, nullif(btrim(employee.middle_name), ''), employee.last_name)
    into legal_name from public.employees employee where employee.id = target_actor_id;
  if lower(regexp_replace(btrim(coalesce(target_legal_name, '')), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(legal_name), '\s+', ' ', 'g')) then
    raise check_violation using message = 'Enter your complete legal name exactly as shown in My Account.';
  end if;
  if target_mfa_method not in ('authenticator', 'security_key')
    or target_mfa_verified_at is null
    or target_mfa_verified_at < clock_timestamp() - interval '30 minutes'
    or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent MFA verification is required.';
  end if;
  select * into version_record from private.hr_document_versions where id = assignment_record.version_id;
  if version_record.id is null or private.hr_document_latest_scan_state(version_record.id) <> 'clean' then raise insufficient_privilege using message = 'The assigned document version is unavailable.'; end if;
  if not exists (select 1 from private.hr_documents document where document.id = assignment_record.document_id and document.archived_at is null and document.current_version_id = assignment_record.version_id) then
    raise check_violation using message = 'The document has changed. Ask HR to issue a new assignment.';
  end if;
  insert into private.hr_document_completion_evidence(assignment_id, employee_id, document_id, version_id, completion_action,
    legal_name_snapshot, statement_snapshot, version_checksum_snapshot, authentication_method, authentication_verified_at,
    request_id, metadata)
  values (assignment_record.id, target_actor_id, assignment_record.document_id, assignment_record.version_id, expected_action,
    legal_name, assignment_record.statement_snapshot, version_record.sha256_checksum, target_mfa_method,
    target_mfa_verified_at, nullif(btrim(target_request_id), ''), jsonb_build_object('explicitConfirmation', true))
  returning id into evidence_id;
  update private.hr_document_assignments set status = 'completed', completed_at = clock_timestamp(),
    completion_evidence_id = evidence_id, updated_at = clock_timestamp() where id = assignment_record.id;
  insert into private.hr_document_assignment_events(assignment_id, action, actor_employee_id, reason, metadata)
  values (assignment_record.id, case when expected_action = 'sign' then 'signed' else 'acknowledged' end,
    target_actor_id, 'Employee completed the assigned document action.', jsonb_build_object('evidenceId', evidence_id, 'requestId', target_request_id));
  insert into private.hr_document_access_events(document_id, version_id, action, actor_employee_id, request_id, reason, metadata)
  values (assignment_record.document_id, assignment_record.version_id, expected_action, target_actor_id,
    nullif(btrim(target_request_id), ''), 'Employee completed an assigned document action.',
    jsonb_build_object('assignmentId', assignment_record.id, 'evidenceId', evidence_id, 'mfaMethod', target_mfa_method));
  return jsonb_build_object('id', assignment_record.id, 'status', 'completed', 'evidenceId', evidence_id, 'completedAt', clock_timestamp());
end
$$;
