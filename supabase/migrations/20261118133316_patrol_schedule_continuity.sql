-- Phase 1: additive readers only. No publication hook or live-data backfill.
-- A same-week revision may point at existing patrol work; it must not clone it.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table private.patrol_schedule_continuity (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.patrol_assignments(id) on delete restrict,
  source_shift_id uuid not null references public.shifts(id) on delete restrict,
  target_shift_id uuid references public.shifts(id) on delete restrict,
  target_schedule_id uuid not null references public.schedules(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  status text not null check (status in ('linked','review_required')),
  reason text not null check (reason in ('unchanged','shift_changed','employee_changed','shift_removed','lineage_missing','prior_review','ambiguous_lineage')),
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check (status <> 'linked' or (target_shift_id is not null and reason = 'unchanged')),
  check (target_shift_id is null or target_shift_id <> source_shift_id)
);
create unique index patrol_schedule_continuity_receipt_key on private.patrol_schedule_continuity
  (assignment_id,target_schedule_id,coalesce(target_shift_id,'00000000-0000-0000-0000-000000000000'::uuid));
create index patrol_schedule_continuity_target on private.patrol_schedule_continuity(target_shift_id,employee_id);
create index patrol_schedule_continuity_schedule on private.patrol_schedule_continuity(target_schedule_id,created_at desc);
alter table private.patrol_schedule_continuity enable row level security;
alter table private.patrol_schedule_continuity force row level security;
revoke all on private.patrol_schedule_continuity from public,anon,authenticated,service_role;

create function private.patrol_schedule_continuity_immutable_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise insufficient_privilege using message = 'Patrol schedule continuity is retained history.';
end;
$$;
revoke all on function private.patrol_schedule_continuity_immutable_v1() from public,anon,authenticated,service_role;
create trigger patrol_schedule_continuity_immutable before update or delete on private.patrol_schedule_continuity
for each row execute function private.patrol_schedule_continuity_immutable_v1();

create table private.patrol_schedule_resolution_receipts (
  continuity_id uuid primary key references private.patrol_schedule_continuity(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete restrict,
  assignment_id uuid references public.patrol_assignments(id) on delete restrict,
  status text not null check(status in ('reconnected','closed')),
  reason text not null check(char_length(btrim(reason)) between 8 and 1000),
  resolved_by uuid not null references public.employees(id) on delete restrict,
  resolved_at timestamptz not null default clock_timestamp(),
  check ((status='closed' and assignment_id is null and employee_id is null)
    or (status='reconnected' and assignment_id is not null and employee_id is not null))
);
alter table private.patrol_schedule_resolution_receipts enable row level security;
alter table private.patrol_schedule_resolution_receipts force row level security;
revoke all on private.patrol_schedule_resolution_receipts from public,anon,authenticated,service_role;
create trigger patrol_schedule_resolution_receipts_immutable before update or delete on private.patrol_schedule_resolution_receipts
for each row execute function private.patrol_schedule_continuity_immutable_v1();

create function private.patrol_schedule_targets_v1(source_id uuid,target_schedule_id uuid)
returns table(shift_id uuid) language sql stable security definer set search_path='' as $$
  with recursive lineage(shift_id,depth) as (
    select patrol_schedule_targets_v1.source_id,0
    union
    select link.draft_shift_id,lineage.depth+1
    from lineage join private.schedule_shift_revision_links link on link.source_shift_id=lineage.shift_id
    join public.schedules destination on destination.id=link.draft_schedule_id
    join public.schedules target on target.id=patrol_schedule_targets_v1.target_schedule_id
    where destination.week_starts_on=target.week_starts_on and lineage.depth<64
      and link.draft_shift_id<>lineage.shift_id
  ) select distinct lineage.shift_id from lineage
    join public.shifts shift on shift.id=lineage.shift_id and shift.schedule_id=patrol_schedule_targets_v1.target_schedule_id;
$$;
revoke all on function private.patrol_schedule_targets_v1(uuid,uuid) from public,anon,authenticated,service_role;

create function private.patrol_same_schedule_occurrence_v1(source_id uuid,target_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.shifts source_shift
    join public.schedules source_schedule on source_schedule.id=source_shift.schedule_id
    join public.shifts target_shift on target_shift.id=patrol_same_schedule_occurrence_v1.target_id
    join public.schedules target_schedule on target_schedule.id=target_shift.schedule_id
    where source_shift.id=patrol_same_schedule_occurrence_v1.source_id
      and source_schedule.week_starts_on=target_schedule.week_starts_on
      and source_shift.canceled_at is null and target_shift.canceled_at is null
      and row(source_shift.post_id,source_shift.event_id,source_shift.starts_at,source_shift.ends_at,
        source_shift.time_zone,source_shift.time_zone_source,source_shift.time_zone_employee_id,
        source_shift.requires_armed,source_shift.work_type,source_shift.assignment_type,
        source_shift.payroll_category,source_shift.coverage_source_shift_id)
        is not distinct from
        row(target_shift.post_id,target_shift.event_id,target_shift.starts_at,target_shift.ends_at,
        target_shift.time_zone,target_shift.time_zone_source,target_shift.time_zone_employee_id,
        target_shift.requires_armed,target_shift.work_type,target_shift.assignment_type,
        target_shift.payroll_category,target_shift.coverage_source_shift_id)
  );
$$;
revoke all on function private.patrol_same_schedule_occurrence_v1(uuid,uuid) from public,anon,authenticated,service_role;

create function private.patrol_assignment_shift_is_authorized_v1(target_assignment_id uuid,target_shift_id uuid,target_employee_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.patrol_assignments assignment
    where assignment.id=patrol_assignment_shift_is_authorized_v1.target_assignment_id
      and assignment.employee_id=patrol_assignment_shift_is_authorized_v1.target_employee_id
      and assignment.status <> 'canceled' and assignment.canceled_at is null
      and (assignment.shift_id=patrol_assignment_shift_is_authorized_v1.target_shift_id or exists (
        select 1 from private.patrol_schedule_continuity binding
        join public.shifts shift on shift.id=binding.target_shift_id and shift.canceled_at is null
        join public.schedules schedule on schedule.id=shift.schedule_id and schedule.status='published'
        where binding.assignment_id=assignment.id
          and binding.target_shift_id=patrol_assignment_shift_is_authorized_v1.target_shift_id
          and binding.employee_id=patrol_assignment_shift_is_authorized_v1.target_employee_id and binding.status='linked'
          and private.patrol_same_schedule_occurrence_v1(assignment.shift_id,shift.id)
          and schedule.id=(select current_schedule.id from public.schedules current_schedule
            where current_schedule.week_starts_on=schedule.week_starts_on and current_schedule.status='published'
            order by current_schedule.revision desc nulls last,current_schedule.published_at desc nulls last,current_schedule.id desc limit 1)
          and exists(select 1 from public.shift_assignments assigned where assigned.shift_id=shift.id
            and assigned.employee_id=patrol_assignment_shift_is_authorized_v1.target_employee_id and assigned.status in ('assigned','confirmed','completed')
            and assigned.canceled_at is null)
      ))
  );
$$;
revoke all on function private.patrol_assignment_shift_is_authorized_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.patrol_assignment_shift_is_authorized_v1(uuid,uuid,uuid) to service_role;

create function private.patrol_effective_shift_id_v1(target_assignment_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce((select binding.target_shift_id from private.patrol_schedule_continuity binding
    where binding.assignment_id=assignment.id and binding.status='linked'
      and private.patrol_assignment_shift_is_authorized_v1(assignment.id,binding.target_shift_id,assignment.employee_id)
    order by binding.created_at desc,binding.id desc limit 1),assignment.shift_id)
  from public.patrol_assignments assignment where assignment.id=patrol_effective_shift_id_v1.target_assignment_id;
$$;
revoke all on function private.patrol_effective_shift_id_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function private.patrol_effective_shift_id_v1(uuid) to service_role;

create function private.patrol_predecessor_shift_ids_v1(target_assignment_id uuid,current_shift_id uuid)
returns uuid[] language sql stable security definer set search_path='' as $$
  select coalesce((select array_prepend(assignment.shift_id,array(
    select prior.target_shift_id from private.patrol_schedule_continuity prior
    join public.schedules previous_schedule on previous_schedule.id=prior.target_schedule_id
    join public.shifts current_shift on current_shift.id=patrol_predecessor_shift_ids_v1.current_shift_id
    join public.schedules current_schedule on current_schedule.id=current_shift.schedule_id
    where prior.assignment_id=assignment.id and prior.employee_id=assignment.employee_id and prior.status='linked'
      and prior.target_shift_id<>patrol_predecessor_shift_ids_v1.current_shift_id
      and previous_schedule.week_starts_on=current_schedule.week_starts_on
      and previous_schedule.revision<current_schedule.revision
      and private.patrol_same_schedule_occurrence_v1(assignment.shift_id,prior.target_shift_id)
      and exists(select 1 from private.patrol_schedule_targets_v1(prior.target_shift_id,current_schedule.id) target
        where target.shift_id=patrol_predecessor_shift_ids_v1.current_shift_id)
    order by previous_schedule.revision desc,prior.created_at desc,prior.id desc limit 64
  )) from public.patrol_assignments assignment
    where assignment.id=patrol_predecessor_shift_ids_v1.target_assignment_id
      and assignment.shift_id<>patrol_predecessor_shift_ids_v1.current_shift_id
      and private.patrol_assignment_shift_is_authorized_v1(assignment.id,
        patrol_predecessor_shift_ids_v1.current_shift_id,assignment.employee_id)), '{}'::uuid[]);
$$;
revoke all on function private.patrol_predecessor_shift_ids_v1(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.patrol_predecessor_shift_ids_v1(uuid,uuid) to service_role;

create function private.patrol_retained_shift_is_authorized_v1(target_assignment_id uuid,target_shift_id uuid,target_employee_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select private.patrol_assignment_shift_is_authorized_v1(
    patrol_retained_shift_is_authorized_v1.target_assignment_id,patrol_retained_shift_is_authorized_v1.target_shift_id,
    patrol_retained_shift_is_authorized_v1.target_employee_id)
  or exists(select 1 from public.patrol_assignments assignment
    where assignment.id=patrol_retained_shift_is_authorized_v1.target_assignment_id
      and assignment.employee_id=patrol_retained_shift_is_authorized_v1.target_employee_id
      and patrol_retained_shift_is_authorized_v1.target_shift_id=any(private.patrol_predecessor_shift_ids_v1(
        assignment.id,private.patrol_effective_shift_id_v1(assignment.id))));
$$;
revoke all on function private.patrol_retained_shift_is_authorized_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.patrol_retained_shift_is_authorized_v1(uuid,uuid,uuid) to service_role;

create function private.patrol_assignment_needs_schedule_review_v1(target_assignment_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.patrol_schedule_continuity binding
    join public.schedules schedule on schedule.id=binding.target_schedule_id and schedule.status='published'
    where binding.assignment_id=patrol_assignment_needs_schedule_review_v1.target_assignment_id
      and schedule.id=(select current_schedule.id from public.schedules current_schedule
        where current_schedule.week_starts_on=schedule.week_starts_on and current_schedule.status='published'
        order by current_schedule.revision desc nulls last,current_schedule.published_at desc nulls last,current_schedule.id desc limit 1)
      and (binding.status='review_required' or not private.patrol_assignment_shift_is_authorized_v1(binding.assignment_id,binding.target_shift_id,binding.employee_id))
      and not exists(select 1 from private.patrol_schedule_resolution_receipts resolved where resolved.continuity_id=binding.id));
$$;
revoke all on function private.patrol_assignment_needs_schedule_review_v1(uuid) from public,anon,authenticated,service_role;

create function public.service_get_patrol_reporting_bindings_v1(target_employee_id uuid,target_shift_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_employee_id is null or target_shift_ids is null
    or cardinality(target_shift_ids)>2000 or array_position(target_shift_ids,null) is not null then
    raise invalid_parameter_value using message = 'Choose a bounded employee shift set.';
  end if;
  with requested as (select distinct unnest(target_shift_ids) as shift_id), rows as (
    select assignment.id,assignment.shift_id,assignment.employee_id,assignment.route_id,assignment.route_version_id,
      assignment.status,assignment.shift_id as source_shift_id,assignment.employee_id as source_employee_id,
      private.patrol_effective_shift_id_v1(assignment.id) as current_shift_id,
      '{}'::uuid[] as predecessor_shift_ids,'direct'::text as continuity_status
    from public.patrol_assignments assignment join requested on requested.shift_id=assignment.shift_id
    where assignment.employee_id=target_employee_id and assignment.status<>'canceled' and assignment.canceled_at is null
    union all
    select assignment.id,binding.target_shift_id,target_employee_id,assignment.route_id,assignment.route_version_id,
      assignment.status,assignment.shift_id,assignment.employee_id,private.patrol_effective_shift_id_v1(assignment.id),
      case when binding.status='linked' and private.patrol_retained_shift_is_authorized_v1(assignment.id,binding.target_shift_id,target_employee_id)
        then private.patrol_predecessor_shift_ids_v1(assignment.id,private.patrol_effective_shift_id_v1(assignment.id)) else '{}'::uuid[] end,
      case when binding.status='linked' and private.patrol_retained_shift_is_authorized_v1(assignment.id,binding.target_shift_id,target_employee_id)
        then 'linked' else 'review_required' end
    from private.patrol_schedule_continuity binding
    join requested on requested.shift_id=binding.target_shift_id
    join public.patrol_assignments assignment on assignment.id=binding.assignment_id
    join public.shifts shift on shift.id=binding.target_shift_id and shift.canceled_at is null
    join public.schedules schedule on schedule.id=shift.schedule_id
    where ((schedule.status='published' and schedule.id=(select current_schedule.id from public.schedules current_schedule
      where current_schedule.week_starts_on=schedule.week_starts_on and current_schedule.status='published'
      order by current_schedule.revision desc nulls last,current_schedule.published_at desc nulls last,current_schedule.id desc limit 1)
      and exists(select 1 from public.shift_assignments assigned where assigned.shift_id=shift.id
        and assigned.employee_id=target_employee_id and assigned.status in ('assigned','confirmed','completed') and assigned.canceled_at is null))
      or (binding.status='linked' and binding.employee_id=target_employee_id
        and private.patrol_retained_shift_is_authorized_v1(assignment.id,binding.target_shift_id,target_employee_id)))
      and (private.patrol_retained_shift_is_authorized_v1(assignment.id,binding.target_shift_id,target_employee_id)
        or not exists(select 1 from public.patrol_assignments direct_assignment
        where direct_assignment.shift_id=shift.id and direct_assignment.employee_id=target_employee_id
          and direct_assignment.status<>'canceled' and direct_assignment.canceled_at is null))
  ), bounded as (select * from rows limit 10001)
  select coalesce(jsonb_agg(to_jsonb(bounded) order by bounded.shift_id,bounded.id),'[]'::jsonb) into result from bounded;
  if jsonb_array_length(result)>10000 then
    raise program_limit_exceeded using message = 'Patrol reporting scope exceeds its safe read boundary.';
  end if;
  return result;
end;
$$;
revoke all on function public.service_get_patrol_reporting_bindings_v1(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.service_get_patrol_reporting_bindings_v1(uuid,uuid[]) to service_role;

comment on function public.service_get_patrol_reporting_bindings_v1(uuid,uuid[]) is
  'Server-only exact shift/employee patrol bindings. review_required rows convey no property authorization. Same-week aliases retain original assignment and obligation identities.';

create function private.patrol_schedule_continuity_issues_v1()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(issue) order by issue."createdAt" desc,issue.id),'[]'::jsonb)
  from (
    select binding.id,binding.assignment_id as "assignmentId",binding.source_shift_id as "sourceShiftId",
      binding.target_shift_id as "targetShiftId",binding.target_schedule_id as "scheduleId",
      binding.employee_id as "employeeId",concat_ws(' ',employee.first_name,employee.last_name) as "employeeName",
      route.id as "routeId",route.name as "routeName",binding.reason,binding.created_at as "createdAt"
    from private.patrol_schedule_continuity binding
    join public.patrol_assignments assignment on assignment.id=binding.assignment_id
    join public.patrol_routes route on route.id=assignment.route_id
    join public.employees employee on employee.id=binding.employee_id
    join public.schedules schedule on schedule.id=binding.target_schedule_id and schedule.status='published'
    where (private.patrol_can_manage() or public.has_effective_permission('patrol.operations.view')
      or public.has_effective_permission('patrol.assignments.manage'))
      and schedule.week_starts_on between (now() at time zone 'America/Denver')::date-14
        and (now() at time zone 'America/Denver')::date+60
      and schedule.id=(select current_schedule.id from public.schedules current_schedule
        where current_schedule.week_starts_on=schedule.week_starts_on and current_schedule.status='published'
        order by current_schedule.revision desc nulls last,current_schedule.published_at desc nulls last,current_schedule.id desc limit 1)
      and (binding.status='review_required' or not private.patrol_assignment_shift_is_authorized_v1(
        binding.assignment_id,binding.target_shift_id,binding.employee_id))
      and not exists(select 1 from private.patrol_schedule_resolution_receipts resolved where resolved.continuity_id=binding.id)
      and not exists(select 1 from public.patrol_assignments direct_assignment
        where direct_assignment.shift_id=binding.target_shift_id
          and direct_assignment.status<>'canceled' and direct_assignment.canceled_at is null)
    order by binding.created_at desc,binding.id limit 101
  ) issue;
$$;
revoke all on function private.patrol_schedule_continuity_issues_v1() from public,anon,authenticated,service_role;
commit;
