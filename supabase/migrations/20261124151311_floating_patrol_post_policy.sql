-- A recurring property list is an explicit reporting policy, not a schedule
-- write or a permission grant. Nothing is activated by installing this file.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '15s';

create table private.floating_patrol_post_policies (
  post_id uuid not null,
  revision integer not null check (revision > 0),
  anchor_site_id uuid not null,
  anchor_client_id uuid not null,
  requires_armed boolean not null,
  approved_at timestamptz not null default clock_timestamp(),
  approved_by uuid not null,
  reason text not null check (char_length(btrim(reason)) between 8 and 500),
  primary key (post_id, revision)
);

create table private.floating_patrol_post_policy_properties (
  post_id uuid not null,
  revision integer not null,
  site_id uuid not null,
  client_id uuid not null,
  primary key (post_id, revision, site_id),
  foreign key (post_id, revision) references private.floating_patrol_post_policies (post_id, revision) on delete restrict
);
alter table private.floating_patrol_post_policies enable row level security;
alter table private.floating_patrol_post_policies force row level security;
alter table private.floating_patrol_post_policy_properties enable row level security;
alter table private.floating_patrol_post_policy_properties force row level security;
revoke all on private.floating_patrol_post_policies, private.floating_patrol_post_policy_properties from public, anon, authenticated, service_role;
create trigger floating_patrol_post_policies_immutable before update or delete on private.floating_patrol_post_policies
for each row execute function private.reject_floating_patrol_scope_history_change_v1();
create trigger floating_patrol_post_policy_properties_immutable before update or delete on private.floating_patrol_post_policy_properties
for each row execute function private.reject_floating_patrol_scope_history_change_v1();

create function private.floating_patrol_post_state_v1(p_post_id uuid)
returns table (revision integer, approved_site_ids uuid[], site_ids uuid[])
language sql stable security definer set search_path = '' as $$
  select approval.revision,
    coalesce(array_agg(a.site_id order by a.site_id) filter (where a.site_id is not null), '{}'::uuid[]),
    coalesce(array_agg(a.site_id order by a.site_id) filter (where client.id is not null and anchor_client.id is not null), '{}'::uuid[])
  from (values (true)) as seed(ignored)
  left join lateral (
    select policy.* from private.floating_patrol_post_policies policy where policy.post_id = p_post_id
    order by policy.revision desc limit 1
  ) approval on true
  left join public.posts post on post.id = approval.post_id and post.active
    and post.site_id = approval.anchor_site_id and post.requires_armed = approval.requires_armed
  left join public.sites anchor on anchor.id = post.site_id and anchor.active and anchor.client_id = approval.anchor_client_id
  left join public.clients anchor_client on anchor_client.id = anchor.client_id
    and anchor_client.status = 'active' and anchor_client.archived_at is null
  left join private.floating_patrol_post_policy_properties a on a.post_id = approval.post_id and a.revision = approval.revision
  left join public.sites site on site.id = a.site_id and site.active and site.client_id = a.client_id
  left join public.clients client on client.id = site.client_id and client.status = 'active' and client.archived_at is null
  group by approval.revision;
$$;
revoke all on function private.floating_patrol_post_state_v1(uuid) from public, anon, authenticated, service_role;

