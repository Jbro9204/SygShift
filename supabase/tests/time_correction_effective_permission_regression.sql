-- Synthetic fixtures only. The companion isolated runner supplies the reviewed
-- function and real permission/session helpers; never run this on production.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local plpgsql.check_asserts = on;

do $isolated_only$
begin
  if current_setting('sygshift.test_fixture', true) is distinct from 'time_correction_permission_isolated'
    or current_database() <> 'sygshift_time_correction_fixture'
    or inet_server_addr() is distinct from inet '127.0.0.1'
    or inet_server_port() = 5432 then
    raise exception 'This regression requires its isolated loopback fixture.';
  end if;
end
$isolated_only$;

create temporary table correction_permission_cases (
  case_name text primary key,
  employee_id uuid not null default gen_random_uuid(),
  auth_user_id uuid not null default gen_random_uuid(),
  auth_session_id uuid not null default gen_random_uuid(),
  base_role public.app_role not null default 'recruiting_licensing',
  assigned_admin boolean not null default false,
  direct_permission text,
  denied_permissions text[] not null default '{}',
  assurance text not null default 'aal2',
  employee_status public.employee_status not null default 'active',
  disabled boolean not null default false,
  expected_allowed boolean not null
) on commit drop;

insert into correction_permission_cases
  (case_name, assigned_admin, direct_permission, denied_permissions, assurance, employee_status, disabled, expected_allowed)
values
  ('assigned_admin_non_operations_primary', true, null, '{}', 'aal2', 'active', false, true),
  ('direct_time_manage', false, 'time.manage', '{}', 'aal2', 'active', false, true),
  ('legacy_manual_entry_edit', false, 'time.manual_entry.edit', '{}', 'aal2', 'active', false, true),
  ('deny_manage_retains_independent_edit', true, null, '{time.manage}', 'aal2', 'active', false, true),
  ('both_permissions_denied', true, null, '{time.manage,time.manual_entry.edit}', 'aal2', 'active', false, false),
  ('no_permission', false, null, '{}', 'aal2', 'active', false, false),
  ('password_only_aal1', true, null, '{}', 'aal1', 'active', false, false),
  ('inactive_account', true, null, '{}', 'aal2', 'inactive', false, false),
  ('disabled_account', true, null, '{}', 'aal2', 'active', true, false);

-- A legacy operations primary role must not bypass explicit effective denies.
update correction_permission_cases set base_role = 'admin' where case_name = 'both_permissions_denied';

create temporary table correction_permission_targets (
  case_name text not null references correction_permission_cases(case_name),
  action text not null check (action in ('correct', 'void')),
  event_id uuid not null default gen_random_uuid(),
  prior_correction_id uuid not null default gen_random_uuid(),
  matching_pending_id uuid not null default gen_random_uuid(),
  conflicting_pending_id uuid not null default gen_random_uuid(),
  prior_note_id uuid not null default gen_random_uuid(),
  original_event jsonb,
  original_correction jsonb,
  original_note jsonb,
  original_pending jsonb,
  original_audit jsonb,
  payload jsonb,
  denied boolean,
  primary key (case_name, action)
) on commit drop;
insert into correction_permission_targets(case_name, action)
select case_name, action from correction_permission_cases cross join (values ('correct'), ('void')) actions(action);

