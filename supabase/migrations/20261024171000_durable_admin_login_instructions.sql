begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Admin login instructions combine an Auth password mutation with an outbound
-- email.  Keep the immutable target/recipient manifest in Postgres so a retry
-- cannot silently select a different employee set or destination.  The
-- credential itself is never persisted: the Worker can deterministically
-- reconstruct it and this table stores only a keyed fingerprint.
create table if not exists private.admin_login_instruction_operations (
  id uuid primary key,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  mode text not null,
  purpose text not null,
  state text not null default 'prepared',
  prepared_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint admin_login_instruction_operations_mode_check
    check (mode in ('single', 'bulk')),
  constraint admin_login_instruction_operations_purpose_check
    check (purpose in ('admin_login_instructions', 'onboarding_account_setup')),
  constraint admin_login_instruction_operations_state_check
    check (state in ('prepared', 'completed', 'completed_with_failures')),
  constraint admin_login_instruction_operations_completion_check
    check ((state = 'prepared' and completed_at is null) or (state <> 'prepared' and completed_at is not null))
);

create table if not exists private.admin_login_instruction_items (
  operation_id uuid not null references private.admin_login_instruction_operations(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  ordinal integer not null,
  employee_number text,
  job_title text,
  username text not null,
  auth_email text not null,
  contact_email text not null,
  display_name text not null,
  role text not null,
  employment_type text not null,
  employee_status text not null,
  existing_auth_user_id uuid,
  candidate_auth_user_id uuid,
  requires_mfa boolean not null,
  credential_fingerprint text not null,
  state text not null default 'prepared',
  auth_user_id uuid,
  action text,
  last_error_code text,
  last_error_status integer,
  last_error_detail text,
  prepared_at timestamptz not null default clock_timestamp(),
  provisioned_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (operation_id, employee_id),
  unique (operation_id, ordinal),
  unique (operation_id, contact_email),
  constraint admin_login_instruction_items_ordinal_check check (ordinal between 0 and 499),
  constraint admin_login_instruction_items_username_check check (btrim(username) <> '' and char_length(username) <= 128),
  constraint admin_login_instruction_items_auth_email_check check (auth_email = lower(btrim(auth_email)) and auth_email like '%@%'),
  constraint admin_login_instruction_items_contact_email_check check (contact_email = lower(btrim(contact_email)) and contact_email like '%@%'),
  constraint admin_login_instruction_items_display_name_check check (btrim(display_name) <> '' and char_length(display_name) <= 200),
  constraint admin_login_instruction_items_role_check
    check (role in ('guard', 'dispatcher', 'scheduler', 'recruiting_licensing', 'supervisor', 'admin')),
  constraint admin_login_instruction_items_employment_type_check
    check (employment_type in ('hourly', 'salary', 'flex')),
  constraint admin_login_instruction_items_employee_status_check
    check (employee_status in ('active', 'onboarding', 'leave', 'inactive', 'separated')),
  constraint admin_login_instruction_items_fingerprint_check
    check (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint admin_login_instruction_items_state_check
    check (state in ('prepared', 'provisioned', 'completed', 'failed', 'unresolved')),
  constraint admin_login_instruction_items_result_check
    check (
      (state = 'prepared' and auth_user_id is null and action is null and provisioned_at is null and completed_at is null)
      or (state = 'provisioned' and auth_user_id is not null and action is not null and provisioned_at is not null and completed_at is null)
      or (state = 'completed' and auth_user_id is not null and action is not null and provisioned_at is not null and completed_at is not null)
      or (state in ('failed', 'unresolved') and completed_at is not null)
    ),
  constraint admin_login_instruction_items_error_check
    check (
      (state in ('failed', 'unresolved') and last_error_code is not null and last_error_status is not null and last_error_detail is not null)
      or state not in ('failed', 'unresolved')
    ),
  constraint admin_login_instruction_items_error_status_check
    check (last_error_status is null or last_error_status between 400 and 599),
  constraint admin_login_instruction_items_error_length_check
    check (
      (last_error_code is null or char_length(last_error_code) between 1 and 100)
      and (last_error_detail is null or char_length(last_error_detail) between 1 and 500)
    )
);

-- Only one credential-bearing operation may remain active for an employee,
-- even when different browsers/admins use different idempotency keys. This
-- prevents a later concurrent operation from rotating the password and
-- invalidating credentials that an earlier accepted email already contains.
create unique index if not exists admin_login_instruction_items_one_active_employee
  on private.admin_login_instruction_items(employee_id)
  where state in ('prepared', 'provisioned', 'unresolved');

-- A global bulk action has no stable client-visible identity after a browser
-- session is lost. Keep at most one recoverable bulk operation so a later
-- authorized administrator can deterministically resume it.
create unique index if not exists admin_login_instruction_operations_one_active_bulk
  on private.admin_login_instruction_operations(mode)
  where mode = 'bulk' and state = 'prepared';

alter table private.admin_login_instruction_operations enable row level security;
alter table private.admin_login_instruction_items enable row level security;

revoke all on table private.admin_login_instruction_operations from public, anon, authenticated, service_role;
revoke all on table private.admin_login_instruction_items from public, anon, authenticated, service_role;

-- One persisted attempt identity owns both onboarding deliveries.  A browser
-- retry reuses an active attempt, while a confirmed terminal failure must be
-- advanced explicitly before a corrected recipient/target can be tried.  The
-- attempt UUID is also the domain input for the durable welcome dispatch and
-- account-setup credential operation, so neither can silently change identity
-- after an ambiguous response.
alter table private.hr_onboarding_profiles
  add column if not exists welcome_package_attempt_id uuid,
  add column if not exists welcome_package_attempt_number integer not null default 0,
  add column if not exists welcome_package_attempt_state text,
  add column if not exists welcome_package_attempt_started_at timestamptz;

alter table private.hr_onboarding_profiles
  drop constraint if exists hr_onboarding_profile_welcome_package_attempt_check;
alter table private.hr_onboarding_profiles
  add constraint hr_onboarding_profile_welcome_package_attempt_check check (
    (
      welcome_package_attempt_id is null
      and welcome_package_attempt_number = 0
      and welcome_package_attempt_state is null
      and welcome_package_attempt_started_at is null
    )
    or (
      welcome_package_attempt_id is not null
      and welcome_package_attempt_number > 0
      and welcome_package_attempt_state in ('active', 'failed', 'completed')
      and welcome_package_attempt_started_at is not null
    )
  );

create or replace function private.admin_login_instruction_operation_payload(
  operation private.admin_login_instruction_operations
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'operationId', operation.id,
    'actorEmployeeId', operation.actor_employee_id,
    'mode', operation.mode,
    'purpose', operation.purpose,
    'state', operation.state,
    'preparedAt', operation.prepared_at,
    'completedAt', operation.completed_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', item.employee_id,
        'ordinal', item.ordinal,
        'employeeNumber', item.employee_number,
        'jobTitle', item.job_title,
        'username', item.username,
        'authEmail', item.auth_email,
        'contactEmail', item.contact_email,
        'displayName', item.display_name,
        'role', item.role,
        'employmentType', item.employment_type,
        'status', item.employee_status,
        'existingAuthUserId', item.existing_auth_user_id,
        'candidateAuthUserId', item.candidate_auth_user_id,
        'requiresMfa', item.requires_mfa,
        'credentialFingerprint', item.credential_fingerprint,
        'state', item.state,
        'authUserId', item.auth_user_id,
        'action', item.action,
        'errorCode', item.last_error_code,
        'errorStatus', item.last_error_status,
        'errorDetail', item.last_error_detail,
        'preparedAt', item.prepared_at,
        'provisionedAt', item.provisioned_at,
        'completedAt', item.completed_at
      ) order by item.ordinal)
      from private.admin_login_instruction_items item
      where item.operation_id = operation.id
    ), '[]'::jsonb)
  )
