update private.employee_accounts account
set activated_at = auth_user.last_sign_in_at
from auth.users auth_user
where auth_user.id = account.auth_user_id
  and account.activated_at is null
  and auth_user.last_sign_in_at is not null;

create or replace function private.admin_user_record(target_employee_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', employee.id,
    'employeeNumber', employee.employee_number,
    'jobTitle', employee.job_title,
    'username', employee.username,
    'firstName', employee.first_name,
    'middleName', employee.middle_name,
    'lastName', employee.last_name,
    'preferredName', employee.preferred_name,
    'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
    'role', employee.role,
    'employmentType', employee.employment_type,
    'status', employee.status,
    'photoPath', employee.photo_path,
    'hiredOn', employee.hired_on,
    'separatedOn', employee.separated_on,
    'personalEmail', contact.personal_email,
    'companyEmail', contact.company_email,
    'mobilePhone', contact.mobile_phone,
    'account', case when account.employee_id is null then null else jsonb_build_object(
      'authUserId', account.auth_user_id,
      'invitedAt', account.invited_at,
      'activatedAt', coalesce(account.activated_at, auth_user.last_sign_in_at),
      'disabledAt', account.disabled_at,
      'lastSignInAt', coalesce(auth_user.last_sign_in_at, account.last_sign_in_at),
      'mustChangePassword', account.must_change_password,
      'passwordChangedAt', account.password_changed_at,
      'mfaEnrolledAt', account.mfa_enrolled_at,
      'isBootstrapAdmin', account.is_bootstrap_admin,
      'status', case when account.disabled_at is not null then 'disabled' else 'active' end,
      'trustedDeviceCount', (
        select count(*)::integer
        from private.trusted_devices trusted_device
        where trusted_device.employee_id = employee.id
          and trusted_device.revoked_at is null
          and trusted_device.expires_at > now()
      )
    ) end,
    'accountStatus', case
      when account.employee_id is null then 'not_created'
      when account.disabled_at is not null then 'disabled'
      else 'active'
    end,
    'credentials', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', credential.id,
        'kind', credential.kind,
        'status', credential.status,
        'credentialNumber', credential.credential_number,
        'validFrom', credential.valid_from,
        'expiresOn', credential.expires_on,
        'notes', credential.notes
      ) order by credential.kind, credential.expires_on nulls last)
      from public.employee_credentials credential
      where credential.employee_id = employee.id
    ), '[]'::jsonb)
  )
  from public.employees employee
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_accounts account on account.employee_id = employee.id
  left join auth.users auth_user on auth_user.id = account.auth_user_id
  where employee.id = target_employee_id
$$;

revoke all on function private.admin_user_record(uuid) from public, anon, authenticated;
