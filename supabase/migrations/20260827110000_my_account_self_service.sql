begin;

alter table private.employee_contacts
  add column if not exists personal_email_verified_at timestamptz;

create table if not exists private.employee_notification_preferences (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  schedule_published boolean not null default true,
  schedule_changed boolean not null default true,
  time_off_decision boolean not null default true,
  open_shift_available boolean not null default true,
  announcements boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists private.employee_email_verifications (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  requested_email text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  constraint employee_email_verifications_email_present
    check (btrim(requested_email) <> '' and position('@' in requested_email) > 1),
  constraint employee_email_verifications_hash_format
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint employee_email_verifications_expiration
    check (expires_at > created_at)
);

create index if not exists employee_email_verifications_employee_idx
  on private.employee_email_verifications(employee_id, created_at desc);

alter table private.employee_notification_preferences enable row level security;
alter table private.employee_email_verifications enable row level security;

revoke all on table private.employee_notification_preferences from public, anon, authenticated;
revoke all on table private.employee_email_verifications from public, anon, authenticated;

do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  update storage.buckets
  set
    public = false,
    file_size_limit = 5242880,
    allowed_mime_types = array['image/png', 'image/jpeg'],
    updated_at = clock_timestamp()
  where id = 'employee-photos';
end
$$;

create or replace function public.get_my_account()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  result jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'A signed-in SygShift account is required.';
  end if;

  select jsonb_build_object(
    'profile', jsonb_build_object(
      'employeeId', employee.id,
      'preferredName', employee.preferred_name,
      'displayName', btrim(coalesce(nullif(employee.preferred_name, ''), employee.first_name) || ' ' || employee.last_name),
      'personalEmail', contact.personal_email,
      'personalEmailVerifiedAt', contact.personal_email_verified_at,
      'companyEmail', contact.company_email,
      'mobilePhone', contact.mobile_phone,
      'hasPhoto', employee.photo_path is not null
    ),
    'employment', jsonb_build_object(
      'legalName', btrim(concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name)),
      'employeeNumber', employee.employee_number,
      'username', employee.username,
      'jobTitle', employee.job_title,
      'primaryRole', employee.role,
      'employmentType', employee.employment_type,
      'status', employee.status,
      'hiredOn', employee.hired_on
    ),
    'security', jsonb_build_object(
      'passwordChangedAt', account.password_changed_at,
      'mfaEnrolledAt', account.mfa_enrolled_at,
      'mfaRequired', private.employee_requires_mfa(employee.id),
      'lastSignInAt', account.last_sign_in_at,
      'trustedDeviceCount', (
        select count(*)::integer
        from private.trusted_devices trusted_device
        where trusted_device.employee_id = employee.id
          and trusted_device.revoked_at is null
          and trusted_device.expires_at > now()
      )
    ),
    'notifications', jsonb_build_object(
      'schedulePublished', coalesce(preference.schedule_published, true),
      'scheduleChanged', coalesce(preference.schedule_changed, true),
      'timeOffDecision', coalesce(preference.time_off_decision, true),
      'openShiftAvailable', coalesce(preference.open_shift_available, true),
      'announcements', coalesce(preference.announcements, true)
    ),
    'recentActivity', coalesce((
      select jsonb_agg(activity.record order by activity.occurred_at desc)
      from (
        select
          audit.occurred_at,
          jsonb_build_object(
            'occurredAt', audit.occurred_at,
            'operation', audit.operation,
            'area', case
              when audit.table_name in ('employee_contacts', 'employees') then 'Profile'
              when audit.table_name in ('employee_accounts', 'trusted_devices', 'mfa_recovery_codes') then 'Security'
              when audit.table_name = 'employee_notification_preferences' then 'Notifications'
              else 'Account'
            end
          ) as record
        from private.audit_events audit
        where audit.employee_id = employee.id
          and audit.table_name in (
            'employees',
            'employee_contacts',
            'employee_accounts',
            'trusted_devices',
            'mfa_recovery_codes',
            'employee_notification_preferences'
          )
        order by audit.occurred_at desc
        limit 8
      ) activity
    ), '[]'::jsonb)
  )
  into result
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  left join private.employee_contacts contact on contact.employee_id = employee.id
  left join private.employee_notification_preferences preference on preference.employee_id = employee.id
  where employee.id = actor_id;

  return result;