$$;

revoke all on function private.admin_login_instruction_operation_payload(private.admin_login_instruction_operations)
  from public, anon, authenticated, service_role;

create or replace function private.refresh_admin_login_instruction_operation(target_operation_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  pending_count integer;
  failure_count integer;
begin
  select
    count(*) filter (where item.state not in ('completed', 'failed')),
    count(*) filter (where item.state = 'failed')
  into pending_count, failure_count
  from private.admin_login_instruction_items item
  where item.operation_id = target_operation_id;

  update private.admin_login_instruction_operations operation
  set state = case
        when pending_count > 0 then 'prepared'
        when failure_count > 0 then 'completed_with_failures'
        else 'completed'
      end,
      completed_at = case when pending_count = 0 then coalesce(operation.completed_at, clock_timestamp()) else null end,
      updated_at = clock_timestamp()
  where operation.id = target_operation_id;
end
$$;

create or replace function public.service_claim_hr_onboarding_delivery_attempt(
  target_actor_id uuid,
  target_case_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile private.hr_onboarding_profiles%rowtype;
  next_attempt_id uuid;
  next_attempt_number integer;
  next_attempt_state text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id, 'hr.onboarding.manage');

  -- The profile lock is the attempt allocator. Two tabs after a terminal
  -- failure receive exactly one new identity; response loss while the attempt
  -- is active returns the same identity.
  select candidate.* into profile
  from private.hr_onboarding_profiles candidate
  where candidate.case_id = target_case_id
  for update;
  if not found then raise no_data_found using message = 'Onboarding profile not found.'; end if;

  if profile.welcome_package_attempt_id is null
    or profile.welcome_package_attempt_state = 'failed'
  then
    next_attempt_id := gen_random_uuid();
    next_attempt_number := profile.welcome_package_attempt_number + 1;
    next_attempt_state := case
      when profile.welcome_email_status = 'sent' and profile.account_setup_status = 'sent' then 'completed'
      else 'active'
    end;

    update private.hr_onboarding_profiles target
    set welcome_package_attempt_id = next_attempt_id,
        welcome_package_attempt_number = next_attempt_number,
        welcome_package_attempt_state = next_attempt_state,
        welcome_package_attempt_started_at = clock_timestamp(),
        -- Only a definitively failed (unsent) leg is eligible for a new
        -- attempt. A sent leg remains terminal and is never delivered again.
        welcome_email_status = case when target.welcome_email_status = 'failed' then 'not_sent' else target.welcome_email_status end,
        account_setup_status = case when target.account_setup_status = 'failed' then 'not_sent' else target.account_setup_status end,
        last_delivery_error = null,
        updated_at = clock_timestamp()
    where target.case_id = target_case_id
    returning * into profile;

    insert into private.hr_onboarding_events(case_id, action, actor_id, reason, details)
    values (
      target_case_id,
      'claim_welcome_package_delivery_attempt',
      target_actor_id,
      'Claimed a durable welcome-package delivery attempt.',
      jsonb_build_object(
        'attemptId', profile.welcome_package_attempt_id,
        'attemptNumber', profile.welcome_package_attempt_number,
        'state', profile.welcome_package_attempt_state
      )
    );
  elsif profile.welcome_package_attempt_state = 'completed'
    and (profile.welcome_email_status <> 'sent' or profile.account_setup_status <> 'sent')
  then
    raise check_violation using message = 'The completed onboarding delivery attempt is inconsistent.';
  end if;

  return jsonb_build_object(
    'caseId', target_case_id,
    'attemptId', profile.welcome_package_attempt_id,
    'attemptNumber', profile.welcome_package_attempt_number,
    'state', profile.welcome_package_attempt_state,
    'welcomeStatus', profile.welcome_email_status,
    'accountSetupStatus', profile.account_setup_status
  );
end
$$;

-- Delivery acknowledgement is monotonic and bound to the attempt that owns
-- the durable email/credential sources. Provider acceptance may commit while
-- the Worker loses this RPC response; a stale catch/retry must never downgrade
-- a sent delivery, advance the attempt, or create a duplicate event.
drop function if exists public.service_hr_onboarding_record_delivery(uuid, uuid, text, text, text, text);
create function public.service_hr_onboarding_record_delivery(
  target_actor_id uuid,
  target_case_id uuid,
  target_attempt_id uuid,
  target_kind text,
  target_status text,
  target_error text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  profile private.hr_onboarding_profiles%rowtype;
  current_status text;
  effective_status text;
  next_welcome_status text;
  next_account_setup_status text;
  next_attempt_state text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  perform private.hr_onboarding_assert_enabled();
  perform private.hr_onboarding_require_actor_permission(target_actor_id, 'hr.onboarding.manage');
  if target_kind not in ('welcome', 'account_setup') or target_status not in ('sent', 'failed') then
    raise check_violation using message = 'Choose a supported onboarding delivery result.';
  end if;

  select candidate.* into profile
  from private.hr_onboarding_profiles candidate
  where candidate.case_id = target_case_id
  for update;
  if not found then raise no_data_found using message = 'Onboarding profile not found.'; end if;
  if profile.welcome_package_attempt_id is distinct from target_attempt_id then
    raise check_violation using message = 'The onboarding delivery attempt is stale.';
  end if;

  -- Terminal attempt state wins over a racing stale caller. Completed delivery
  -- can only replay sent; a failed attempt can only replay its failed result.
  if profile.welcome_package_attempt_state = 'completed' then
    return jsonb_build_object(
      'caseId', target_case_id,
      'attemptId', target_attempt_id,
      'kind', target_kind,
      'status', case target_kind when 'welcome' then profile.welcome_email_status else profile.account_setup_status end,
      'attemptState', 'completed'
    );
  elsif profile.welcome_package_attempt_state = 'failed' then
    return jsonb_build_object(
      'caseId', target_case_id,
      'attemptId', target_attempt_id,
      'kind', target_kind,
      'status', case target_kind when 'welcome' then profile.welcome_email_status else profile.account_setup_status end,
      'attemptState', 'failed'
    );
  elsif profile.welcome_package_attempt_state is distinct from 'active' then
    raise check_violation using message = 'Claim an onboarding delivery attempt before recording delivery.';
  end if;

  current_status := case target_kind
    when 'welcome' then profile.welcome_email_status
    else profile.account_setup_status
  end;
  effective_status := case when current_status = 'sent' then 'sent' else target_status end;
  next_welcome_status := case when target_kind = 'welcome' then effective_status else profile.welcome_email_status end;
  next_account_setup_status := case when target_kind = 'account_setup' then effective_status else profile.account_setup_status end;
  next_attempt_state := case
    when effective_status = 'failed' then 'failed'
    when next_welcome_status = 'sent' and next_account_setup_status = 'sent' then 'completed'
    else 'active'
  end;

  if current_status is distinct from effective_status
    or profile.welcome_package_attempt_state is distinct from next_attempt_state
  then
    update private.hr_onboarding_profiles target
    set welcome_email_status = next_welcome_status,
        welcome_email_sent_at = case
          when target_kind = 'welcome' and effective_status = 'sent' then coalesce(target.welcome_email_sent_at, clock_timestamp())
          else target.welcome_email_sent_at
        end,
        account_setup_status = next_account_setup_status,
        account_setup_sent_at = case
          when target_kind = 'account_setup' and effective_status = 'sent' then coalesce(target.account_setup_sent_at, clock_timestamp())
          else target.account_setup_sent_at
        end,
        welcome_package_attempt_state = next_attempt_state,
        last_delivery_error = case
          when effective_status = 'failed' then nullif(left(coalesce(target_error, ''), 1000), '')
          else null
        end,
        updated_at = clock_timestamp()
    where target.case_id = target_case_id;

    insert into private.hr_onboarding_events(case_id, action, actor_id, reason, details)
    values (
      target_case_id,
      'deliver_' || target_kind,
      target_actor_id,
      btrim(target_reason),
      jsonb_build_object(
        'attemptId', target_attempt_id,
        'attemptNumber', profile.welcome_package_attempt_number,
        'status', effective_status,
        'attemptState', next_attempt_state,
        'error', case when effective_status = 'failed' then nullif(left(coalesce(target_error, ''), 1000), '') else null end
      )
    );
  end if;

  return jsonb_build_object(
    'caseId', target_case_id,
    'attemptId', target_attempt_id,
    'kind', target_kind,
    'status', effective_status,
    'attemptState', next_attempt_state
  );
end
$$;

revoke all on function private.refresh_admin_login_instruction_operation(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.service_get_admin_login_instruction_operation(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_mode text,
  target_purpose text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  operation private.admin_login_instruction_operations%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select item.* into operation
  from private.admin_login_instruction_operations item
  where item.id = target_operation_id;
  if not found then return null; end if;
  if operation.actor_employee_id is distinct from target_actor_employee_id
    or operation.mode is distinct from target_mode
    or operation.purpose is distinct from target_purpose
  then
    raise check_violation using message = 'The login-instruction operation identity does not match.';
  end if;
  return private.admin_login_instruction_operation_payload(operation);
end
$$;

create or replace function public.service_begin_admin_login_instruction_operation(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_mode text,
  target_purpose text,
  target_items jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_login_instruction_operations%rowtype;
  item jsonb;
  item_count integer;
  item_employee_id uuid;
  conflict_constraint text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_operation_id is null or target_actor_employee_id is null or target_mode not in ('single', 'bulk')
    or target_purpose not in ('admin_login_instructions', 'onboarding_account_setup')
    or (target_purpose = 'onboarding_account_setup' and target_mode <> 'single')
  then
    raise check_violation using message = 'A complete login-instruction operation identity is required.';
  end if;
  if jsonb_typeof(target_items) is distinct from 'array' then
    raise check_violation using message = 'The login-instruction target manifest must be an array.';
  end if;
  item_count := jsonb_array_length(target_items);
  if item_count > 500 or (target_mode = 'single' and item_count <> 1) then
    raise check_violation using message = 'The login-instruction target manifest size is invalid.';
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.id = target_actor_employee_id and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The login-instruction operator was not an active employee.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('admin-login-instructions:' || target_operation_id::text, 0));
  select item.* into operation
  from private.admin_login_instruction_operations item
  where item.id = target_operation_id
  for update;
  if found then
    if operation.actor_employee_id is distinct from target_actor_employee_id
      or operation.mode is distinct from target_mode
      or operation.purpose is distinct from target_purpose
    then
      raise check_violation using message = 'The login-instruction operation identity does not match.';
    end if;
    return private.admin_login_instruction_operation_payload(operation);
  end if;

  insert into private.admin_login_instruction_operations(id, actor_employee_id, mode, purpose)
  values (target_operation_id, target_actor_employee_id, target_mode, target_purpose)
  returning * into operation;

  for item in select value from jsonb_array_elements(target_items)
  loop
    begin
      item_employee_id := nullif(btrim(item ->> 'employeeId'), '')::uuid;
    exception when invalid_text_representation then
      raise check_violation using message = 'The login-instruction employee identity is invalid.';
    end;
    if item_employee_id is null or not exists (
      select 1 from public.employees employee
      where employee.id = item_employee_id and employee.status in ('active', 'onboarding')
    ) then
      raise foreign_key_violation using message = 'A login-instruction employee was not eligible.';
    end if;

    insert into private.admin_login_instruction_items(
      operation_id,
      employee_id,
      ordinal,
      employee_number,
      job_title,
      username,
      auth_email,
      contact_email,
      display_name,
      role,
      employment_type,
      employee_status,
      existing_auth_user_id,
      candidate_auth_user_id,
      requires_mfa,
      credential_fingerprint
    ) values (
      target_operation_id,
      item_employee_id,
      (item ->> 'ordinal')::integer,
      nullif(left(btrim(item ->> 'employeeNumber'), 100), ''),
      nullif(left(btrim(item ->> 'jobTitle'), 200), ''),
      left(btrim(item ->> 'username'), 128),
      lower(left(btrim(item ->> 'authEmail'), 254)),
      lower(left(btrim(item ->> 'contactEmail'), 254)),
      left(btrim(item ->> 'displayName'), 200),
      btrim(item ->> 'role'),
      btrim(item ->> 'employmentType'),
      btrim(item ->> 'status'),
      nullif(btrim(item ->> 'existingAuthUserId'), '')::uuid,
      nullif(btrim(item ->> 'candidateAuthUserId'), '')::uuid,
      coalesce((item ->> 'requiresMfa')::boolean, false),
      lower(btrim(item ->> 'credentialFingerprint'))
    );
  end loop;

  if (select count(*) from private.admin_login_instruction_items target where target.operation_id = target_operation_id) <> item_count then
    raise check_violation using message = 'The login-instruction target manifest is incomplete.';
  end if;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    null,
    target_actor_employee_id,
    'private',
    'admin_login_instruction_operations',
    'ADMIN_LOGIN_INSTRUCTIONS_PREPARED',
    target_operation_id::text,
    jsonb_build_object('mode', target_mode, 'purpose', target_purpose, 'recipientCount', item_count)
  );

  if item_count = 0 then
    perform private.refresh_admin_login_instruction_operation(target_operation_id);
    select item.* into operation
    from private.admin_login_instruction_operations item
    where item.id = target_operation_id;
  end if;

  return private.admin_login_instruction_operation_payload(operation);
exception
  when unique_violation then
    get stacked diagnostics conflict_constraint = constraint_name;
    if conflict_constraint = 'admin_login_instruction_items_one_active_employee' then
      raise check_violation using message = 'login_instruction_employee_operation_active';
    end if;
    if conflict_constraint = 'admin_login_instruction_operations_one_active_bulk' then
      raise check_violation using message = 'login_instruction_bulk_operation_active';
    end if;
    raise check_violation using message = 'The login-instruction manifest contains duplicate employees, positions, or recipients.';
  when invalid_text_representation or numeric_value_out_of_range then
    raise check_violation using message = 'The login-instruction target manifest is invalid.';
end
$$;

create or replace function public.service_find_active_admin_login_instruction_operations(
  target_employee_id uuid default null,
  target_purpose text default 'admin_login_instructions'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  return coalesce((
    select jsonb_agg(
      private.admin_login_instruction_operation_payload(operation)
      order by operation.prepared_at, operation.id
    )
    from private.admin_login_instruction_operations operation
    where operation.state = 'prepared'
      and operation.purpose = target_purpose
      and exists (
        select 1
        from private.admin_login_instruction_items item
        where item.operation_id = operation.id
          and item.state in ('prepared', 'provisioned', 'unresolved')
          and (target_employee_id is null or item.employee_id = target_employee_id)
      )
  ), '[]'::jsonb);
end
$$;

create or replace function public.service_claim_admin_login_instruction_operation(
  target_operation_id uuid,
  target_recovery_actor_employee_id uuid,
  target_mode text,
  target_purpose text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_login_instruction_operations%rowtype;
  recovery_row_id text;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if not exists (
    select 1 from public.employees employee
    where employee.id = target_recovery_actor_employee_id and employee.status = 'active'
  ) then
    raise foreign_key_violation using message = 'The recovery operator was not an active employee.';
  end if;

  select candidate.* into operation
  from private.admin_login_instruction_operations candidate
  where candidate.id = target_operation_id
  for update;
  if not found then
    return null;
  end if;
  if operation.mode is distinct from target_mode or operation.purpose is distinct from target_purpose then
    raise check_violation using message = 'The recoverable login-instruction operation was not found.';
  end if;
  if operation.state = 'prepared' and not exists (
    select 1 from private.admin_login_instruction_items item
    where item.operation_id = operation.id
      and item.state in ('prepared', 'provisioned', 'unresolved')
  ) then
    raise check_violation using message = 'The login-instruction operation is no longer active.';
  end if;

  recovery_row_id := operation.id::text || ':recovery:' || target_recovery_actor_employee_id::text;
  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  )
  select
    null,
    target_recovery_actor_employee_id,
    'private',
    'admin_login_instruction_operations',
    'ADMIN_LOGIN_INSTRUCTIONS_RECOVERY_CLAIMED',
    recovery_row_id,
    jsonb_build_object(
      'operationId', operation.id,
      'originalActorEmployeeId', operation.actor_employee_id,
      'recoveryActorEmployeeId', target_recovery_actor_employee_id,
      'mode', operation.mode,
      'purpose', operation.purpose
    )
  where not exists (
    select 1 from private.audit_events event
    where event.table_name = 'admin_login_instruction_operations'
      and event.operation = 'ADMIN_LOGIN_INSTRUCTIONS_RECOVERY_CLAIMED'
      and event.row_id = recovery_row_id
  );

  return private.admin_login_instruction_operation_payload(operation);
end
$$;

-- Establish (or verify) the complete immutable recipient manifest, but only
-- advance dispatch fences for items that are still active. Terminal failed or
-- completed recipients must never be reopened by recovery of another item in
-- the same bulk operation.
create or replace function public.service_prepare_admin_login_instruction_dispatches(
  target_operation_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_login_instruction_operations%rowtype;
  all_recipients jsonb;
  item record;
  decision jsonb;
  decisions jsonb := '[]'::jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select candidate.* into operation
  from private.admin_login_instruction_operations candidate
  where candidate.id = target_operation_id
  for update;
  if not found or operation.state <> 'prepared' then
    raise check_violation using message = 'The login-instruction operation is not active.';
  end if;

  select coalesce(jsonb_agg(entry.contact_email order by entry.ordinal), '[]'::jsonb)
  into all_recipients
  from private.admin_login_instruction_items entry
  where entry.operation_id = operation.id;
  if jsonb_array_length(all_recipients) < 1 then
    raise check_violation using message = 'The active login-instruction operation has no recipients.';
  end if;

  perform private.ensure_email_recipient_dispatch_manifest(
    'inline_email',
    operation.id,
    all_recipients,
    'login_instructions',
    'admin_login_instruction_operation',
    operation.id,
    true
  );

  for item in
    select entry.contact_email
    from private.admin_login_instruction_items entry
    where entry.operation_id = operation.id
      and entry.state in ('prepared', 'provisioned', 'unresolved')
    order by entry.ordinal
  loop
    decision := public.service_prepare_email_recipient_dispatch(
      'inline_email',
      operation.id,
      item.contact_email,
      'login_instructions',
      'admin_login_instruction_operation',
      operation.id
    );
    decisions := decisions || jsonb_build_array(
      decision || jsonb_build_object('intendedRecipient', item.contact_email)
    );
  end loop;

  return decisions;
end
$$;

create or replace function public.service_mark_admin_login_instruction_provisioned(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_auth_user_id uuid,
  target_action text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_login_instruction_operations%rowtype;
  item private.admin_login_instruction_items%rowtype;
  clean_action text := nullif(left(btrim(coalesce(target_action, '')), 100), '');
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  select parent.* into operation from private.admin_login_instruction_operations parent
  where parent.id = target_operation_id for update;
  if not found or operation.actor_employee_id is distinct from target_actor_employee_id then
    raise insufficient_privilege using message = 'The login-instruction operation identity does not match.';
  end if;
  select target.* into item from private.admin_login_instruction_items target
  where target.operation_id = target_operation_id and target.employee_id = target_employee_id for update;
  if not found or target_auth_user_id is null or clean_action is null then
    raise check_violation using message = 'The provisioned login identity is incomplete.';
  end if;
  if item.state in ('completed', 'failed') then
    -- Both outcomes are terminal. A stale concurrent provisioner must not
    -- reopen a failed item after the winning caller released its unsent fence.
    return private.admin_login_instruction_operation_payload(operation);
  end if;
  if item.auth_user_id is not null and (
    item.auth_user_id is distinct from target_auth_user_id or item.action is distinct from clean_action
  ) then
    raise check_violation using message = 'The provisioned login result conflicts with the durable operation.';
  end if;

  update private.admin_login_instruction_items target
  set state = 'provisioned',
      auth_user_id = target_auth_user_id,
      action = clean_action,
      last_error_code = null,
      last_error_status = null,
      last_error_detail = null,
      provisioned_at = coalesce(target.provisioned_at, clock_timestamp()),
      completed_at = null,
      updated_at = clock_timestamp()
  where target.operation_id = target_operation_id and target.employee_id = target_employee_id;
  perform private.refresh_admin_login_instruction_operation(target_operation_id);
  select parent.* into operation from private.admin_login_instruction_operations parent where parent.id = target_operation_id;
  return private.admin_login_instruction_operation_payload(operation);
end
$$;

create or replace function public.service_record_admin_login_instruction_outcome(
  target_operation_id uuid,
  target_actor_employee_id uuid,
  target_employee_id uuid,
  target_state text,
  target_error_code text default null,
  target_error_status integer default null,
  target_error_detail text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  operation private.admin_login_instruction_operations%rowtype;
  item private.admin_login_instruction_items%rowtype;
  clean_code text := nullif(left(btrim(coalesce(target_error_code, '')), 100), '');
  clean_detail text := nullif(left(btrim(coalesce(target_error_detail, '')), 500), '');
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_state not in ('completed', 'failed', 'unresolved') then
    raise check_violation using message = 'The login-instruction outcome is invalid.';
  end if;
  if target_state <> 'completed' and (
    clean_code is null or target_error_status not between 400 and 599 or clean_detail is null
  ) then
    raise check_violation using message = 'A structured login-instruction failure is required.';
  end if;

  select parent.* into operation from private.admin_login_instruction_operations parent
  where parent.id = target_operation_id for update;
  if not found or operation.actor_employee_id is distinct from target_actor_employee_id then
    raise insufficient_privilege using message = 'The login-instruction operation identity does not match.';
  end if;
  select target.* into item from private.admin_login_instruction_items target
  where target.operation_id = target_operation_id and target.employee_id = target_employee_id for update;
  if not found then raise check_violation using message = 'The login-instruction target was not found.'; end if;

  if item.state in ('completed', 'failed') then
    -- A stale concurrent caller may have observed the email fence while the
    -- winning caller was still finalizing. Terminal outcomes win; never turn
    -- that stale observation into a new-operation signal or reopen the item.
    return private.admin_login_instruction_operation_payload(operation);
  end if;
  if target_state = 'completed' and (item.auth_user_id is null or item.action is null or item.provisioned_at is null) then
    raise check_violation using message = 'A login instruction cannot complete before account provisioning is durable.';
  end if;

  update private.admin_login_instruction_items target
  set state = target_state,
      last_error_code = case when target_state = 'completed' then null else clean_code end,
      last_error_status = case when target_state = 'completed' then null else target_error_status end,
      last_error_detail = case when target_state = 'completed' then null else clean_detail end,
      completed_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where target.operation_id = target_operation_id and target.employee_id = target_employee_id;

  insert into private.audit_events(
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  )
  select
    null,
    target_actor_employee_id,
    'private',
    'admin_login_instruction_items',
    case target_state
      when 'completed' then 'ADMIN_LOGIN_INSTRUCTIONS_COMPLETED'
      when 'failed' then 'ADMIN_LOGIN_INSTRUCTIONS_FAILED'
      else 'ADMIN_LOGIN_INSTRUCTIONS_UNRESOLVED'
    end,
    target_operation_id::text || ':' || target_employee_id::text,
    jsonb_build_object(
      'operationId', target_operation_id,
      'employeeId', target_employee_id,
      'state', target_state,
      'errorCode', clean_code,
      'errorStatus', target_error_status,
      'errorDetail', clean_detail
    )
  where item.state is distinct from target_state
    or item.last_error_code is distinct from clean_code
    or item.last_error_status is distinct from target_error_status
    or item.last_error_detail is distinct from clean_detail;

  perform private.refresh_admin_login_instruction_operation(target_operation_id);
  select parent.* into operation from private.admin_login_instruction_operations parent where parent.id = target_operation_id;
  return private.admin_login_instruction_operation_payload(operation);
end
$$;

revoke all on function public.service_get_admin_login_instruction_operation(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_begin_admin_login_instruction_operation(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.service_find_active_admin_login_instruction_operations(uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_claim_admin_login_instruction_operation(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.service_prepare_admin_login_instruction_dispatches(uuid)
  from public, anon, authenticated;
revoke all on function public.service_mark_admin_login_instruction_provisioned(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.service_record_admin_login_instruction_outcome(uuid, uuid, uuid, text, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.service_claim_hr_onboarding_delivery_attempt(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.service_hr_onboarding_record_delivery(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.service_get_admin_login_instruction_operation(uuid, uuid, text, text) to service_role;
grant execute on function public.service_begin_admin_login_instruction_operation(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.service_find_active_admin_login_instruction_operations(uuid, text) to service_role;
grant execute on function public.service_claim_admin_login_instruction_operation(uuid, uuid, text, text) to service_role;
grant execute on function public.service_prepare_admin_login_instruction_dispatches(uuid) to service_role;
grant execute on function public.service_mark_admin_login_instruction_provisioned(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.service_record_admin_login_instruction_outcome(uuid, uuid, uuid, text, text, integer, text) to service_role;
grant execute on function public.service_claim_hr_onboarding_delivery_attempt(uuid, uuid) to service_role;
grant execute on function public.service_hr_onboarding_record_delivery(uuid, uuid, uuid, text, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
