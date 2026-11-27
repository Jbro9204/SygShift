-- Carry only a uniquely proven exact approval to its unchanged published successor.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create function private.floating_patrol_schedule_ancestors_v1(p_shift_id uuid)
returns table(shift_id uuid) language sql stable security definer set search_path = '' as $$
  with recursive ancestors(id, depth) as (
    select p_shift_id, 0
    union
    select link.source_shift_id, ancestors.depth + 1
    from ancestors
    join private.schedule_shift_revision_links link on link.draft_shift_id = ancestors.id
    join public.shifts parent on parent.id = link.source_shift_id and parent.schedule_id = link.source_schedule_id
    join public.shifts child on child.id = link.draft_shift_id and child.schedule_id = link.draft_schedule_id
    join public.schedules parent_schedule on parent_schedule.id = parent.schedule_id
    join public.schedules child_schedule on child_schedule.id = child.schedule_id
    where parent_schedule.week_starts_on = child_schedule.week_starts_on
      and link.source_shift_id <> link.draft_shift_id and ancestors.depth < 64
  )
  select distinct id from ancestors;
$$;
revoke all on function private.floating_patrol_schedule_ancestors_v1(uuid) from public, anon, authenticated, service_role;

create or replace function private.floating_patrol_predecessor_exists_v1(p_employee_id uuid, p_shift_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive previous_shifts(id, depth) as (
    select link.source_shift_id, 1 from private.schedule_shift_revision_links link where link.draft_shift_id = p_shift_id
    union
    select link.source_shift_id, previous_shifts.depth + 1
    from previous_shifts join private.schedule_shift_revision_links link on link.draft_shift_id = previous_shifts.id
    where previous_shifts.depth < 64
  ), target_roots as materialized (
    select shift_id from private.floating_patrol_schedule_ancestors_v1(p_shift_id)
  )
  select exists (select 1 from previous_shifts p join private.floating_patrol_scope_approvals a on a.shift_id = p.id
    where a.employee_id = p_employee_id or not exists (
      select 1 from private.floating_patrol_shift_v1(a.employee_id, p_shift_id)))
  or exists (select 1 from previous_shifts where depth = 64)
  or exists (
    select 1
    from public.shifts target
    join public.schedules current_week on current_week.id = target.schedule_id
    join public.schedules prior_week on prior_week.week_starts_on = current_week.week_starts_on
      and prior_week.revision < current_week.revision and prior_week.published_at is not null
      and prior_week.status = 'superseded'
    join private.floating_patrol_scope_approvals approval on approval.schedule_id = prior_week.id
    where target.id = p_shift_id and approval.shift_id <> p_shift_id
      and (approval.employee_id = p_employee_id or not exists (
        select 1 from private.floating_patrol_shift_v1(approval.employee_id, p_shift_id)))
      and exists (
        select 1
        from target_roots target_root
        join private.floating_patrol_schedule_ancestors_v1(approval.shift_id) source_root using (shift_id)
      )
  );
$$;

create function private.preserve_floating_patrol_schedule_publication_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  carried record;
  publisher uuid := coalesce(private.current_employee_id(), new.published_by);
begin
  if new.previous_revision_id is null or not exists (
    select 1 from public.schedules prior
    where prior.id = new.previous_revision_id and prior.status = 'superseded'
      and prior.week_starts_on = new.week_starts_on and prior.revision < new.revision
      and prior.revision = (
        select max(latest.revision) from public.schedules latest
        where latest.week_starts_on = new.week_starts_on and latest.status = 'superseded'
          and latest.published_at is not null and latest.revision < new.revision
      )
  ) then return new; end if;

  -- Both publication paths hold the same week lock used by the approval RPC.
  for carried in
    with source_approvals as (
      select distinct on (approval.shift_id, approval.employee_id) approval.*
      from private.floating_patrol_scope_approvals approval
      where approval.schedule_id = new.previous_revision_id
      order by approval.shift_id, approval.employee_id, approval.revision desc
    ), matches as (
      select approval.*, target.id as next_shift_id, next_assignment.assignment_id as next_assignment_id
      from source_approvals approval
      join public.shifts source on source.id = approval.shift_id and source.schedule_id = approval.schedule_id
      join public.shift_assignments assignment on assignment.id = approval.shift_assignment_id
        and assignment.shift_id = source.id and assignment.employee_id = approval.employee_id
        and assignment.status in ('assigned', 'confirmed', 'completed') and assignment.canceled_at is null
      -- Bound the lookup before per-occurrence authorization; the full predicate below still governs.
      join public.shifts target on target.schedule_id = new.id and target.canceled_at is null
        and target.post_id = source.post_id and target.starts_at = source.starts_at and target.ends_at = source.ends_at
      cross join lateral private.floating_patrol_shift_v1(approval.employee_id, target.id) next_assignment
      where row(approval.shift_assigned_at, approval.post_id, approval.starts_at, approval.ends_at, approval.time_zone, approval.requires_armed)
        is not distinct from row(assignment.assigned_at, source.post_id, source.starts_at, source.ends_at, source.time_zone, source.requires_armed)
        and next_assignment.assigned_at = assignment.assigned_at
        and private.patrol_same_schedule_occurrence_v1(source.id, target.id)
        and not private.floating_patrol_native_precedence_v1(approval.employee_id, target.id)
        and exists (
          select 1
          from private.floating_patrol_schedule_ancestors_v1(target.id) target_root
          join private.floating_patrol_schedule_ancestors_v1(source.id) source_root using (shift_id)
        )
    ), unambiguous as (
      select matches.*,
        count(*) over (partition by shift_id, employee_id) as target_count,
        count(*) over (partition by next_shift_id, employee_id) as source_count
      from matches
    )
    select * from unambiguous where target_count = 1 and source_count = 1
  loop
    if publisher is null then
      raise insufficient_privilege using message = 'A recorded publisher is required to retain floating patrol approvals.';
    end if;
    insert into private.floating_patrol_scope_approvals
      (shift_id, employee_id, revision, shift_assignment_id, shift_assigned_at, schedule_id, post_id, starts_at,
       ends_at, time_zone, requires_armed, reason, approved_by, approved_at)
    values (carried.next_shift_id, carried.employee_id, 1, carried.next_assignment_id, carried.shift_assigned_at,
      new.id, carried.post_id, carried.starts_at, carried.ends_at, carried.time_zone, carried.requires_armed,
      carried.reason, carried.approved_by, carried.approved_at);

    -- A revocation produces an empty new approval. Keep all original client
    -- bindings so the existing live filters still govern the effective list.
    insert into private.floating_patrol_scope_properties (shift_id, employee_id, revision, site_id, client_id)
    select carried.next_shift_id, carried.employee_id, 1, property.site_id, property.client_id
    from private.floating_patrol_scope_properties property
    where property.shift_id = carried.shift_id and property.employee_id = carried.employee_id
      and property.revision = carried.revision;

    insert into private.audit_events (auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record)
    values (auth.uid(), publisher, 'private', 'floating_patrol_scope_approvals', 'preserve_schedule_revision',
      carried.next_shift_id::text,
      jsonb_build_object('shiftId', carried.shift_id, 'scheduleId', carried.schedule_id, 'revision', carried.revision),
      jsonb_build_object('shiftId', carried.next_shift_id, 'scheduleId', new.id, 'revision', 1, 'employeeId', carried.employee_id));
  end loop;
  return new;
end;
$$;
revoke all on function private.preserve_floating_patrol_schedule_publication_v1() from public, anon, authenticated, service_role;

create trigger schedules_reconcile_patrol_continuity_floating
after update of status on public.schedules
for each row when (new.status = 'published' and old.status is distinct from new.status)
execute function private.preserve_floating_patrol_schedule_publication_v1();

commit;
