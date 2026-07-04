begin;

create or replace function private.require_admin_mfa()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.is_admin() or not public.has_mfa() then
    raise insufficient_privilege using message = 'Admin access with MFA is required.';
  end if;

  return actor_id;
end
$$;

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
      'activatedAt', account.activated_at,
      'disabledAt', account.disabled_at,
      'lastSignInAt', account.last_sign_in_at,
      'mustChangePassword', account.must_change_password,
      'passwordChangedAt', account.password_changed_at,
      'mfaEnrolledAt', account.mfa_enrolled_at,
      'isBootstrapAdmin', account.is_bootstrap_admin,
      'status', case when account.disabled_at is not null then 'disabled' else 'active' end
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
  where employee.id = target_employee_id
$$;

create or replace function private.active_admin_account_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.employees employee
  join private.employee_accounts account on account.employee_id = employee.id
  where employee.role = 'admin'
    and employee.status = 'active'
    and account.disabled_at is null
$$;

create or replace function public.get_admin_user_directory()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  records jsonb;
begin
  actor_id := private.require_admin_mfa();

  select coalesce(jsonb_agg(private.admin_user_record(employee.id) order by employee.last_name, employee.first_name, employee.id), '[]'::jsonb)
  into records
  from public.employees employee;

  return jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'currentEmployeeId', actor_id,
    'users', records
  );
end
$$;

create or replace function public.admin_create_employee(
  target_first_name text,
  target_middle_name text default null,
  target_last_name text default null,
  target_preferred_name text default null,
  target_role public.app_role default 'guard',
  target_employment_type public.employment_type default 'hourly',
  target_status public.employee_status default 'active',
  target_employee_number text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  employee_id uuid;
begin
  actor_id := private.require_admin_mfa();

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  insert into public.employees (
    employee_number,
    first_name,
    middle_name,
    last_name,
    preferred_name,
    role,
    employment_type,
    status
  ) values (
    nullif(btrim(coalesce(target_employee_number, '')), ''),
    btrim(target_first_name),
    nullif(btrim(coalesce(target_middle_name, '')), ''),
    btrim(target_last_name),
    nullif(btrim(coalesce(target_preferred_name, '')), ''),
    target_role,
    target_employment_type,
    target_status
  )
  returning id into employee_id;

  if coalesce(target_personal_email, target_company_email, target_mobile_phone) is not null then
    insert into private.employee_contacts (
      employee_id,
      personal_email,
      company_email,
      mobile_phone
    ) values (
      employee_id,
      nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
      nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
      nullif(btrim(coalesce(target_mobile_phone, '')), '')
    );
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
    'employees',
    'ADMIN_CREATE',
    employee_id::text,
    private.admin_user_record(employee_id)
  );

  return private.admin_user_record(employee_id);
end
$$;

