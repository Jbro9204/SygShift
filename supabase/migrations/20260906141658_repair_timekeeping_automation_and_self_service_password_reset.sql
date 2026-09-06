begin;

-- Dispatch phone duty no longer creates a separate payable session. Historical
-- sessions created before that rule changed still need one system-generated
-- clock-out so they cannot leave the entire automatic timekeeping batch open.
create or replace function private.prevent_dispatch_phone_time_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shift_id is not null and exists (
    select 1
    from public.shifts shift
    where shift.id = new.shift_id
      and private.shift_assignment_type(shift.id) = 'dispatch_phone_duty'
  ) then
    if new.kind = 'clock_out'
      and new.source = 'system'
      and exists (
        select 1
        from public.time_events prior_event
        cross join lateral private.current_effective_time_event(prior_event.id) effective
        where prior_event.employee_id = new.employee_id
          and prior_event.shift_id = new.shift_id
          and prior_event.id is distinct from new.id
          and private.current_effective_time_event_kind(prior_event.id) in ('clock_in', 'break_start', 'break_end')
          and not effective.voided
          and effective.effective_at <= new.recorded_at
      )
    then
      return new;
    end if;

    raise check_violation using message = 'Dispatch phone duty is a concurrent responsibility and does not create a separate time-clock session.';
  end if;
  return new;
end
$$;

comment on function private.prevent_dispatch_phone_time_event() is
  'Rejects new Dispatch phone-duty time sessions while permitting only a system clock-out that closes a legitimate historical session created before the concurrent-duty rule.';

revoke all on function private.prevent_dispatch_phone_time_event() from public, anon, authenticated;

create table if not exists private.employee_self_service_password_reset_requests (
  id uuid primary key default gen_random_uuid(),
  username_hash text not null,
  request_fingerprint_hash text not null,
  employee_id uuid references public.employees(id) on delete restrict,
  outcome text not null,
  request_id text,
  requested_at timestamptz not null default clock_timestamp(),
  constraint employee_self_service_password_reset_username_hash_check
    check (username_hash ~ '^[a-f0-9]{64}$'),
  constraint employee_self_service_password_reset_fingerprint_hash_check
    check (request_fingerprint_hash ~ '^[a-f0-9]{64}$'),
  constraint employee_self_service_password_reset_outcome_check
    check (outcome in ('claimed', 'not_eligible', 'rate_limited'))
);

create index if not exists employee_self_service_password_reset_username_rate_idx
  on private.employee_self_service_password_reset_requests (username_hash, requested_at desc);

create index if not exists employee_self_service_password_reset_fingerprint_rate_idx
  on private.employee_self_service_password_reset_requests (request_fingerprint_hash, requested_at desc);

alter table private.employee_self_service_password_reset_requests enable row level security;
alter table private.employee_self_service_password_reset_requests force row level security;

drop trigger if exists employee_self_service_password_reset_requests_audit
  on private.employee_self_service_password_reset_requests;
create trigger employee_self_service_password_reset_requests_audit
after insert on private.employee_self_service_password_reset_requests
for each row execute function private.write_audit_event();

drop trigger if exists employee_self_service_password_reset_requests_append_only
  on private.employee_self_service_password_reset_requests;
create trigger employee_self_service_password_reset_requests_append_only
before update or delete on private.employee_self_service_password_reset_requests
for each row execute function private.prevent_append_only_change();

create or replace function public.service_claim_self_service_password_reset(
  target_username text,
  target_username_hash text,
  target_request_fingerprint_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  normalized_username text := lower(btrim(coalesce(target_username, '')));
  username_attempt_count integer;
  fingerprint_attempt_count integer;
  target record;
  request_outcome text := 'not_eligible';
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if target_username_hash !~ '^[a-f0-9]{64}$'
    or target_request_fingerprint_hash !~ '^[a-f0-9]{64}$' then
    raise check_violation using message = 'Valid request hashes are required.';
  end if;

  -- Serialize attempts for both limits so simultaneous requests cannot bypass
  -- the counters. Only one-way hashes are persisted.
  perform pg_advisory_xact_lock(hashtextextended('password-reset-username:' || target_username_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('password-reset-fingerprint:' || target_request_fingerprint_hash, 0));

  select count(*)::integer
  into username_attempt_count
  from private.employee_self_service_password_reset_requests request
  where request.username_hash = target_username_hash
    and request.requested_at >= clock_timestamp() - interval '1 hour';

  select count(*)::integer
  into fingerprint_attempt_count
  from private.employee_self_service_password_reset_requests request
  where request.request_fingerprint_hash = target_request_fingerprint_hash
    and request.requested_at >= clock_timestamp() - interval '15 minutes';

  if username_attempt_count >= 3 or fingerprint_attempt_count >= 10 then
    request_outcome := 'rate_limited';
  elsif normalized_username ~ '^[a-z][a-z0-9]{1,62}$' then
    select
      employee.id as employee_id,
      employee.username,
      employee.username || '@accounts.sygshift.invalid' as auth_email,
      btrim(coalesce(employee.preferred_name, employee.first_name) || ' ' || employee.last_name) as display_name,
      employee.role,
      employee.employment_type,
      employee.status,
      account.auth_user_id,
      private.preferred_delivery_email(contact.personal_email, contact.company_email) as contact_email
    into target
    from public.employees employee
    join private.employee_accounts account
      on account.employee_id = employee.id
      and account.disabled_at is null
    left join private.employee_contacts contact on contact.employee_id = employee.id
    where employee.username = normalized_username
      and employee.status = 'active'
      and account.auth_user_id is not null
      and private.preferred_delivery_email(contact.personal_email, contact.company_email) is not null;

    if target.employee_id is not null then
      request_outcome := 'claimed';
    end if;
  end if;

  insert into private.employee_self_service_password_reset_requests (
    username_hash,
    request_fingerprint_hash,
    employee_id,
    outcome,
    request_id
  ) values (
    target_username_hash,
    target_request_fingerprint_hash,
    case when request_outcome = 'claimed' then target.employee_id else null end,
    request_outcome,
    nullif(btrim(target_request_id), '')
  );

  if request_outcome <> 'claimed' then
    return jsonb_build_object('eligible', false);
  end if;

  return jsonb_build_object(
    'eligible', true,
    'employeeId', target.employee_id,
    'username', target.username,
    'authEmail', target.auth_email,
    'displayName', target.display_name,
    'role', target.role,
    'employmentType', target.employment_type,
    'status', target.status,
    'existingAuthUserId', target.auth_user_id,
    'contactEmail', target.contact_email
  );
end
$$;

comment on function public.service_claim_self_service_password_reset(text, text, text, text) is
  'Service-only, rate-limited, enumeration-safe claim for an active employee password recovery target. Raw usernames and request fingerprints are never persisted.';

revoke all on table private.employee_self_service_password_reset_requests from public, anon, authenticated;
revoke all on function public.service_claim_self_service_password_reset(text, text, text, text) from public, anon, authenticated;
grant execute on function public.service_claim_self_service_password_reset(text, text, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
