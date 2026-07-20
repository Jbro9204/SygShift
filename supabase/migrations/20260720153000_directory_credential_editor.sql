begin;

create or replace function private.require_credential_editor_mfa()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  actor_role public.app_role := public.current_app_role();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if actor_role not in ('scheduler', 'supervisor', 'admin') or not public.has_mfa() then
    raise insufficient_privilege using message = 'Scheduler, supervisor, or administrator access with MFA is required to update credentials.';
  end if;

  return actor_id;
end
$$;

create or replace function private.directory_employee_record(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', employee.id,
    'employee_number', employee.employee_number,
    'job_title', employee.job_title,
    'username', employee.username,
    'first_name', employee.first_name,
    'middle_name', employee.middle_name,
    'last_name', employee.last_name,
    'preferred_name', employee.preferred_name,
    'role', employee.role,
    'employment_type', employee.employment_type,
    'status', employee.status,
    'photo_path', employee.photo_path,
    'hired_on', employee.hired_on,
    'personal_email', contact.personal_email,
    'company_email', contact.company_email,
    'mobile_phone', contact.mobile_phone,
    'credentials', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'kind', credential.kind,
            'status', credential.status,
            'credential_number', credential.credential_number,
            'valid_from', credential.valid_from,
            'expires_on', credential.expires_on,
            'notes', credential.notes
          )
          order by credential.kind, credential.expires_on nulls last
        )
        from public.employee_credentials credential
        where credential.employee_id = employee.id
      ),
      '[]'::jsonb
    ),
    'operational_profile', case when profile.employee_id is null then null else jsonb_build_object(
      'sourceDisplayName', profile.source_display_name,
      'locationText', profile.location_text,
      'scheduleAvailability', profile.schedule_availability,
      'employeeDg', profile.employee_dg,
      'expectedHoursText', profile.expected_hours_text,
      'sourceNotes', profile.source_notes,
      'supervisorLabel', profile.supervisor_label,
      'armedSourceClaim', profile.armed_source_claim
    ) end
  )
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_operational_profiles profile on profile.employee_id = employee.id
  where employee.id = target_employee_id
$$;

create or replace function public.upsert_employee_credential(
  target_employee_id uuid,
  target_kind public.credential_kind,
  target_status public.credential_status,
  target_credential_number text default null,
  target_valid_from date default null,
  target_expires_on date default null,
  target_notes text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  credential_id uuid;
  clean_number text := nullif(btrim(coalesce(target_credential_number, '')), '');
  clean_notes text := nullif(btrim(coalesce(target_notes, '')), '');
begin
  actor_id := private.require_credential_editor_mfa();

  if not exists (select 1 from public.employees employee where employee.id = target_employee_id) then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if target_expires_on is not null and target_valid_from is not null and target_expires_on < target_valid_from then
    raise check_violation using message = 'Credential expiration cannot be before the valid-from date.';
  end if;

  if target_kind = 'armed_guard'
    and target_status = 'active'
    and (clean_number is null or target_expires_on is null or target_expires_on < current_date)
  then
    raise check_violation using message = 'An active armed credential requires a number and a current expiration date.';
  end if;

  select credential.id into credential_id
  from public.employee_credentials credential
  where credential.employee_id = target_employee_id
    and credential.kind = target_kind
  order by credential.created_at desc
  limit 1;

  if credential_id is null then
    insert into public.employee_credentials (
      employee_id,
      kind,
      status,
      credential_number,
      valid_from,
      expires_on,
      verified_at,
      verified_by,
      notes
    ) values (
      target_employee_id,
      target_kind,
      target_status,
      clean_number,
      target_valid_from,
      target_expires_on,
      case when target_status = 'active' then clock_timestamp() else null end,
      case when target_status = 'active' then actor_id else null end,
      clean_notes
    );
  else
    update public.employee_credentials
    set
      status = target_status,
      credential_number = clean_number,
      valid_from = target_valid_from,
      expires_on = target_expires_on,
      verified_at = case when target_status = 'active' then coalesce(verified_at, clock_timestamp()) else verified_at end,
      verified_by = case when target_status = 'active' then coalesce(verified_by, actor_id) else verified_by end,
      notes = clean_notes
    where id = credential_id;
  end if;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employee_credentials',
    'DIRECTORY_CREDENTIAL_UPSERT',
    target_employee_id::text,
    private.directory_employee_record(target_employee_id)
  );

  return private.directory_employee_record(target_employee_id);
end
$$;

revoke all on function private.require_credential_editor_mfa() from public, anon, authenticated;
revoke all on function private.directory_employee_record(uuid) from public, anon, authenticated;
revoke all on function public.upsert_employee_credential(uuid, public.credential_kind, public.credential_status, text, date, date, text) from public, anon;

grant execute on function public.upsert_employee_credential(uuid, public.credential_kind, public.credential_status, text, date, date, text) to authenticated;

commit;