create or replace function public.admin_update_employee(
  target_employee_id uuid,
  target_first_name text,
  target_middle_name text,
  target_last_name text,
  target_preferred_name text,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_status public.employee_status,
  target_employee_number text default null,
  target_personal_email text default null,
  target_company_email text default null,
  target_mobile_phone text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  before_record jsonb;
  after_record jsonb;
begin
  actor_id := private.require_admin_mfa();
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if btrim(coalesce(target_first_name, '')) = '' or btrim(coalesce(target_last_name, '')) = '' then
    raise check_violation using message = 'First and last name are required.';
  end if;

  if target_personal_email is not null
    and btrim(target_personal_email) <> ''
    and btrim(target_personal_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The personal email address is invalid.';
  end if;

  if target_company_email is not null
    and btrim(target_company_email) <> ''
    and btrim(target_company_email) !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  then
    raise check_violation using message = 'The company email address is invalid.';
  end if;

  if (before_record ->> 'role') = 'admin'
    and (
      target_role <> 'admin'
      or target_status <> 'active'
    )
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  update public.employees
  set
    employee_number = nullif(btrim(coalesce(target_employee_number, '')), ''),
    first_name = btrim(target_first_name),
    middle_name = nullif(btrim(coalesce(target_middle_name, '')), ''),
    last_name = btrim(target_last_name),
    preferred_name = nullif(btrim(coalesce(target_preferred_name, '')), ''),
    role = target_role,
    employment_type = target_employment_type,
    status = target_status
  where id = target_employee_id;

  insert into private.employee_contacts (
    employee_id,
    personal_email,
    company_email,
    mobile_phone
  ) values (
    target_employee_id,
    nullif(lower(btrim(coalesce(target_personal_email, ''))), ''),
    nullif(lower(btrim(coalesce(target_company_email, ''))), ''),
    nullif(btrim(coalesce(target_mobile_phone, '')), '')
  )
  on conflict (employee_id) do update set
    personal_email = excluded.personal_email,
    company_email = excluded.company_email,
    mobile_phone = excluded.mobile_phone,
    updated_at = clock_timestamp();

  after_record := private.admin_user_record(target_employee_id);

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'public',
    'employees',
    'ADMIN_UPDATE',
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

create or replace function public.admin_set_employee_account_state(
  target_employee_id uuid,
  target_disabled boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  before_record jsonb;
  after_record jsonb;
begin
  actor_id := private.require_admin_mfa();
  before_record := private.admin_user_record(target_employee_id);

  if before_record is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if (before_record ->> 'role') = 'admin'
    and target_disabled
    and private.active_admin_account_count() <= 1
  then
    raise check_violation using message = 'At least one active admin account must remain.';
  end if;

  if not exists (select 1 from private.employee_accounts account where account.employee_id = target_employee_id) then
    raise check_violation using message = 'A login account has not been created for this employee yet.';
  end if;

  update private.employee_accounts
  set
    disabled_at = case when target_disabled then coalesce(disabled_at, clock_timestamp()) else null end,
    updated_at = clock_timestamp()
  where employee_id = target_employee_id;

  after_record := private.admin_user_record(target_employee_id);

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    (select auth.uid()),
    actor_id,
    'private',
    'employee_accounts',
    case when target_disabled then 'ADMIN_DISABLE' else 'ADMIN_ENABLE' end,
    target_employee_id::text,
    before_record,
    after_record
  );

  return after_record;
end
$$;

create or replace function public.service_get_employee_auth_target(
  target_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  employee_record public.employees%rowtype;
  account_record private.employee_accounts%rowtype;
begin
  select * into employee_record
  from public.employees employee
  where employee.id = target_employee_id;

  if employee_record.id is null then
    raise no_data_found using message = 'The employee record was not found.';
  end if;

  if employee_record.status <> 'active' then
    raise check_violation using message = 'Only active employees can receive login accounts.';
  end if;

  select * into account_record
  from private.employee_accounts account
  where account.employee_id = employee_record.id;

  return jsonb_build_object(
    'employeeId', employee_record.id,
    'username', employee_record.username,
    'authEmail', employee_record.username || '@accounts.sygshift.invalid',
    'displayName', btrim(coalesce(employee_record.preferred_name, employee_record.first_name) || ' ' || employee_record.last_name),
    'role', employee_record.role,
    'employmentType', employee_record.employment_type,
    'status', employee_record.status,
    'existingAuthUserId', account_record.auth_user_id
  );
end
$$;

create or replace function public.service_get_employee_auth_targets(
  target_include_existing boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'employeeId', employee.id,
      'username', employee.username,
      'authEmail', employee.username || '@accounts.sygshift.invalid',
      'displayName', btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name),
      'role', employee.role,
      'employmentType', employee.employment_type,
      'status', employee.status,
      'existingAuthUserId', account.auth_user_id
    ) order by employee.last_name, employee.first_name)
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    where employee.status = 'active'
      and (target_include_existing or account.employee_id is null)
  ), '[]'::jsonb);
end
$$;