create function public.get_floating_patrol_post_scope_v1(target_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if private.current_employee_id() is null or not private.patrol_can_manage() then
    raise insufficient_privilege using message = 'Patrol Route Management with verified MFA is required.';
  end if;
  if target_post_id is null then
    raise invalid_parameter_value using message = 'Choose an exact scheduling post.';
  end if;
  select jsonb_build_object('postId', target_post_id, 'revision', s.revision,
    'active', cardinality(s.site_ids) > 0, 'approvedSiteIds', s.approved_site_ids, 'siteIds', s.site_ids)
    into result from private.floating_patrol_post_state_v1(target_post_id) s;
  return result;
end;
$$;
revoke all on function public.get_floating_patrol_post_scope_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_floating_patrol_post_scope_v1(uuid) to authenticated;

create function public.save_floating_patrol_post_scope_v1(
  target_post_id uuid, target_site_ids uuid[], target_expected_revision integer, target_reason text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor_id uuid := private.current_employee_id();
  clean_reason text := btrim(coalesce(target_reason, ''));
  current_post record;
  previous private.floating_patrol_post_policies%rowtype;
  selected_ids uuid[];
  eligible_count integer;
  next_revision integer;
begin
  if actor_id is null or not private.patrol_can_manage() then
    raise insufficient_privilege using message = 'Patrol Route Management with verified MFA is required.';
  end if;
  if target_post_id is null or target_site_ids is null
    or coalesce(array_ndims(target_site_ids), 1) <> 1 or cardinality(target_site_ids) > 100
    or array_position(target_site_ids, null) is not null or char_length(clean_reason) not between 8 and 500 then
    raise invalid_parameter_value using message = 'Choose a post and up to 100 distinct properties, and enter a reason of 8 to 500 characters.';
  end if;
  select coalesce(array_agg(distinct site_id order by site_id), '{}'::uuid[]) into selected_ids
    from unnest(target_site_ids) as picked(site_id);
  if cardinality(selected_ids) <> cardinality(target_site_ids) then
    raise invalid_parameter_value using message = 'Choose each patrol property at most once.';
  end if;

  -- The same per-post fence is acquired for shared report mutations, even
  -- before the first approval. A busy write never exposes a fixed fallback.
  if not pg_try_advisory_xact_lock(hashtextextended('patrol:floating-post:' || target_post_id::text, 0)) then
    raise sqlstate 'PT409' using message = 'This post is being updated. Reload its approved properties before retrying.', detail = 'floating_patrol_post_busy';
  end if;
  select p.* into previous from private.floating_patrol_post_policies p where p.post_id = target_post_id order by p.revision desc limit 1;
  if previous.revision is distinct from target_expected_revision then
    raise sqlstate 'PT409' using message = 'The saved post policy changed. Reload and review before saving.', detail = 'floating_patrol_post_revision_changed';
  end if;
  if cardinality(selected_ids) = 0 and previous.revision is null then
    raise invalid_parameter_value using message = 'Select at least one approved property before setting up this post.';
  end if;
  if cardinality(selected_ids) > 0 then
    begin
      select p.site_id, site.client_id, p.requires_armed into current_post
      from public.posts p join public.sites site on site.id = p.site_id and site.active
      join public.clients client on client.id = site.client_id and client.status = 'active' and client.archived_at is null
      where p.id = target_post_id and p.active for share of p, site, client nowait;
      if not found then
        raise invalid_parameter_value using message = 'Choose an active post on an active property with an active client.';
      end if;
      perform 1 from public.sites site join public.clients client on client.id = site.client_id
      where site.id = any(selected_ids) and site.active and client.status = 'active' and client.archived_at is null
      order by site.id for share of site, client nowait;
      get diagnostics eligible_count = row_count;
    exception when lock_not_available then
      raise sqlstate 'PT409' using message = 'The post or a selected property is being updated. Reload before saving.', detail = 'floating_patrol_post_record_busy';
    end;
    if eligible_count <> cardinality(selected_ids) then
      raise invalid_parameter_value using message = 'Each selected property must be active and linked to an active client.';
    end if;
    if exists (
      select 1 from private.floating_patrol_post_policy_properties old
      join public.sites site on site.id = old.site_id
      where old.post_id = target_post_id and old.revision = previous.revision and old.site_id = any(selected_ids)
        and site.client_id is distinct from old.client_id
    ) then
      raise sqlstate 'PT409' using message = 'A selected property changed clients. Remove it and save before approving it for the new client.',
        detail = 'floating_patrol_property_client_changed';
    end if;
  else
    -- Revocation must still work if the post or client has been deactivated.
    select previous.anchor_site_id as site_id, previous.anchor_client_id as client_id, previous.requires_armed
      into current_post;
  end if;
  next_revision := coalesce(previous.revision, 0) + 1;
  insert into private.floating_patrol_post_policies (post_id, revision, anchor_site_id, anchor_client_id, requires_armed, approved_by, reason)
    values (target_post_id, next_revision, current_post.site_id, current_post.client_id, current_post.requires_armed, actor_id, clean_reason);
  insert into private.floating_patrol_post_policy_properties (post_id, revision, site_id, client_id)
    select target_post_id, next_revision, site.id, site.client_id from public.sites site where site.id = any(selected_ids);
  insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
  values ((select auth.uid()), actor_id, 'private', 'floating_patrol_post_policies', case when cardinality(selected_ids) = 0 then 'revoke' else 'approve' end,
    target_post_id::text, jsonb_build_object('revision', previous.revision),
    jsonb_build_object('revision', next_revision, 'postId', target_post_id, 'siteIds', selected_ids, 'reason', clean_reason));
  return public.get_floating_patrol_post_scope_v1(target_post_id);
end;
$$;
revoke all on function public.save_floating_patrol_post_scope_v1(uuid, uuid[], integer, text) from public, anon, authenticated, service_role;
grant execute on function public.save_floating_patrol_post_scope_v1(uuid, uuid[], integer, text) to authenticated;

-- For pending reports, the exact list that existed before the shift ended is
-- a ceiling: later changes can narrow it but cannot add or revive access.
-- Post inheritance also expires 48 hours after shift end; a report consumer
-- may enforce a stricter filing window independently.
create function private.floating_patrol_post_assignment_v1(
  p_post_id uuid, p_ends_at timestamptz, p_requires_armed boolean
)
returns table (configured boolean, site_ids uuid[])
language sql stable security definer set search_path = '' as $$
  with authorized as (
    select policy.revision from private.floating_patrol_post_policies policy
    where policy.post_id = p_post_id and policy.approved_at < p_ends_at
    order by policy.revision desc limit 1
  )
  select exists(select 1 from authorized), coalesce((
    select array_agg(at_end.site_id order by at_end.site_id)
    from authorized
    join private.floating_patrol_post_policies earliest on earliest.post_id = p_post_id and earliest.revision = authorized.revision
    join private.floating_patrol_post_policy_properties at_end on at_end.post_id = p_post_id and at_end.revision = authorized.revision
    cross join lateral private.floating_patrol_post_state_v1(p_post_id) latest
    join private.floating_patrol_post_policy_properties current_binding
      on current_binding.post_id = p_post_id and current_binding.revision = latest.revision
      and current_binding.site_id = at_end.site_id and current_binding.client_id = at_end.client_id
    where p_ends_at > statement_timestamp() - interval '48 hours'
      and earliest.requires_armed = p_requires_armed and current_binding.site_id = any(latest.site_ids)
      and not exists (
        select 1 from private.floating_patrol_post_policies later
        where later.post_id = p_post_id and later.revision > authorized.revision
          and (row(later.anchor_site_id, later.anchor_client_id, later.requires_armed)
            is distinct from row(earliest.anchor_site_id, earliest.anchor_client_id, earliest.requires_armed)
          or not exists(select 1 from private.floating_patrol_post_policy_properties retained
            where retained.post_id = later.post_id and retained.revision = later.revision
              and retained.site_id = at_end.site_id and retained.client_id = at_end.client_id))
      )
  ), '{}'::uuid[]);
$$;
revoke all on function private.floating_patrol_post_assignment_v1(uuid, timestamptz, boolean) from public, anon, authenticated, service_role;

-- Reuse the same state consumed by the shift Admin view, Sygilant's picker,
-- and the canonical report mutation checks. Native and exact review behavior
-- retains first precedence and does not fall back into a recurring list.
create or replace function private.floating_patrol_scope_state_v1(p_employee_id uuid, p_shift_id uuid)
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
        or private.floating_patrol_predecessor_exists_v1(p_employee_id, p_shift_id) as exact_configured,
      current_shift.assignment_id is not null as current_assignment,
      coalesce(current_shift.ends_at > statement_timestamp(), false) as shift_bookable,
      private.floating_patrol_native_precedence_v1(p_employee_id, p_shift_id) as native_route,
      latest.revision is not null and current_shift.assignment_id is not null
        and row(latest.shift_assignment_id, latest.shift_assigned_at, latest.schedule_id, latest.post_id,
          latest.starts_at, latest.ends_at, latest.time_zone, latest.requires_armed)
          is not distinct from row(current_shift.assignment_id, current_shift.assigned_at, current_shift.schedule_id,
            current_shift.post_id, current_shift.starts_at, current_shift.ends_at, current_shift.time_zone, current_shift.requires_armed) as exact_approval,
      property_lists.approved_site_ids, property_lists.effective_site_ids,
      inherited.configured as inherited_configured, inherited.site_ids as inherited_site_ids
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
    cross join lateral private.floating_patrol_post_assignment_v1(current_shift.post_id, current_shift.ends_at, current_shift.requires_armed) inherited
  )
  select facts.revision, facts.exact_configured or facts.inherited_configured,
    (facts.current_assignment and facts.shift_bookable and not facts.native_route),
    case when facts.native_route then 'native_route'
      when not facts.current_assignment then 'ineligible'
      when facts.exact_approval and cardinality(facts.effective_site_ids) > 0 then 'ready'
      when facts.exact_approval then 'blocked'
      when facts.exact_configured then 'review_required'
      when facts.inherited_configured and cardinality(facts.inherited_site_ids) > 0 then 'ready'
      when facts.inherited_configured then 'blocked'
      when not facts.shift_bookable then 'ended'
      else 'not_configured' end,
    facts.approved_site_ids,
    case when facts.native_route then '{}'::uuid[]
      when facts.exact_approval then facts.effective_site_ids
      when not facts.exact_configured then facts.inherited_site_ids
      else '{}'::uuid[] end
  from facts;
$$;

create function private.floating_patrol_lock_post_v1(p_shift_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare target_post_id uuid;
begin
  begin
    select s.post_id into target_post_id from public.shifts s where s.id = p_shift_id and s.post_id is not null
      for share of s nowait;
  exception when lock_not_available then
    raise sqlstate 'PT409' using message = 'The shift is being updated. Refresh and try again.', detail = 'floating_patrol_record_busy';
  end;
  if target_post_id is not null and not pg_try_advisory_xact_lock_shared(
    hashtextextended('patrol:floating-post:' || target_post_id::text, 0)) then
    raise sqlstate 'PT409' using message = 'The patrol post is being updated. Refresh and try again.', detail = 'floating_patrol_post_busy';
  end if;
  if exists (select 1 from private.floating_patrol_post_policies p where p.post_id = target_post_id) then
    begin
      perform 1 from public.posts post join public.sites site on site.id = post.site_id
      join public.clients client on client.id = site.client_id where post.id = target_post_id
      for share of post, site, client nowait;
    exception when lock_not_available then
      raise sqlstate 'PT409' using message = 'The patrol post or its property is being updated. Refresh and try again.', detail = 'floating_patrol_post_record_busy';
    end;
  end if;
end;
$$;
revoke all on function private.floating_patrol_lock_post_v1(uuid) from public, anon, authenticated, service_role;

create or replace function private.floating_patrol_assignment_configured_v1(target_employee_id uuid, target_shift_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare configured boolean;
begin
  if target_employee_id is null or target_shift_id is null then return false; end if;
  if not pg_try_advisory_xact_lock_shared(hashtextextended('patrol:route-link:' || target_shift_id::text || ':' || target_employee_id::text, 0)) then
    raise sqlstate 'PT409' using message = 'Patrol reporting access is being updated. Refresh and try again.', detail = 'floating_patrol_shift_busy';
  end if;
  perform private.floating_patrol_lock_post_v1(target_shift_id);
  select s.configured and s.status <> 'native_route' into configured
  from private.floating_patrol_scope_state_v1(target_employee_id, target_shift_id) s;
  if configured then perform private.floating_patrol_lock_week_v1(target_shift_id); end if;
  return configured;
end;
$$;

-- Keep the exact authority path and append-only history. An initial empty
-- revision is allowed only when deliberately overriding a real inherited list.
create or replace function public.save_floating_patrol_scope_v1(
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
  perform private.floating_patrol_lock_post_v1(target_shift_id);
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
  if observed_revision is null and cardinality(site_ids) = 0 and not exists (
    select 1 from private.floating_patrol_scope_state_v1(target_employee_id, target_shift_id) state
    where state.eligible and state.status = 'ready' and cardinality(state.site_ids) > 0
  ) then
    raise invalid_parameter_value using message = 'Select a property, or block a currently inherited property list for this shift.';
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

comment on function public.service_get_floating_patrol_scopes_v1(uuid, uuid[]) is
  'Server-only exact shift/employee reporting scope. An Operations-approved post policy is used only after native and explicit shift decisions.';
select pg_notify('pgrst', 'reload schema');
commit;