do $seed_synthetic_only$
declare actor record; target record; admin_role uuid; denied_code text; subject_employee uuid := gen_random_uuid();
begin
  select id into strict admin_role from public.access_roles where code = 'system_admin' and active;
  -- Managers correct another employee's timecard, not merely their own events.
  insert into public.employees(id, username, first_name, last_name, role, employment_type, status)
  values(subject_employee, 'subject' || replace(subject_employee::text, '-', ''), 'Synthetic', 'Timecard Subject', 'guard', 'hourly', 'active');
  for actor in select * from correction_permission_cases loop
    insert into public.employees(id, username, first_name, last_name, role, employment_type, status)
    values(actor.employee_id, 'correction' || replace(actor.employee_id::text, '-', ''), 'Synthetic', 'Correction Permission', actor.base_role, 'hourly', actor.employee_status);
    insert into auth.users(id, email) values(actor.auth_user_id, actor.auth_user_id::text || '@example.invalid');
    insert into auth.sessions(id, user_id, not_after) values(actor.auth_session_id, actor.auth_user_id, clock_timestamp() + interval '1 hour');
    insert into private.employee_accounts(employee_id, auth_user_id, activated_at, disabled_at)
    values(actor.employee_id, actor.auth_user_id, clock_timestamp(), case when actor.disabled then clock_timestamp() end);
    if actor.assigned_admin then
      insert into public.employee_access_roles(employee_id, role_id) values(actor.employee_id, admin_role);
    end if;
    if actor.direct_permission is not null then
      insert into public.employee_permission_overrides(employee_id, permission_code, effect, reason)
      values(actor.employee_id, actor.direct_permission, 'grant', 'Isolated regression grant');
    end if;
    foreach denied_code in array actor.denied_permissions loop
      insert into public.employee_permission_overrides(employee_id, permission_code, effect, reason)
      values(actor.employee_id, denied_code, 'deny', 'Isolated regression explicit deny');
    end loop;
  end loop;

  for target in select t.*, c.employee_id from correction_permission_targets t join correction_permission_cases c using(case_name) loop
    insert into public.time_events(id, employee_id, kind, recorded_at, source, idempotency_key, created_by)
    values(target.event_id, subject_employee, 'clock_in', '2026-10-01 08:00:00+00', 'web', target.event_id::text, subject_employee);
    insert into public.time_event_corrections(id, time_event_id, replacement_time, replacement_kind, reason, requested_by, approved_by, approved_at, decision_note)
    values(target.prior_correction_id, target.event_id, '2026-10-01 08:02:00+00', 'clock_in', 'Earlier approved adjustment preserved', subject_employee, target.employee_id, '2026-10-02 12:00:00+00', 'Existing reviewed history');
    insert into public.time_event_corrections(id, time_event_id, replacement_time, replacement_kind, voided, reason, requested_by)
    values
      (target.matching_pending_id, target.event_id, case when target.action = 'correct' then '2026-10-01 08:05:00+00'::timestamptz end, case when target.action = 'correct' then 'clock_out'::public.time_event_kind end, target.action = 'void', 'Matching pending request', subject_employee),
      (target.conflicting_pending_id, target.event_id, '2026-10-01 08:06:00+00', 'clock_in', false, 'Conflicting pending request', subject_employee);
    insert into public.time_event_maintenance_notes(id, time_event_id, action, note, created_by)
    values(target.prior_note_id, target.event_id, 'time_adjust', 'Earlier maintenance note preserved', target.employee_id);
    update correction_permission_targets t set
      original_event = (select to_jsonb(e) from public.time_events e where e.id = target.event_id),
      original_correction = (select to_jsonb(c) from public.time_event_corrections c where c.id = target.prior_correction_id),
      original_note = (select to_jsonb(n) from public.time_event_maintenance_notes n where n.id = target.prior_note_id),
      original_pending = (select jsonb_agg(to_jsonb(c) order by c.id) from public.time_event_corrections c where c.id in (target.matching_pending_id, target.conflicting_pending_id)),
      original_audit = (select jsonb_agg(to_jsonb(a) order by a.id) from private.audit_events a where a.row_id in (target.prior_correction_id::text, target.matching_pending_id::text, target.conflicting_pending_id::text, target.prior_note_id::text))
    where t.event_id = target.event_id;
  end loop;
end
$seed_synthetic_only$;

grant select on correction_permission_cases to authenticated;
grant select, update on correction_permission_targets to authenticated;
set local role authenticated;

do $authenticated_workflow$
declare target record; result jsonb; was_denied boolean;
begin
  for target in select t.*, a.employee_id, a.auth_user_id, a.auth_session_id, a.assurance, a.expected_allowed from correction_permission_targets t join correction_permission_cases a using(case_name) order by t.case_name, t.action loop
    perform set_config('request.headers', '{}', true);
    perform set_config('request.jwt.claims', jsonb_build_object(
      'role', 'authenticated', 'sub', target.auth_user_id, 'session_id', target.auth_session_id,
      'iat', floor(extract(epoch from clock_timestamp())), 'aal', target.assurance
    )::text, true);
    assert public.has_mfa() = (target.assurance = 'aal2'), 'Fixture MFA assurance differs from its intended case.';
    if target.expected_allowed then
      assert (target.original_event ->> 'employee_id')::uuid <> target.employee_id, 'The regression must exercise cross-employee maintenance.';
      assert public.current_employee_id() = target.employee_id;
      assert not public.is_supervisor_or_admin(), 'Success cohort must exercise an assigned permission, not the old operations role.';
      assert public.has_effective_permission('time.manage') or public.has_effective_permission('time.manual_entry.edit');
    end if;
    result := null;
    was_denied := false;
    begin
      result := public.supervisor_correct_time_event_details(
        target.event_id,
        case when target.action = 'correct' then '2026-10-01 08:05:00+00'::timestamptz end,
        case when target.action = 'correct' then 'clock_out'::public.time_event_kind end,
        target.action = 'void',
        'Isolated authorized correction regression'
      );
    exception when insufficient_privilege then
      was_denied := true;
    end;
    assert was_denied = not target.expected_allowed, 'Correction permission/MFA decision does not match the intended actor.';
    update correction_permission_targets set payload = result, denied = was_denied where event_id = target.event_id;
  end loop;