end
$$;

create or replace function public.update_my_account_profile(
  target_preferred_name text,
  target_mobile_phone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  previous_preferred text;
  previous_mobile text;
  normalized_preferred text := nullif(btrim(coalesce(target_preferred_name, '')), '');
  normalized_mobile text := nullif(btrim(coalesce(target_mobile_phone, '')), '');
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'A signed-in SygShift account is required.';
  end if;
  if normalized_preferred is not null and char_length(normalized_preferred) > 80 then
    raise exception using message = 'Preferred name must be 80 characters or fewer.';
  end if;
  if normalized_mobile is not null and normalized_mobile !~ '^\+?[0-9 ()-]{7,24}$' then
    raise exception using message = 'Enter a valid mobile phone number.';
  end if;

  select employee.preferred_name into previous_preferred
  from public.employees employee where employee.id = actor_id;
  select contact.mobile_phone into previous_mobile
  from private.employee_contacts contact where contact.employee_id = actor_id;

  update public.employees
  set preferred_name = normalized_preferred,
      updated_at = clock_timestamp()
  where id = actor_id;

  insert into private.employee_contacts (employee_id, mobile_phone)
  values (actor_id, normalized_mobile)
  on conflict (employee_id) do update
  set mobile_phone = excluded.mobile_phone,
      updated_at = clock_timestamp();

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), actor_id, 'private', 'employee_contacts', 'self_profile_update', actor_id::text,
    jsonb_build_object(
      'preferredNameChanged', previous_preferred is distinct from normalized_preferred,
      'mobilePhoneChanged', previous_mobile is distinct from normalized_mobile
    ),
    jsonb_build_object('profileUpdated', true)
  );

  return public.get_my_account();
end
$$;

create or replace function public.update_my_notification_preferences(
  target_schedule_published boolean,
  target_schedule_changed boolean,
  target_time_off_decision boolean,
  target_open_shift_available boolean,
  target_announcements boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  before_record jsonb;
  after_record jsonb;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'A signed-in SygShift account is required.';
  end if;

  select to_jsonb(preference) into before_record
  from private.employee_notification_preferences preference
  where preference.employee_id = actor_id;

  insert into private.employee_notification_preferences (
    employee_id, schedule_published, schedule_changed, time_off_decision,
    open_shift_available, announcements
  ) values (
    actor_id, target_schedule_published, target_schedule_changed, target_time_off_decision,
    target_open_shift_available, target_announcements
  )
  on conflict (employee_id) do update
  set schedule_published = excluded.schedule_published,
      schedule_changed = excluded.schedule_changed,
      time_off_decision = excluded.time_off_decision,
      open_shift_available = excluded.open_shift_available,
      announcements = excluded.announcements,
      updated_at = clock_timestamp()
  returning jsonb_build_object(
    'schedulePublished', schedule_published,
    'scheduleChanged', schedule_changed,
    'timeOffDecision', time_off_decision,
    'openShiftAvailable', open_shift_available,
    'announcements', announcements
  ) into after_record;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), actor_id, 'private', 'employee_notification_preferences',
    'self_notification_preferences_update', actor_id::text, before_record, after_record
  );

  return after_record;
end
$$;