create or replace function public.service_link_employee_auth_account(
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_must_change_password boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing_account private.employee_accounts%rowtype;
begin
  if target_employee_id is null or target_auth_user_id is null then
    raise check_violation using message = 'Employee and auth user identifiers are required.';
  end if;

  if not exists (
    select 1 from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
  ) then
    raise check_violation using message = 'Only active employees can receive login accounts.';
  end if;

  if not exists (select 1 from auth.users auth_user where auth_user.id = target_auth_user_id) then
    raise foreign_key_violation using message = 'The Supabase auth user does not exist.';
  end if;

  select * into existing_account
  from private.employee_accounts account
  where account.employee_id = target_employee_id;

  if existing_account.employee_id is not null and existing_account.auth_user_id <> target_auth_user_id then
    raise unique_violation using message = 'This employee is already linked to a different auth account.';
  end if;

  insert into private.employee_accounts (
    employee_id,
    auth_user_id,
    invited_at,
    disabled_at,
    must_change_password
  ) values (
    target_employee_id,
    target_auth_user_id,
    clock_timestamp(),
    null,
    target_must_change_password
  )
  on conflict (employee_id) do update set
    disabled_at = null,
    must_change_password = target_must_change_password,
    password_changed_at = case when target_must_change_password then null else employee_accounts.password_changed_at end,
    invited_at = coalesce(employee_accounts.invited_at, excluded.invited_at),
    updated_at = clock_timestamp();

  return private.admin_user_record(target_employee_id);
end
$$;

create or replace function public.service_promote_import_people(
  target_import_run_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  selected_import_run_id uuid;
  system_actor_id uuid;
  candidate_record private.import_candidates%rowtype;
  raw_name text;
  preferred_name text;
  legal_name text;
  clean_name text;
  name_parts text[];
  first_name text;
  middle_name text;
  last_name text;
  employee_id uuid;
  mapping_id bigint;
  credential_id uuid;
  promoted_count integer := 0;
  skipped_count integer := 0;
  login_eligible_count integer := 0;
  skipped_records jsonb := '[]'::jsonb;
begin
  selected_import_run_id := target_import_run_id;
  if selected_import_run_id is null then
    select id into selected_import_run_id
    from private.import_runs
    order by received_at desc nulls last, started_at desc nulls last, id desc
    limit 1;
  end if;

  if selected_import_run_id is null then
    raise check_violation using message = 'No import run is available.';
  end if;

  select employee.id into system_actor_id
  from public.employees employee
  where employee.username = 'jbrown'
  order by employee.created_at
  limit 1;

  if system_actor_id is null then
    raise check_violation using message = 'The bootstrap administrator must exist before people can be promoted.';
  end if;

  for candidate_record in
    with candidate_names as (
      select
        candidate.*,
        private.normalize_import_label(regexp_replace(regexp_replace(regexp_replace(coalesce(candidate.payload ->> 'name', ''), '\"[^\" ]+\"', '', 'g'), '[*?]', '', 'g'), '[[:space:]]+', ' ', 'g')) as normalized_name,
        (
          case when nullif(btrim(coalesce(candidate.payload ->> 'email', '')), '') is not null then 2 else 0 end
          + case when nullif(btrim(coalesce(candidate.payload ->> 'phone', '')), '') is not null then 1 else 0 end
        ) as contact_score
      from private.import_candidates candidate
      where candidate.import_run_id = selected_import_run_id
        and candidate.kind = 'employee'
    ),
    ranked as (
      select
        candidate_names.*,
        row_number() over (
          partition by normalized_name
          order by contact_score desc, created_at asc, id asc
        ) as duplicate_rank
      from candidate_names
    )
    select
      candidate.id,
      candidate.import_run_id,
      candidate.kind,
      candidate.candidate_key,
      candidate.confidence,
      candidate.review_status,
      candidate.payload,
      candidate.source_references,
      candidate.fingerprint,
      candidate.reviewed_by,
      candidate.reviewed_at,
      candidate.review_note,
      candidate.created_at,
      candidate.updated_at
    from ranked candidate
    where candidate.duplicate_rank = 1
      and not exists (
        select 1 from private.import_entity_links link
        where link.candidate_id = candidate.id
          and link.entity_table = 'employees'
      )
    order by candidate.created_at, candidate.id
  loop
    raw_name := btrim(coalesce(candidate_record.payload ->> 'name', ''));
    preferred_name := nullif(substring(raw_name from '\"([^\"]+)\"'), '');
    legal_name := regexp_replace(raw_name, '\"[^\"]+\"', '', 'g');
    legal_name := regexp_replace(legal_name, '[*?]', '', 'g');
    legal_name := regexp_replace(legal_name, '[[:space:]]+', ' ', 'g');
    clean_name := btrim(legal_name);
    name_parts := regexp_split_to_array(clean_name, '[[:space:]]+');

    if clean_name = ''
      or array_length(name_parts, 1) is null
      or array_length(name_parts, 1) < 2
    then
      skipped_count := skipped_count + 1;
      skipped_records := skipped_records || jsonb_build_array(jsonb_build_object(
        'candidateId', candidate_record.id,
        'name', raw_name,
        'reason', 'Name needs human review before promotion.'
      ));
      continue;
    end if;

    first_name := name_parts[1];
    last_name := name_parts[array_length(name_parts, 1)];
    middle_name := null;
    if array_length(name_parts, 1) > 2 then
      middle_name := array_to_string(name_parts[2:array_length(name_parts, 1) - 1], ' ');
    end if;

    insert into private.import_mapping_decisions (
      import_run_id,
      candidate_id,
      mapping_type,
      mapping_key,
      decision,
      note,
      decided_by
    ) values (
      selected_import_run_id,
      candidate_record.id,
      'employee',
      'candidate:' || candidate_record.id::text,
      jsonb_build_object(
        'sourceType', 'directory_candidate',
        'firstName', first_name,
        'middleName', middle_name,
        'lastName', last_name,
        'preferredName', preferred_name,
        'role', coalesce(candidate_record.payload ->> 'roleCandidate', 'guard'),
        'employmentType', case when candidate_record.payload ->> 'roleCandidate' = 'supervisor' then 'salary' else 'hourly' end,
        'status', coalesce(candidate_record.payload ->> 'statusCandidate', 'active'),
        'personalEmail', nullif(lower(btrim(coalesce(candidate_record.payload ->> 'email', ''))), ''),
        'companyEmail', null,
        'mobilePhone', nullif(btrim(coalesce(candidate_record.payload ->> 'phone', '')), ''),
        'guardLicenseNumber', null,
        'guardLicenseExpiresOn', null,
        'armedStatus', case when coalesce((candidate_record.payload ->> 'armed')::boolean, false) then 'pending_verification' else 'not_armed' end,
        'armedCredentialNumber', null,
        'armedExpiresOn', null
      ),
      'Promoted from the reviewed workbook Contacts sheet using conservative automated people rules.',
      system_actor_id
    )
    returning id into mapping_id;

    insert into public.employees (
      first_name,
      middle_name,
      last_name,
      preferred_name,
      role,
      employment_type,
      status
    ) values (
      first_name,
      middle_name,
      last_name,
      preferred_name,
      coalesce(candidate_record.payload ->> 'roleCandidate', 'guard')::public.app_role,
      case when candidate_record.payload ->> 'roleCandidate' = 'supervisor' then 'salary'::public.employment_type else 'hourly'::public.employment_type end,
      coalesce(candidate_record.payload ->> 'statusCandidate', 'active')::public.employee_status
    )
    returning id into employee_id;

    if coalesce(candidate_record.payload ->> 'email', candidate_record.payload ->> 'phone') is not null then
      insert into private.employee_contacts (
        employee_id,
        personal_email,
        mobile_phone
      ) values (
        employee_id,
        nullif(lower(btrim(coalesce(candidate_record.payload ->> 'email', ''))), ''),
        nullif(btrim(coalesce(candidate_record.payload ->> 'phone', '')), '')
      );
    end if;

    insert into private.employee_operational_profiles (
      employee_id,
      source_candidate_id,
      source_mapping_decision_id,
      source_display_name,
      location_text,
      schedule_availability,
      employee_dg,
      expected_hours_text,
      source_notes,
      supervisor_label,
      armed_source_claim
    ) values (
      employee_id,
      candidate_record.id,
      mapping_id,
      raw_name,
      nullif(btrim(coalesce(candidate_record.payload ->> 'location', '')), ''),
      nullif(btrim(coalesce(candidate_record.payload ->> 'scheduleAvailability', '')), ''),
      nullif(btrim(coalesce(candidate_record.payload ->> 'employeeDg', '')), ''),
      nullif(btrim(coalesce(candidate_record.payload ->> 'hours', '')), ''),
      nullif(btrim(coalesce(candidate_record.payload ->> 'notes', '')), ''),
      nullif(btrim(coalesce(candidate_record.payload ->> 'supervisor', '')), ''),
      coalesce((candidate_record.payload ->> 'armed')::boolean, false)
    );

    insert into private.import_entity_links (
      import_run_id,
      candidate_id,
      mapping_decision_id,
      entity_table,
      entity_id,
      relation
    ) values (
      selected_import_run_id,
      candidate_record.id,
      mapping_id,
      'employees',
      employee_id,
      'employee'
    );

    if nullif(btrim(coalesce(candidate_record.payload ->> 'guardCard', '')), '') is not null then
      insert into public.employee_credentials (
        employee_id,
        kind,
        status,
        notes
      ) values (
        employee_id,
        'guard_license',
        case when lower(btrim(candidate_record.payload ->> 'guardCard')) in ('yes', 'y') then 'pending'::public.credential_status else 'pending'::public.credential_status end,
        'Workbook source listed guard card as "' || (candidate_record.payload ->> 'guardCard') || '"; credential number and expiration still require verification.'
      ) returning id into credential_id;

      insert into private.import_entity_links (
        import_run_id,
        candidate_id,
        mapping_decision_id,
        entity_table,
        entity_id,
        relation
      ) values (
        selected_import_run_id,
        candidate_record.id,
        mapping_id,
        'employee_credentials',
        credential_id,
        'guard_license'
      );
    end if;

    if coalesce((candidate_record.payload ->> 'armed')::boolean, false) then
      insert into public.employee_credentials (
        employee_id,
        kind,
        status,
        notes
      ) values (
        employee_id,
        'armed_guard',
        'pending',
        'Workbook source indicated armed eligibility; credential number and expiration still require verification.'
      ) returning id into credential_id;

      insert into private.import_entity_links (
        import_run_id,
        candidate_id,
        mapping_decision_id,
        entity_table,
        entity_id,
        relation
      ) values (
        selected_import_run_id,
        candidate_record.id,
        mapping_id,
        'employee_credentials',
        credential_id,
        'armed_guard'
      );
    end if;

    update private.import_candidates
    set
      review_status = 'accepted',
      reviewed_by = system_actor_id,
      reviewed_at = clock_timestamp(),
      review_note = 'Promoted to the live employee directory by the controlled people import.'
    where id = candidate_record.id
      and review_status <> 'accepted';

    promoted_count := promoted_count + 1;
    if coalesce(candidate_record.payload ->> 'statusCandidate', 'active') = 'active' then
      login_eligible_count := login_eligible_count + 1;
    end if;
  end loop;

  with duplicate_candidates as (
    select
      candidate.id,
      candidate.payload ->> 'name' as name,
      row_number() over (
        partition by lower(btrim(candidate.payload ->> 'name'))
        order by (
          case when nullif(btrim(coalesce(candidate.payload ->> 'email', '')), '') is not null then 2 else 0 end
          + case when nullif(btrim(coalesce(candidate.payload ->> 'phone', '')), '') is not null then 1 else 0 end
        ) desc,
        candidate.created_at asc,
        candidate.id asc
      ) as duplicate_rank
    from private.import_candidates candidate
    where candidate.import_run_id = selected_import_run_id
      and candidate.kind = 'employee'
  )
  select skipped_records || coalesce(jsonb_agg(jsonb_build_object(
    'candidateId', id,
    'name', name,
    'reason', 'Duplicate source name; richer matching record was promoted.'
  )), '[]'::jsonb)
  into skipped_records
  from duplicate_candidates
  where duplicate_rank > 1;

  return jsonb_build_object(
    'importRunId', selected_import_run_id,
    'promotedCount', promoted_count,
    'loginEligibleCount', login_eligible_count,
    'skippedCount', jsonb_array_length(skipped_records),
    'skippedRecords', skipped_records
  );
end
$$;

revoke all on function public.get_admin_user_directory() from public, anon;
revoke all on function public.admin_create_employee(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text) from public, anon;
revoke all on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text) from public, anon;
revoke all on function public.admin_set_employee_account_state(uuid, boolean) from public, anon;
revoke all on function public.service_get_employee_auth_target(uuid) from public, anon, authenticated;
revoke all on function public.service_get_employee_auth_targets(boolean) from public, anon, authenticated;
revoke all on function public.service_link_employee_auth_account(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.service_promote_import_people(uuid) from public, anon, authenticated;

grant execute on function public.get_admin_user_directory() to authenticated;
grant execute on function public.admin_create_employee(text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text) to authenticated;
grant execute on function public.admin_update_employee(uuid, text, text, text, text, public.app_role, public.employment_type, public.employee_status, text, text, text, text) to authenticated;
grant execute on function public.admin_set_employee_account_state(uuid, boolean) to authenticated;
grant execute on function public.service_get_employee_auth_target(uuid) to service_role;
grant execute on function public.service_get_employee_auth_targets(boolean) to service_role;
grant execute on function public.service_link_employee_auth_account(uuid, uuid, boolean) to service_role;
grant execute on function public.service_promote_import_people(uuid) to service_role;

commit;
