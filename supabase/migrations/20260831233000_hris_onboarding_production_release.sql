begin;

-- Activate only the reviewed onboarding workflow. Access assignments, employee
-- accounts, and every other HR release gate must remain unchanged.
create temporary table hris_onboarding_release_baseline on commit drop as
select
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5('')) from public.access_role_permissions) as role_permission_fingerprint,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles) as employee_role_fingerprint,
  (select count(*) from public.employee_permission_overrides) as employee_override_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, permission_code, effect, active::text), '|' order by employee_id, permission_code, id)), md5('')) from public.employee_permission_overrides) as employee_override_fingerprint,
  (select count(*) from private.employee_accounts) as employee_account_count,
  (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, coalesce(auth_user_id::text, ''), coalesce(activated_at::text, ''), coalesce(disabled_at::text, '')), '|' order by employee_id)), md5('')) from private.employee_accounts) as employee_account_fingerprint;

do $$
declare
  actor_id uuid;
  other_enabled_gate_count integer;
begin
  select employee.id into actor_id
  from public.employees employee
  where lower(employee.username) = 'jbrown'
    and employee.status = 'active'
    and employee.role = 'admin'
  limit 1;

  if actor_id is null then
    raise exception using message = 'The active protected release administrator was not found; onboarding remains disabled.';
  end if;

  if not ('hr.onboarding.approve' = any(coalesce(private.employee_effective_permissions(actor_id), array[]::text[]))) then
    raise exception using message = 'The release administrator does not have onboarding approval access; onboarding remains disabled.';
  end if;

  select
    (select count(*) from private.hr_stage2_backfill_gate where enabled)
    + (select count(*) from private.hr_document_release_gate where enabled)
    + (select count(*) from private.hr_automation_release_gate where enabled)
    + (select count(*) from private.hr_recruiting_release_gate where enabled)
    + (select count(*) from private.hr_leave_release_gate where enabled)
    + (select count(*) from private.hr_benefits_release_gate where enabled)
    + (select count(*) from private.hr_compensation_release_gate where enabled)
    + (select count(*) from private.hr_stage8_release_gates where enabled)
    + (select count(*) from private.hr_stage9_release_gates where enabled)
    + (select count(*) from private.hr_stage10_release_gates where enabled)
  into other_enabled_gate_count;

  if other_enabled_gate_count <> 0 then
    raise exception using message = 'Another dormant HR workflow is already enabled; onboarding release stopped for review.';
  end if;

  update private.hr_onboarding_release_gate
  set enabled = true,
      enabled_by = actor_id,
      enabled_at = coalesce(enabled_at, clock_timestamp()),
      reason = 'Approved production release: controlled onboarding, evidence, account setup, and welcome delivery',
      updated_at = clock_timestamp()
  where singleton
    and not enabled;

  if not exists (
    select 1 from private.hr_onboarding_release_gate
    where singleton and enabled and enabled_by = actor_id
  ) then
    raise exception using message = 'Onboarding release gate could not be verified.';
  end if;

  insert into private.audit_events (
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    old_record,
    new_record
  ) values (
    actor_id,
    'private',
    'hr_onboarding_release_gate',
    'RELEASE',
    'production',
    jsonb_build_object('enabled', false),
    jsonb_build_object(
      'enabled', true,
      'scope', 'onboarding-only',
      'accessAssignmentsChanged', false,
      'employeeAccountsChanged', false
    )
  );
end
$$;

do $$
begin
  if exists (
    select 1
    from hris_onboarding_release_baseline baseline
    where baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
       or baseline.role_permission_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', role_id::text, permission_code, enabled::text), '|' order by role_id, permission_code)), md5('')) from public.access_role_permissions)
       or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
       or baseline.employee_role_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, role_id::text), '|' order by employee_id, role_id)), md5('')) from public.employee_access_roles)
       or baseline.employee_override_count <> (select count(*) from public.employee_permission_overrides)
       or baseline.employee_override_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, permission_code, effect, active::text), '|' order by employee_id, permission_code, id)), md5('')) from public.employee_permission_overrides)
       or baseline.employee_account_count <> (select count(*) from private.employee_accounts)
       or baseline.employee_account_fingerprint <> (select coalesce(md5(string_agg(concat_ws(':', employee_id::text, coalesce(auth_user_id::text, ''), coalesce(activated_at::text, ''), coalesce(disabled_at::text, '')), '|' order by employee_id)), md5('')) from private.employee_accounts)
  ) then
    raise exception using message = 'Onboarding release changed protected access or account state; the transaction was rolled back.';
  end if;
end
$$;

commit;
