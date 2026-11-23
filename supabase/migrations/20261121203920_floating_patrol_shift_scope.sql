-- Floating patrol reporting is an explicit Operations decision, not a
-- schedule/post-name heuristic, company-wide grant, or native patrol route.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- Retain verified identifiers as snapshots rather than adding restrictive
-- foreign keys to schedule, identity, or client-maintenance operations.
create table private.floating_patrol_scope_approvals (
  shift_id uuid not null,
  employee_id uuid not null,
  revision integer not null check (revision > 0),
  shift_assignment_id uuid not null,
  shift_assigned_at timestamptz not null,
  schedule_id uuid not null,
  post_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  time_zone text not null,
  requires_armed boolean not null,
  reason text not null check (char_length(btrim(reason)) between 8 and 500),
  approved_by uuid not null,
  approved_at timestamptz not null default clock_timestamp(),
  primary key (shift_id, employee_id, revision)
);

create table private.floating_patrol_scope_properties (
  shift_id uuid not null,
  employee_id uuid not null,
  revision integer not null,
  site_id uuid not null,
  client_id uuid not null,
  primary key (shift_id, employee_id, revision, site_id),
  foreign key (shift_id, employee_id, revision) references private.floating_patrol_scope_approvals (shift_id, employee_id, revision) on delete restrict
);

alter table private.floating_patrol_scope_approvals enable row level security;
alter table private.floating_patrol_scope_approvals force row level security;
alter table private.floating_patrol_scope_properties enable row level security;
alter table private.floating_patrol_scope_properties force row level security;
revoke all on private.floating_patrol_scope_approvals, private.floating_patrol_scope_properties from public, anon, authenticated, service_role;

create function private.reject_floating_patrol_scope_history_change_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise insufficient_privilege using message = 'Floating patrol approvals and their properties are retained history.';
end;
$$;
revoke all on function private.reject_floating_patrol_scope_history_change_v1() from public, anon, authenticated, service_role;

create trigger floating_patrol_scope_approvals_immutable before update or delete on private.floating_patrol_scope_approvals
for each row execute function private.reject_floating_patrol_scope_history_change_v1();
create trigger floating_patrol_scope_properties_immutable before update or delete on private.floating_patrol_scope_properties
for each row execute function private.reject_floating_patrol_scope_history_change_v1();

create function private.floating_patrol_native_precedence_v1(p_employee_id uuid, p_shift_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.patrol_assignments a
    where a.shift_id = p_shift_id and a.employee_id = p_employee_id and a.status <> 'canceled' and a.canceled_at is null
  ) or exists (
    select 1 from private.patrol_schedule_continuity c
    join public.patrol_assignments a on a.id = c.assignment_id and a.status <> 'canceled' and a.canceled_at is null
    left join private.patrol_schedule_resolution_receipts r on r.continuity_id = c.id
    where c.target_shift_id = p_shift_id and r.continuity_id is null
  );
$$;
revoke all on function private.floating_patrol_native_precedence_v1(uuid, uuid) from public, anon, authenticated, service_role;