end
$authenticated_workflow$;
reset role;

do $persistence_audit_and_denials$
declare target record; inserted public.time_event_corrections%rowtype; unchanged_rows integer;
begin
  for target in select t.*, a.employee_id, a.expected_allowed from correction_permission_targets t join correction_permission_cases a using(case_name) loop
    assert (select to_jsonb(e) from public.time_events e where e.id = target.event_id) = target.original_event, 'Original punch was modified.';
    assert (select to_jsonb(c) from public.time_event_corrections c where c.id = target.prior_correction_id) = target.original_correction, 'Prior approved correction was modified.';
    assert (select to_jsonb(n) from public.time_event_maintenance_notes n where n.id = target.prior_note_id) = target.original_note, 'Prior maintenance history was modified.';
    assert (select jsonb_agg(to_jsonb(a) order by a.id) from private.audit_events a where a.id in (select (item ->> 'id')::bigint from jsonb_array_elements(target.original_audit) item)) = target.original_audit, 'Existing audit history was modified.';
    if target.expected_allowed then
      select * into strict inserted from public.time_event_corrections where id = (target.payload ->> 'id')::uuid;
      assert inserted.time_event_id = target.event_id and inserted.requested_by = target.employee_id and inserted.approved_by = target.employee_id and inserted.approved_at is not null;
      assert inserted.voided = (target.action = 'void');
      assert (target.payload ->> 'approvedPendingRequestCount')::integer = 1 and (target.payload ->> 'declinedPendingRequestCount')::integer = 1;
      assert (select approved_at is not null and declined_at is null and approved_by = target.employee_id from public.time_event_corrections where id = target.matching_pending_id);
      assert (select declined_at is not null and approved_at is null and declined_by = target.employee_id from public.time_event_corrections where id = target.conflicting_pending_id);
      assert (select count(*) = 4 from public.time_event_corrections where time_event_id = target.event_id), 'Correction was missing or duplicated.';
      assert (select count(*) = 2 from public.time_event_maintenance_notes where time_event_id = target.event_id), 'Maintenance audit note was missing or duplicated.';
      assert exists(select 1 from private.audit_events where table_name = 'time_event_corrections' and row_id = inserted.id::text and employee_id = target.employee_id), 'Correction audit did not bind the authenticated actor.';
      if target.action = 'correct' then
        assert inserted.replacement_time = '2026-10-01 08:05:00+00'::timestamptz and inserted.replacement_kind = 'clock_out';
      else
        assert inserted.replacement_time is null and inserted.replacement_kind is null;
      end if;
    else
      assert target.payload is null;
      assert (select count(*) = 3 from public.time_event_corrections where time_event_id = target.event_id), 'Denied action appended a correction.';
      assert (select count(*) = 1 from public.time_event_maintenance_notes where time_event_id = target.event_id), 'Denied action appended an audit note.';
      assert (select jsonb_agg(to_jsonb(c) order by c.id) from public.time_event_corrections c where c.id in (target.matching_pending_id, target.conflicting_pending_id)) = target.original_pending, 'Denied action resolved pending requests.';
    end if;
  end loop;
  -- Keep the immutable-storage triggers in the exercised fixture, too.
  begin
    update public.time_events set recorded_at = recorded_at + interval '1 minute';
    raise exception 'Original punch update unexpectedly accepted.';
  exception when raise_exception then
    assert sqlerrm = 'time_events is append-only.';
  end;
  begin
    update public.time_event_corrections set reason = 'Changed historical reason' where approved_at is not null;
    raise exception 'Reviewed correction update unexpectedly accepted.';
  exception when raise_exception then
    assert sqlerrm = 'Reviewed time corrections cannot be changed.';
  end;
  select count(*) into unchanged_rows from correction_permission_targets join correction_permission_cases using(case_name) where denied = not expected_allowed;
  assert unchanged_rows = 18;
end
$persistence_audit_and_denials$;

select case_name, action, not denied as allowed from correction_permission_targets order by case_name, action;
rollback;