create or replace function public.service_create_email_verification(
  target_employee_id uuid,
  target_email text,
  target_token_hash text,
  target_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_user <> 'service_role' and (select auth.role()) <> 'service_role' then
    raise insufficient_privilege;
  end if;

  if exists (
    select 1
    from private.employee_email_verifications verification
    where verification.employee_id = target_employee_id
      and verification.verified_at is null
      and verification.created_at > clock_timestamp() - interval '1 minute'
  ) then
    raise exception using message = 'A verification email was sent recently. Wait one minute and try again.';
  end if;

  delete from private.employee_email_verifications
  where employee_id = target_employee_id
    and verified_at is null;

  insert into private.employee_email_verifications (
    employee_id, requested_email, token_hash, expires_at
  ) values (
    target_employee_id, lower(btrim(target_email)), target_token_hash, target_expires_at
  );
end
$$;

create or replace function public.service_filter_notification_recipients(
  target_message_type text,
  target_aggregate_id uuid,
  target_recipients jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  recipient text;
  recipient_employee_id uuid;
  announcement_type public.announcement_kind;
  allowed boolean;
  result jsonb := '[]'::jsonb;
begin
  if current_user <> 'service_role' and (select auth.role()) <> 'service_role' then
    raise insufficient_privilege;
  end if;

  if target_message_type = 'call_off_supervisor_alert' then
    return coalesce(target_recipients, '[]'::jsonb);
  end if;

  if target_message_type = 'announcement_published' and target_aggregate_id is not null then
    select announcement.kind
    into announcement_type
    from public.announcements announcement
    where announcement.id = target_aggregate_id;
  end if;

  for recipient in
    select distinct lower(btrim(item.value))
    from jsonb_array_elements_text(coalesce(target_recipients, '[]'::jsonb)) item(value)
    where nullif(btrim(item.value), '') is not null
  loop
    recipient_employee_id := null;
    allowed := true;

    select employee.id
    into recipient_employee_id
    from public.employees employee
    join private.employee_contacts contact on contact.employee_id = employee.id
    where employee.status in ('active', 'leave')
      and private.preferred_delivery_email(contact.personal_email, contact.company_email) = recipient
    order by employee.created_at
    limit 1;

    if recipient_employee_id is not null then
      select case
        when target_message_type = 'schedule_published' then coalesce(preference.schedule_published, true)
        when target_message_type = 'schedule_changed' then coalesce(preference.schedule_changed, true)
        when target_message_type = 'time_off_decision' then coalesce(preference.time_off_decision, true)
        when target_message_type = 'open_shift_available' then coalesce(preference.open_shift_available, true)
        when target_message_type = 'announcement_published' and announcement_type in ('open_shift', 'overtime', 'event')
          then coalesce(preference.open_shift_available, true)
        when target_message_type = 'announcement_published' then coalesce(preference.announcements, true)
        else true
      end
      into allowed
      from public.employees employee
      left join private.employee_notification_preferences preference on preference.employee_id = employee.id
      where employee.id = recipient_employee_id;
    end if;

    if allowed then
      result := result || jsonb_build_array(recipient);
    end if;
  end loop;

  return result;
end
$$;

create or replace function public.service_confirm_email_verification(
  target_token_hash text,
  target_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  verification private.employee_email_verifications%rowtype;
begin
  if current_user <> 'service_role' and (select auth.role()) <> 'service_role' then
    raise insufficient_privilege;
  end if;

  select * into verification
  from private.employee_email_verifications item
  where item.token_hash = target_token_hash
    and item.verified_at is null
    and item.expires_at > now()
  for update;

  if verification.id is null then
    raise exception using message = 'This verification link is invalid or has expired.';
  end if;
  if verification.employee_id <> target_employee_id then
    raise insufficient_privilege using message = 'Sign in to the account that requested this email change.';
  end if;

  insert into private.employee_contacts (
    employee_id, personal_email, personal_email_verified_at
  ) values (
    verification.employee_id, verification.requested_email, clock_timestamp()
  )
  on conflict (employee_id) do update
  set personal_email = excluded.personal_email,
      personal_email_verified_at = excluded.personal_email_verified_at,
      updated_at = clock_timestamp();

  update private.employee_email_verifications
  set verified_at = clock_timestamp()
  where id = verification.id;

  insert into private.audit_events (
    employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    verification.employee_id, 'private', 'employee_contacts', 'personal_email_verified',
    verification.employee_id::text,
    jsonb_build_object('verified', false),
    jsonb_build_object('emailChanged', true, 'verified', true)
  );

  return jsonb_build_object(
    'employeeId', verification.employee_id,
    'email', verification.requested_email,
    'verifiedAt', clock_timestamp()
  );
end
$$;

create or replace function public.service_update_employee_photo(
  target_employee_id uuid,
  target_photo_path text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  previous_path text;
begin
  if current_user <> 'service_role' and (select auth.role()) <> 'service_role' then
    raise insufficient_privilege;
  end if;

  select employee.photo_path into previous_path
  from public.employees employee
  where employee.id = target_employee_id
  for update;

  update public.employees
  set photo_path = nullif(btrim(coalesce(target_photo_path, '')), ''),
      updated_at = clock_timestamp()
  where id = target_employee_id;

  insert into private.audit_events (
    employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    target_employee_id, 'public', 'employees', 'self_photo_update', target_employee_id::text,
    jsonb_build_object('hasPhoto', previous_path is not null),
    jsonb_build_object('hasPhoto', nullif(btrim(coalesce(target_photo_path, '')), '') is not null)
  );

  return previous_path;
end
$$;

create or replace function public.service_get_employee_photo_path(target_employee_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result text;
begin
  if current_user <> 'service_role' and (select auth.role()) <> 'service_role' then
    raise insufficient_privilege;
  end if;

  select employee.photo_path into result
  from public.employees employee
  where employee.id = target_employee_id;

  return result;
end
$$;

create or replace function public.mark_password_changed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  current_auth_user_id uuid := (select auth.uid());
begin
  if actor_id is null or current_auth_user_id is null then
    raise insufficient_privilege
      using message = 'A linked active SygShift account is required.';
  end if;

  update private.employee_accounts account
  set
    must_change_password = false,
    password_changed_at = clock_timestamp(),
    activated_at = coalesce(account.activated_at, clock_timestamp()),
    updated_at = clock_timestamp()
  from public.employees employee
  where employee.id = account.employee_id
    and employee.id = actor_id
    and account.auth_user_id = current_auth_user_id
    and account.disabled_at is null
    and employee.status in ('active', 'leave');

  if not found then
    raise insufficient_privilege
      using message = 'A linked active SygShift account is required.';
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    current_auth_user_id, actor_id, 'private', 'employee_accounts',
    'self_password_changed', actor_id::text, jsonb_build_object('passwordChanged', true)
  );
end
$$;

create or replace function public.revoke_current_trusted_device(target_trusted_device_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  removed_label text;
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  update private.trusted_devices trusted_device
  set
    revoked_at = clock_timestamp(),
    revoked_by = actor_id
  where trusted_device.id = target_trusted_device_id
    and trusted_device.employee_id = actor_id
    and trusted_device.revoked_at is null
  returning trusted_device.device_label into removed_label;

  if not found then
    raise exception using message = 'That remembered device is no longer active.';
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'private', 'trusted_devices',
    'self_trusted_device_revoked', target_trusted_device_id::text,
    jsonb_build_object('deviceLabel', removed_label, 'revoked', true)
  );
end
$$;

create or replace function public.record_my_account_security_action(target_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if target_action <> 'sign_out_other_sessions' then
    raise exception using message = 'Unsupported account security action.';
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'private', 'employee_accounts',
    'self_other_sessions_signed_out', actor_id::text,
    jsonb_build_object('otherSessionsSignedOut', true)
  );
end
$$;

revoke all on function public.get_my_account() from public, anon;
revoke all on function public.update_my_account_profile(text, text) from public, anon;
revoke all on function public.update_my_notification_preferences(boolean, boolean, boolean, boolean, boolean) from public, anon;
revoke all on function public.service_create_email_verification(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.service_confirm_email_verification(text, uuid) from public, anon, authenticated;
revoke all on function public.service_filter_notification_recipients(text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.service_update_employee_photo(uuid, text) from public, anon, authenticated;
revoke all on function public.service_get_employee_photo_path(uuid) from public, anon, authenticated;
revoke all on function public.mark_password_changed() from public, anon;
revoke all on function public.revoke_current_trusted_device(uuid) from public, anon;
revoke all on function public.record_my_account_security_action(text) from public, anon;

grant execute on function public.get_my_account() to authenticated;
grant execute on function public.update_my_account_profile(text, text) to authenticated;
grant execute on function public.update_my_notification_preferences(boolean, boolean, boolean, boolean, boolean) to authenticated;
grant execute on function public.service_create_email_verification(uuid, text, text, timestamptz) to service_role;
grant execute on function public.service_confirm_email_verification(text, uuid) to service_role;
grant execute on function public.service_filter_notification_recipients(text, uuid, jsonb) to service_role;
grant execute on function public.service_update_employee_photo(uuid, text) to service_role;
grant execute on function public.service_get_employee_photo_path(uuid) to service_role;
grant execute on function public.mark_password_changed() to authenticated;
grant execute on function public.revoke_current_trusted_device(uuid) to authenticated;
grant execute on function public.record_my_account_security_action(text) to authenticated;

commit;