-- Published occurrence eligibility is independent of report time policy. Do
-- not treat dispatch duty, training, open/canceled, or event coverage as patrol.
create function private.floating_patrol_shift_v1(p_employee_id uuid, p_shift_id uuid)
returns table (assignment_id uuid, assigned_at timestamptz, schedule_id uuid, post_id uuid, starts_at timestamptz,
  ends_at timestamptz, time_zone text, requires_armed boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, a.assigned_at, s.schedule_id, s.post_id, s.starts_at, s.ends_at, s.time_zone, s.requires_armed
  from public.shifts s
  join public.schedules w on w.id = s.schedule_id and w.status = 'published'
  join public.posts p on p.id = s.post_id and p.active
  join public.shift_assignments a on a.shift_id = s.id and a.employee_id = p_employee_id
    and a.status in ('assigned', 'confirmed', 'completed') and a.canceled_at is null
  join public.employees e on e.id = a.employee_id and e.status = 'active'
  where s.id = p_shift_id and s.canceled_at is null and s.event_id is null
    and s.work_type = 'post' and s.assignment_type = 'standard'
    and w.id = (select published.id from public.schedules published
      where published.week_starts_on = w.week_starts_on and published.status = 'published'
      order by published.revision desc nulls last, published.published_at desc nulls last, published.id desc limit 1);
$$;
revoke all on function private.floating_patrol_shift_v1(uuid, uuid) from public, anon, authenticated, service_role;

-- Immutable schedule lineage can tell us that Operations needs to reapprove;
-- it never supplies properties to a different occurrence or replacement guard.
create function private.floating_patrol_predecessor_exists_v1(p_employee_id uuid, p_shift_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive previous_shifts(id, depth) as (
    select link.source_shift_id, 1 from private.schedule_shift_revision_links link where link.draft_shift_id = p_shift_id
    union
    select link.source_shift_id, previous_shifts.depth + 1
    from previous_shifts join private.schedule_shift_revision_links link on link.draft_shift_id = previous_shifts.id
    where previous_shifts.depth < 64
  )
  select exists (select 1 from previous_shifts p join private.floating_patrol_scope_approvals a on a.shift_id = p.id
    where a.employee_id = p_employee_id or not exists (
      select 1 from private.floating_patrol_shift_v1(a.employee_id, p_shift_id)))
    or exists (select 1 from previous_shifts where depth = 64);
$$;
revoke all on function private.floating_patrol_predecessor_exists_v1(uuid, uuid) from public, anon, authenticated, service_role;

create function private.floating_patrol_scope_state_v1(p_employee_id uuid, p_shift_id uuid)
returns table (revision integer, configured boolean, eligible boolean, status text, approved_site_ids uuid[], site_ids uuid[])
language sql stable security definer set search_path = '' as $$
  with latest as (
    select a.* from private.floating_patrol_scope_approvals a
    where a.shift_id = p_shift_id and a.employee_id = p_employee_id
    order by a.revision desc limit 1
  ), facts as (
    select latest.revision,
      latest.revision is not null
        or exists (select 1 from private.floating_patrol_scope_approvals prior where prior.shift_id = p_shift_id
          and prior.employee_id <> p_employee_id and not exists (
            select 1 from private.floating_patrol_shift_v1(prior.employee_id, p_shift_id)))
        or private.floating_patrol_predecessor_exists_v1(p_employee_id, p_shift_id) as configured,
      current_shift.assignment_id is not null as current_assignment,
      coalesce(current_shift.ends_at > statement_timestamp(), false) as shift_bookable,
      private.floating_patrol_native_precedence_v1(p_employee_id, p_shift_id) as native_route,
      latest.revision is not null and current_shift.assignment_id is not null
        and row(latest.shift_assignment_id, latest.shift_assigned_at, latest.schedule_id, latest.post_id,
          latest.starts_at, latest.ends_at, latest.time_zone, latest.requires_armed)
          is not distinct from row(current_shift.assignment_id, current_shift.assigned_at, current_shift.schedule_id,
            current_shift.post_id, current_shift.starts_at,
            current_shift.ends_at, current_shift.time_zone, current_shift.requires_armed) as exact_approval,
      property_lists.approved_site_ids, property_lists.effective_site_ids
    from (values (true)) as seed(ignored)
    left join latest on true
    left join lateral private.floating_patrol_shift_v1(p_employee_id, p_shift_id) current_shift on true
    cross join lateral (
      select coalesce(array_agg(a.site_id order by a.site_id), '{}'::uuid[]) as approved_site_ids,
        coalesce(array_agg(a.site_id order by a.site_id) filter (where c.id is not null), '{}'::uuid[]) as effective_site_ids
      from private.floating_patrol_scope_properties a
      left join public.sites s on s.id = a.site_id and s.active and s.client_id = a.client_id
      left join public.clients c on c.id = s.client_id and c.status = 'active' and c.archived_at is null
      where a.shift_id = p_shift_id and a.employee_id = p_employee_id and a.revision = latest.revision
    ) as property_lists
  )
  select facts.revision, facts.configured, (facts.current_assignment and facts.shift_bookable and not facts.native_route),
    case when facts.native_route then 'native_route'
      when not facts.current_assignment then 'ineligible'
      when facts.exact_approval and cardinality(facts.effective_site_ids) > 0 then 'ready'
      when facts.exact_approval then 'blocked'
      when facts.configured then 'review_required'
      when not facts.shift_bookable then 'ended'
      else 'not_configured' end,
    facts.approved_site_ids,
    case when facts.exact_approval and not facts.native_route then facts.effective_site_ids else '{}'::uuid[] end
  from facts;
$$;
revoke all on function private.floating_patrol_scope_state_v1(uuid, uuid) from public, anon, authenticated, service_role;

create function public.get_floating_patrol_scope_v1(target_shift_id uuid, target_employee_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if private.current_employee_id() is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission is required.';
  end if;
  if target_shift_id is null or target_employee_id is null then
    raise invalid_parameter_value using message = 'Choose the exact published shift and employee.';
  end if;
  select jsonb_build_object('shiftId', target_shift_id, 'employeeId', target_employee_id, 'revision', s.revision,
    'configured', s.configured, 'eligible', s.eligible, 'active', s.status = 'ready', 'status', s.status,
    'approvedSiteIds', s.approved_site_ids, 'siteIds', s.site_ids) into result
  from private.floating_patrol_scope_state_v1(target_employee_id, target_shift_id) s;
  return result;
end;
$$;
revoke all on function public.get_floating_patrol_scope_v1(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_floating_patrol_scope_v1(uuid, uuid) to authenticated;

create function private.floating_patrol_lock_week_v1(p_shift_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare shift_week date;
begin
  select w.week_starts_on into shift_week from public.shifts s join public.schedules w on w.id = s.schedule_id where s.id = p_shift_id;
  if shift_week is not null and not pg_try_advisory_xact_lock_shared(hashtext('schedule-draft:' || shift_week::text)) then
    raise sqlstate 'PT409' using message = 'The schedule is being updated. Refresh this patrol shift and try again.', detail = 'floating_patrol_schedule_busy';
  end if;
end;
$$;
revoke all on function private.floating_patrol_lock_week_v1(uuid) from public, anon, authenticated, service_role;

create function public.save_floating_patrol_scope_v1(
  target_shift_id uuid, target_employee_id uuid, target_site_ids uuid[], target_expected_revision integer, target_reason text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_reason text := btrim(coalesce(target_reason, ''));
  current_shift record;
  observed_revision integer;
  site_ids uuid[];
  eligible_site_count integer;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission is required.';
  end if;
  if target_shift_id is null or target_employee_id is null or target_site_ids is null
    or coalesce(array_ndims(target_site_ids), 1) <> 1 or cardinality(target_site_ids) > 100
    or array_position(target_site_ids, null) is not null or char_length(clean_reason) not between 8 and 500 then
    raise invalid_parameter_value using message = 'Choose the exact shift, employee and up to 100 properties, and enter a reason of 8 to 500 characters.';
  end if;
  select coalesce(array_agg(distinct site_id order by site_id), '{}'::uuid[]) into site_ids from unnest(target_site_ids) as picked(site_id);
  if cardinality(site_ids) <> cardinality(target_site_ids) then
    raise invalid_parameter_value using message = 'Choose each patrol property at most once.';
  end if;

  if not pg_try_advisory_xact_lock(hashtextextended('patrol:route-link:' || target_shift_id::text || ':' || target_employee_id::text, 0)) then
    raise sqlstate 'PT409' using message = 'This patrol shift is being updated. Refresh and try again.', detail = 'floating_patrol_shift_busy';
  end if;
  perform private.floating_patrol_lock_week_v1(target_shift_id);
  -- Fence row-level edits that do not use the schedule-publication lock.
  begin
    perform 1 from public.shifts s join public.shift_assignments a on a.shift_id = s.id and a.employee_id = target_employee_id
      join public.posts p on p.id = s.post_id join public.employees e on e.id = a.employee_id
      where s.id = target_shift_id for share of s, a, p, e nowait;
    perform 1 from public.sites s join public.clients c on c.id = s.client_id
      where s.id = any(site_ids) and s.active and c.status = 'active' and c.archived_at is null
      order by s.id for share of s, c nowait;
    get diagnostics eligible_site_count = row_count;
  exception when lock_not_available then
    raise sqlstate 'PT409' using message = 'The shift or a selected property is being updated. Refresh and try again.', detail = 'floating_patrol_record_busy';
  end;

  select f.* into current_shift from private.floating_patrol_shift_v1(target_employee_id, target_shift_id) f;
  if not found then
    raise invalid_parameter_value using message = 'Choose a current, published post shift assigned to this active employee.';
  end if;
  if cardinality(site_ids) > 0 and current_shift.ends_at <= statement_timestamp() then
    raise invalid_parameter_value using message = 'This shift has already ended. New properties cannot be added retroactively.';
  end if;
  if private.floating_patrol_native_precedence_v1(target_employee_id, target_shift_id) and cardinality(site_ids) > 0 then
    raise sqlstate 'PT409' using message = 'This shift already has a patrol route or a route awaiting review. Use its existing property rules.', detail = 'floating_patrol_native_route_conflict';
  end if;
  if eligible_site_count <> cardinality(site_ids) then
    raise invalid_parameter_value using message = 'Each selected property must be active and linked to an active client.';
  end if;
  select a.revision into observed_revision from private.floating_patrol_scope_approvals a
    where a.shift_id = target_shift_id and a.employee_id = target_employee_id order by a.revision desc limit 1;
  if observed_revision is distinct from target_expected_revision then
    raise sqlstate 'PT409' using message = 'Another update changed these properties. Refresh and review the current selection before saving.', detail = 'floating_patrol_revision_changed';
  end if;
  if observed_revision is null and cardinality(site_ids) = 0 then
    raise invalid_parameter_value using message = 'Select a property before setting up a floating patrol.';
  end if;
  if exists (select 1 from private.floating_patrol_scope_properties prior
    join public.sites site on site.id = prior.site_id
    where prior.shift_id = target_shift_id and prior.employee_id = target_employee_id
      and prior.revision = observed_revision and prior.site_id = any(site_ids)
      and prior.client_id is distinct from site.client_id) then
    raise sqlstate 'PT409' using message = 'A selected property changed clients. Remove it and save before deliberately approving it for the new client.',
      detail = 'floating_patrol_property_client_changed';
  end if;

  insert into private.floating_patrol_scope_approvals (shift_id, employee_id, revision, shift_assignment_id, shift_assigned_at,
    schedule_id, post_id, starts_at, ends_at, time_zone, requires_armed, reason, approved_by)
  values (target_shift_id, target_employee_id, coalesce(observed_revision, 0) + 1, current_shift.assignment_id,
    current_shift.assigned_at, current_shift.schedule_id, current_shift.post_id, current_shift.starts_at,
    current_shift.ends_at, current_shift.time_zone, current_shift.requires_armed,
    clean_reason, actor_id);
  insert into private.floating_patrol_scope_properties (shift_id, employee_id, revision, site_id, client_id)
  select target_shift_id, target_employee_id, coalesce(observed_revision, 0) + 1, s.id, s.client_id
  from public.sites s where s.id = any(site_ids);
  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values ((select auth.uid()), actor_id, 'private', 'floating_patrol_scope_approvals',
    case when cardinality(site_ids) = 0 then 'revoke' else 'approve' end,
    target_shift_id::text || ':' || target_employee_id::text,
    jsonb_build_object('revision', observed_revision), jsonb_build_object('revision', coalesce(observed_revision, 0) + 1,
      'shiftId', target_shift_id, 'employeeId', target_employee_id, 'siteIds', site_ids, 'reason', clean_reason));
  return public.get_floating_patrol_scope_v1(target_shift_id, target_employee_id);
end;
$$;
revoke all on function public.save_floating_patrol_scope_v1(uuid, uuid, uuid[], integer, text) from public, anon, service_role;
grant execute on function public.save_floating_patrol_scope_v1(uuid, uuid, uuid[], integer, text) to authenticated;

create function public.service_get_floating_patrol_scopes_v1(target_employee_id uuid, target_shift_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_employee_id is null or target_shift_ids is null or coalesce(array_ndims(target_shift_ids), 1) <> 1
    or cardinality(target_shift_ids) > 100 or array_position(target_shift_ids, null) is not null then
    raise invalid_parameter_value using message = 'Choose a bounded employee shift set.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('shift_id', requested.shift_id, 'employee_id', target_employee_id,
    'site_ids', s.site_ids) order by requested.shift_id), '[]'::jsonb) into result
  from (select distinct unnest(target_shift_ids) as shift_id) requested
  cross join lateral private.floating_patrol_scope_state_v1(target_employee_id, requested.shift_id) s
  where s.configured and s.status <> 'native_route';
  return result;
end;
$$;
revoke all on function public.service_get_floating_patrol_scopes_v1(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.service_get_floating_patrol_scopes_v1(uuid, uuid[]) to service_role;

-- A mutation shares the same pair fence as Operations, including before the
-- first approval where an ordinary/fixed fallback is still possible. A busy
-- scope returns a conflict, never an accidental 'not configured'.
create function private.floating_patrol_assignment_configured_v1(target_employee_id uuid, target_shift_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare configured boolean;
begin
  if target_employee_id is null or target_shift_id is null then return false; end if;
  if not pg_try_advisory_xact_lock_shared(hashtextextended('patrol:route-link:' || target_shift_id::text || ':' || target_employee_id::text, 0)) then
    raise sqlstate 'PT409' using message = 'Patrol reporting access is being updated. Refresh and try again.', detail = 'floating_patrol_shift_busy';
  end if;
  select s.configured and s.status <> 'native_route' into configured
  from private.floating_patrol_scope_state_v1(target_employee_id, target_shift_id) s;
  if configured then perform private.floating_patrol_lock_week_v1(target_shift_id); end if;
  return configured;
end;
$$;
revoke all on function private.floating_patrol_assignment_configured_v1(uuid, uuid) from public, anon, authenticated;
grant execute on function private.floating_patrol_assignment_configured_v1(uuid, uuid) to service_role;

create function private.floating_patrol_site_authorized_v1(target_employee_id uuid, target_shift_id uuid, target_site_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if target_site_id is null or not private.floating_patrol_assignment_configured_v1(target_employee_id, target_shift_id) then return false; end if;
  begin
    perform 1 from public.shifts s join public.shift_assignments a on a.shift_id = s.id and a.employee_id = target_employee_id
      join public.posts p on p.id = s.post_id join public.employees e on e.id = a.employee_id
      where s.id = target_shift_id for share of s, a, p, e nowait;
    perform 1 from public.sites s join public.clients c on c.id = s.client_id where s.id = target_site_id for share of s, c nowait;
  exception when lock_not_available then
    raise sqlstate 'PT409' using message = 'The shift or property is being updated. Refresh and try again.', detail = 'floating_patrol_record_busy';
  end;
  return exists (select 1 from private.floating_patrol_scope_state_v1(target_employee_id, target_shift_id) s
    where s.status = 'ready' and target_site_id = any(s.site_ids));
end;
$$;
revoke all on function private.floating_patrol_site_authorized_v1(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.floating_patrol_site_authorized_v1(uuid, uuid, uuid) to service_role;

-- Prevent the existing route flow from silently overriding a nonempty scope,
-- including alternate native writers and concurrent report/scope operations.
-- Established native assignments still transition normally on the same pair.
create function private.guard_patrol_floating_native_conflict_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'canceled' or new.canceled_at is not null then return new; end if;
  if tg_op = 'UPDATE' then
    if old.shift_id = new.shift_id and old.employee_id = new.employee_id
      and old.status <> 'canceled' and old.canceled_at is null then return new; end if;
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended('patrol:route-link:' || new.shift_id::text || ':' || new.employee_id::text, 0)) then
    raise sqlstate 'PT409' using message = 'This patrol shift is being updated. Refresh and try again.', detail = 'floating_patrol_shift_busy';
  end if;
  if not exists (select 1 from private.floating_patrol_scope_approvals a
    where a.shift_id = new.shift_id and a.employee_id = new.employee_id) then return new; end if;
  if exists (select 1 from private.floating_patrol_scope_state_v1(new.employee_id, new.shift_id) s
    where cardinality(s.approved_site_ids) > 0 and s.status in ('ready', 'blocked')) then
    raise sqlstate 'PT409' using message = 'Remove this employee’s approved floating-patrol properties before connecting a fixed patrol route.',
      detail = 'floating_patrol_active_scope_conflict';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_patrol_floating_native_conflict_v1() from public, anon, authenticated, service_role;
create trigger patrol_assignments_guard_floating_scope before insert or update of shift_id, employee_id, status, canceled_at
on public.patrol_assignments for each row execute function private.guard_patrol_floating_native_conflict_v1();

comment on function public.service_get_floating_patrol_scopes_v1(uuid, uuid[]) is
  'Server-only exact shift/employee report property bindings. An empty configured row blocks fallback. A revised shift never inherits site authority.';
comment on function public.save_floating_patrol_scope_v1(uuid, uuid, uuid[], integer, text) is
  'Append an Operations-approved shift-specific property list. An empty list revokes an existing generation. Native route, schedule and report records are not changed.';

commit;
