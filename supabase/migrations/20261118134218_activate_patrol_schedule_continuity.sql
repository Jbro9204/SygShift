-- Phase 2: activate only after the shared consumers understand phase 1 readers.
-- No historical mappings are guessed or backfilled.
begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

do $preflight$
declare item record; definition text;
begin
  for item in select * from (values
    ('private.copy_schedule_shift_block(uuid,uuid,uuid,uuid,uuid)','60c431436fe26315ba35be2346b4ee8d506e0ece55a09181b1df463d6105ba48'),
    ('private.materialize_schedule_draft_revision(date)','402fae2f1c025e7aa98cb5bf41eddea16f97b21d446a394e0aa906573ceef58c'),
    ('public.publish_schedule_draft(uuid)','8db93c10b72ae1e9119ec1d878ec58072cb013bfc8e7e64060c3432a8aed50c5'),
    ('public.publish_employee_schedule_slice(uuid,uuid)','ccd79db161a3cad7d75004d8ca3b1b1e6f3e3f4b76943f275dc91b3703d28555'),
    ('public.get_patrol_workspace()','0b5acc7a529b4913653b1c47e1e91d212f9d46cd3a1386484b8d979154526dc5'),
    ('public.link_patrol_route_shift(uuid,uuid,uuid)','ac3bbbb3feb3d1a9d9443629963b2b76f178a8ba3f81137dfb026b54ea5be402'),
    ('private.normalize_schedule_duplicate_shift_blocks(uuid)','5b74a22b661fc4e1f7632bdff21b8424e83b74fabe1ede7eecc3dc8d138a92cf'),
    ('public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,uuid,boolean)','2d723fb69e943a9e86398b26bf15dc3f535f7f6ddf6ca065d5fb98068d323458')
  ) expected(signature,checksum) loop
    if not exists(select 1 from pg_proc function where function.oid=to_regprocedure(item.signature)
      and function.prosecdef and function.provolatile='v' and function.proconfig=array['search_path=""']::text[]
      and encode(extensions.digest(replace(function.prosrc,E'\r\n',E'\n'),'sha256'),'hex')=item.checksum) then
      raise exception 'The reviewed patrol schedule source changed: %',item.signature;
    end if;
  end loop;
  definition:=pg_get_functiondef('private.copy_schedule_shift_block(uuid,uuid,uuid,uuid,uuid)'::regprocedure);
  execute replace(definition,'FUNCTION private.copy_schedule_shift_block(', 'FUNCTION private.copy_schedule_shift_block_before_patrol_continuity_v1(');
  definition:=pg_get_functiondef('public.get_patrol_workspace()'::regprocedure);
  execute replace(definition,'FUNCTION public.get_patrol_workspace(', 'FUNCTION private.get_patrol_workspace_before_continuity_v1(');
  definition:=pg_get_functiondef('public.link_patrol_route_shift(uuid,uuid,uuid)'::regprocedure);
  execute replace(definition,'FUNCTION public.link_patrol_route_shift(', 'FUNCTION private.link_patrol_route_shift_before_continuity_v1(');
  definition:=pg_get_functiondef('public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,uuid,boolean)'::regprocedure);
  execute replace(definition,'FUNCTION public.save_patrol_hit(', 'FUNCTION private.save_patrol_hit_before_continuity_v1(');
  -- Record the normalizer's actual chosen survivor, never infer one afterwards.
  definition:=pg_get_functiondef('private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure);
  if (length(definition)-length(replace(definition,'    update public.shifts duplicate_shift','')))/length('    update public.shifts duplicate_shift')<>1 then
    raise exception 'The reviewed schedule normalization boundary changed.';
  end if;
  execute replace(definition,'    update public.shifts duplicate_shift',$lineage$
    insert into private.schedule_shift_revision_links(draft_schedule_id,source_schedule_id,source_shift_id,draft_shift_id,created_by)
    select target_schedule_id,target_schedule_id,shift.id,duplicate_group.survivor_shift_id,coalesce(actor_id,shift.created_by)
    from public.shifts shift where shift.id=any(duplicate_shift_ids)
    on conflict on constraint schedule_shift_revision_links_pkey do nothing;

    update public.shifts duplicate_shift$lineage$);
end;
$preflight$;
revoke all on function private.copy_schedule_shift_block_before_patrol_continuity_v1(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.get_patrol_workspace_before_continuity_v1() from public,anon,authenticated,service_role;
revoke all on function private.link_patrol_route_shift_before_continuity_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.save_patrol_hit_before_continuity_v1(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,uuid,boolean) from public,anon,authenticated,service_role;

create or replace function private.copy_schedule_shift_block(source_shift_id uuid,destination_schedule_id uuid,actor_id uuid,
  include_only_employee_id uuid default null,exclude_employee_id uuid default null)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare copied_id uuid; existing_id uuid;
begin
  copied_id:=private.copy_schedule_shift_block_before_patrol_continuity_v1(
    copy_schedule_shift_block.source_shift_id,copy_schedule_shift_block.destination_schedule_id,
    copy_schedule_shift_block.actor_id,copy_schedule_shift_block.include_only_employee_id,copy_schedule_shift_block.exclude_employee_id);
  if copied_id is not null and exists(select 1 from public.shifts source_shift
    join public.schedules source_schedule on source_schedule.id=source_shift.schedule_id
    join public.schedules destination on destination.id=copy_schedule_shift_block.destination_schedule_id
    where source_shift.id=copy_schedule_shift_block.source_shift_id and source_schedule.week_starts_on=destination.week_starts_on) then
    insert into private.schedule_shift_revision_links(draft_schedule_id,source_schedule_id,source_shift_id,draft_shift_id,created_by)
    select copy_schedule_shift_block.destination_schedule_id,shift.schedule_id,shift.id,copied_id,copy_schedule_shift_block.actor_id
    from public.shifts shift where shift.id=copy_schedule_shift_block.source_shift_id
    on conflict on constraint schedule_shift_revision_links_pkey do nothing;
    select link.draft_shift_id into existing_id from private.schedule_shift_revision_links link
      where link.draft_schedule_id=copy_schedule_shift_block.destination_schedule_id and link.source_shift_id=copy_schedule_shift_block.source_shift_id;
    if existing_id is distinct from copied_id then
      raise exception 'This schedule copy has conflicting exact shift lineage.';
    end if;
  end if;
  return copied_id;
end;
$$;
revoke all on function private.copy_schedule_shift_block(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function private.reconcile_patrol_schedule_publication_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare candidate record; actor_id uuid:=coalesce(private.current_employee_id(),new.published_by);
  binding_status text; binding_reason text; inserted_count integer:=0; inserted_row integer;
begin
  if new.status<>'published' or old.status is not distinct from new.status then return new; end if;
  if new.previous_revision_id is null or not exists(select 1 from public.schedules previous
    where previous.id=new.previous_revision_id and previous.week_starts_on=new.week_starts_on) then return new; end if;
  -- Roots are proven direct/alias assignments on the precise predecessor, never name or time matches.
  for candidate in
    with roots as (
      select assignment.id as assignment_id,assignment.route_id,assignment.employee_id,
        assignment.shift_id as origin_shift_id,shift.id as source_shift_id,false as prior_review
      from public.patrol_assignments assignment join public.shifts shift on shift.id=assignment.shift_id
      where shift.schedule_id=new.previous_revision_id and assignment.status<>'canceled' and assignment.canceled_at is null
      union
      select assignment.id,assignment.route_id,assignment.employee_id,assignment.shift_id,
        coalesce(binding.target_shift_id,binding.source_shift_id),binding.status='review_required'
      from private.patrol_schedule_continuity binding
      join public.patrol_assignments assignment on assignment.id=binding.assignment_id
      where binding.target_schedule_id=new.previous_revision_id
        and assignment.status<>'canceled' and assignment.canceled_at is null
        and not exists(select 1 from private.patrol_schedule_resolution_receipts resolved where resolved.continuity_id=binding.id)
    ), reachable as (
      select root.*,target.shift_id as target_shift_id,
        exists(select 1 from public.shift_assignments assigned where assigned.shift_id=target.shift_id
          and assigned.employee_id=root.employee_id and assigned.status in ('assigned','confirmed','completed')
          and assigned.canceled_at is null) as retains_employee
      from roots root left join lateral private.patrol_schedule_targets_v1(root.source_shift_id,new.id) target on true
    ), selected as (
      select reachable.* from reachable where reachable.retains_employee
        or not exists(select 1 from reachable preferred where preferred.assignment_id=reachable.assignment_id and preferred.retains_employee)
    ), candidates as (
      select selected.*,count(*) over(partition by selected.target_shift_id,selected.employee_id,selected.route_id) as same_route_sources
      from selected
    ) select * from candidates
  loop
    if actor_id is null then
      raise insufficient_privilege using message='A recorded publisher is required to preserve existing patrol connections.';
    end if;
    binding_status:='review_required';
    binding_reason:=case
      when candidate.target_shift_id is null then 'lineage_missing'
      when not exists(select 1 from public.shifts shift
        where shift.id=candidate.target_shift_id and shift.schedule_id=new.id and shift.canceled_at is null) then 'shift_removed'
      when candidate.same_route_sources>1 then 'ambiguous_lineage'
      when candidate.prior_review then 'prior_review'
      when not private.patrol_same_schedule_occurrence_v1(candidate.source_shift_id,candidate.target_shift_id)
        or not private.patrol_same_schedule_occurrence_v1(candidate.origin_shift_id,candidate.target_shift_id) then 'shift_changed'
      when not exists(select 1 from public.shift_assignments assigned where assigned.shift_id=candidate.target_shift_id
        and assigned.employee_id=candidate.employee_id and assigned.status in ('assigned','confirmed','completed') and assigned.canceled_at is null) then 'employee_changed'
      else 'unchanged' end;
    if binding_reason='unchanged' then binding_status:='linked'; end if;
    insert into private.patrol_schedule_continuity(assignment_id,source_shift_id,target_shift_id,target_schedule_id,
      employee_id,status,reason,created_by)
    values(candidate.assignment_id,candidate.source_shift_id,candidate.target_shift_id,new.id,
      candidate.employee_id,binding_status,binding_reason,actor_id)
    on conflict do nothing;
    get diagnostics inserted_row=row_count;
    inserted_count:=inserted_count+inserted_row;
  end loop;
  if inserted_count>0 then
    insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record)
    values(auth.uid(),actor_id,'private','patrol_schedule_continuity','preserve_schedule_revision',new.id::text,
      jsonb_build_object('previousScheduleId',new.previous_revision_id,'scheduleId',new.id,'bindingCount',inserted_count));
  end if;
  return new;
end;
$$;
revoke all on function private.reconcile_patrol_schedule_publication_v1() from public,anon,authenticated,service_role;
create trigger schedules_reconcile_patrol_continuity after update of status on public.schedules
for each row when (new.status='published' and old.status is distinct from new.status)
execute function private.reconcile_patrol_schedule_publication_v1();

create or replace function public.get_patrol_workspace()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare payload jsonb; projected jsonb; issues jsonb;
begin
  payload:=private.get_patrol_workspace_before_continuity_v1();
  select coalesce(jsonb_agg(item.value || jsonb_build_object('shiftId',private.patrol_effective_shift_id_v1((item.value->>'id')::uuid),
    'continuityStatus',case when private.patrol_assignment_needs_schedule_review_v1((item.value->>'id')::uuid) then 'review_required' else 'ready' end) order by item.ordinality),'[]'::jsonb)
    into projected from jsonb_array_elements(payload->'assignments') with ordinality item(value,ordinality);
  payload:=jsonb_set(payload,'{assignments}',projected);
  select coalesce(jsonb_agg(item.value order by item.ordinality),'[]'::jsonb) into projected
    from jsonb_array_elements(payload->'scheduleCandidates') with ordinality item(value,ordinality)
    where not exists(select 1 from private.patrol_schedule_continuity binding
      where binding.target_shift_id=(item.value->>'shiftId')::uuid
        and binding.employee_id=(item.value->>'employeeId')::uuid
        and private.patrol_assignment_shift_is_authorized_v1(binding.assignment_id,binding.target_shift_id,binding.employee_id));
  payload:=jsonb_set(payload,'{scheduleCandidates}',projected);
  issues:=private.patrol_schedule_continuity_issues_v1();
  return payload || jsonb_build_object('continuityIssuesTruncated',jsonb_array_length(issues)>100,
    'continuityIssues',(select coalesce(jsonb_agg(item.value order by item.ordinality),'[]'::jsonb)
      from jsonb_array_elements(issues) with ordinality item(value,ordinality) where item.ordinality<=100));
end;
$$;
revoke all on function public.get_patrol_workspace() from public,anon;
grant execute on function public.get_patrol_workspace() to authenticated;

create or replace function public.save_patrol_hit(
  target_hit_id uuid,target_assignment_id uuid,target_stop_id uuid,target_obligation_id uuid,target_makeup_assignment_id uuid,
  target_classification text,target_outcome text,target_note text,target_extra_reason text,target_location_status text,
  target_latitude numeric,target_longitude numeric,target_accuracy_meters numeric,target_client_recorded_at timestamptz,
  target_idempotency_key uuid,target_submit boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare actor_id uuid:=private.current_employee_id(); can_manage boolean;
  assignment_record public.patrol_assignments%rowtype; prior public.patrol_hits%rowtype;
  stop_record public.patrol_route_stops%rowtype; expected_location text;
begin
  can_manage:=private.patrol_can_manage() or public.has_effective_permission('patrol.exceptions.manage');
  if actor_id is null or not (public.has_effective_permission('patrol.hits.complete') or can_manage)
    or (target_classification='extra' and not (public.has_effective_permission('patrol.hits.extra') or can_manage)) then
    raise insufficient_privilege using message='Patrol Hit Completion permission is required.';
  end if;
  select * into assignment_record from public.patrol_assignments
    where id=target_assignment_id and status='active' and (employee_id=actor_id or can_manage) for share;
  if not found then raise insufficient_privilege using message='This active patrol assignment is not available to you.'; end if;
  if target_hit_id is null and private.patrol_assignment_needs_schedule_review_v1(target_assignment_id) then
    select * into prior from public.patrol_hits where submitted_by=actor_id and idempotency_key=target_idempotency_key;
    select * into stop_record from public.patrol_route_stops where id=target_stop_id;
    expected_location:=case when stop_record.latitude is null then 'not_configured'
      when target_latitude is null or target_longitude is null then
        case when target_location_status='declined' then 'declined' else 'unavailable' end
      else prior.location_status end;
    if prior.id is not null and prior.status in ('draft','submitted') and (not target_submit or prior.status='submitted')
      and row(prior.assignment_id,prior.stop_id,prior.obligation_id,prior.makeup_assignment_id,prior.classification,
        prior.outcome,prior.note,prior.extra_reason,prior.location_status,prior.latitude,prior.longitude,prior.accuracy_meters,prior.client_recorded_at)
        is not distinct from row(target_assignment_id,target_stop_id,target_obligation_id,target_makeup_assignment_id,target_classification,
        nullif(target_outcome,''),nullif(btrim(coalesce(target_note,'')),''),nullif(btrim(coalesce(target_extra_reason,'')),''),
        expected_location,target_latitude,target_longitude,target_accuracy_meters,target_client_recorded_at) then
      return prior.id;
    end if;
    raise sqlstate 'PT409' using message='This patrol route needs review after a schedule change. Existing work is retained; ask Operations to reconnect the current shift before adding a new hit.',detail='patrol_schedule_reconciliation_required';
  end if;
  return private.save_patrol_hit_before_continuity_v1(target_hit_id,target_assignment_id,target_stop_id,target_obligation_id,
    target_makeup_assignment_id,target_classification,target_outcome,target_note,target_extra_reason,target_location_status,
    target_latitude,target_longitude,target_accuracy_meters,target_client_recorded_at,target_idempotency_key,target_submit);
end;
$$;
revoke all on function public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamptz,uuid,boolean) from public,anon;
grant execute on function public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamptz,uuid,boolean) to authenticated;

create or replace function public.link_patrol_route_shift(target_route_id uuid,target_shift_id uuid,target_employee_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare existing_id uuid; actor_id uuid:=private.current_employee_id();
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message='Patrol Assignment Management permission is required.';
  end if;
  if exists(select 1 from private.patrol_schedule_continuity binding
    join public.patrol_assignments assignment on assignment.id=binding.assignment_id
    join public.patrol_routes route on route.id=assignment.route_id
    where binding.target_shift_id=link_patrol_route_shift.target_shift_id and assignment.route_id=link_patrol_route_shift.target_route_id
      and private.patrol_assignment_shift_is_authorized_v1(assignment.id,link_patrol_route_shift.target_shift_id,link_patrol_route_shift.target_employee_id)
      and (route.status<>'active' or route.current_version_id is distinct from assignment.route_version_id)) then
    raise sqlstate 'PT409' using message='This shift retains an earlier route version. Review its retained patrol work before connecting an updated route.',detail='patrol_route_assignment_reconciliation_required';
  end if;
  select assignment.id into existing_id from private.patrol_schedule_continuity binding
    join public.patrol_assignments assignment on assignment.id=binding.assignment_id
    where binding.target_shift_id=link_patrol_route_shift.target_shift_id and assignment.route_id=link_patrol_route_shift.target_route_id
      and private.patrol_assignment_shift_is_authorized_v1(assignment.id,link_patrol_route_shift.target_shift_id,link_patrol_route_shift.target_employee_id)
    order by binding.created_at desc,binding.id desc limit 1;
  if existing_id is not null then return existing_id; end if;
  if exists(select 1 from private.patrol_schedule_continuity binding
    join public.patrol_assignments assignment on assignment.id=binding.assignment_id
    where binding.target_shift_id=link_patrol_route_shift.target_shift_id and binding.employee_id=link_patrol_route_shift.target_employee_id
      and assignment.route_id=link_patrol_route_shift.target_route_id and assignment.status<>'canceled' and assignment.canceled_at is null) then
    raise sqlstate 'PT409' using message='This shift retains patrol work from an earlier schedule revision. Operations must review that work before connecting a replacement route.',detail='patrol_schedule_reconciliation_required';
  end if;
  return private.link_patrol_route_shift_before_continuity_v1(target_route_id,target_shift_id,target_employee_id);
end;
$$;
revoke all on function public.link_patrol_route_shift(uuid,uuid,uuid) from public,anon;
grant execute on function public.link_patrol_route_shift(uuid,uuid,uuid) to authenticated;

create function public.reconcile_patrol_schedule_connection_v1(target_continuity_id uuid,target_employee_id uuid,target_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare binding private.patrol_schedule_continuity%rowtype;
  receipt private.patrol_schedule_resolution_receipts%rowtype;
  original public.patrol_assignments%rowtype; after_original public.patrol_assignments%rowtype;
  source_shift public.shifts%rowtype; destination public.shifts%rowtype; destination_schedule public.schedules%rowtype;
  actor_id uuid:=private.current_employee_id(); clean_reason text:=btrim(coalesce(target_reason,''));
  replacement_id uuid; resolution_status text; waived_count integer; original_shift_id uuid;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message='Patrol Assignment Management permission is required.';
  end if;
  if char_length(clean_reason) not between 8 and 1000 then
    raise invalid_parameter_value using message='Describe the reviewed patrol connection change in 8 to 1000 characters.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patrol:continuity:' || target_continuity_id::text,0));
  select * into receipt from private.patrol_schedule_resolution_receipts where continuity_id=target_continuity_id;
  if found then
    if receipt.employee_id is distinct from target_employee_id or receipt.reason<>clean_reason then
      raise sqlstate 'PT409' using message='This patrol review was already completed with different details. Refresh the workspace.';
    end if;
    return jsonb_build_object('assignmentId',receipt.assignment_id,'status',receipt.status);
  end if;
  select * into binding from private.patrol_schedule_continuity where id=target_continuity_id;
  if not found then raise no_data_found using message='This patrol connection review is no longer available.'; end if;
  select * into destination_schedule from public.schedules where id=binding.target_schedule_id;
  if not found then raise no_data_found using message='The review schedule is no longer available.'; end if;
  if not pg_try_advisory_xact_lock(hashtext('schedule-draft:' || destination_schedule.week_starts_on::text)) then
    raise sqlstate 'PT409' using message='This schedule is being updated. Refresh the patrol review after that update finishes.';
  end if;
  begin
    select * into destination_schedule from public.schedules where id=binding.target_schedule_id for share nowait;
  exception when lock_not_available then
    raise sqlstate 'PT409' using message='This schedule is being updated. Refresh the patrol review after that update finishes.';
  end;
  if destination_schedule.status<>'published' or destination_schedule.id is distinct from
    (select schedule.id from public.schedules schedule where schedule.week_starts_on=destination_schedule.week_starts_on
      and schedule.status='published' order by schedule.revision desc nulls last,schedule.published_at desc nulls last,schedule.id desc limit 1) then
    raise sqlstate 'PT409' using message='The published schedule changed. Review its current patrol connections.';
  end if;
  select shift_id into original_shift_id from public.patrol_assignments where id=binding.assignment_id;
  -- Do not wait while holding parent locks: a report, punch or publisher may
  -- acquire these rows in a different order. A busy review fails explicitly.
  perform 1 from public.shift_assignments assigned where assigned.shift_id in (original_shift_id,binding.target_shift_id)
    order by assigned.id for update nowait;
  perform 1 from public.shifts shift where shift.id in (original_shift_id,binding.target_shift_id)
    order by shift.id for update nowait;
  select * into original from public.patrol_assignments where id=binding.assignment_id for update nowait;
  if original.shift_id is distinct from original_shift_id then
    raise sqlstate 'PT409' using message='The patrol source changed. Refresh this review before continuing.';
  end if;
  select * into source_shift from public.shifts where id=original.shift_id;
  if binding.target_shift_id is not null then
    select * into destination from public.shifts where id=binding.target_shift_id;
  end if;
  perform 1 from public.patrol_hit_obligations obligation where obligation.assignment_id=original.id
    order by obligation.id for update nowait;
  if original.status<>'active' or original.canceled_at is not null or source_shift.starts_at<=clock_timestamp() then
    raise sqlstate 'PT409' using message='This patrol work has started or is retained as completed history. It needs a separate review; no work was changed.';
  end if;
  if binding.status='linked' and private.patrol_assignment_shift_is_authorized_v1(original.id,binding.target_shift_id,original.employee_id) then
    raise sqlstate 'PT409' using message='This patrol connection is already valid. Refresh the workspace.';
  end if;
  if exists(select 1 from public.patrol_hits hit where hit.assignment_id=original.id)
    or exists(select 1 from public.patrol_makeup_assignments makeup where makeup.assigned_patrol_assignment_id=original.id
      or makeup.obligation_id in (select obligation.id from public.patrol_hit_obligations obligation where obligation.assignment_id=original.id))
    or exists(select 1 from public.patrol_hit_obligations obligation where obligation.assignment_id=original.id
      and (obligation.status<>'scheduled' or obligation.completed_hit_id is not null or obligation.due_start_at<=clock_timestamp()))
    or exists(select 1 from public.time_events event where event.shift_id in (original.shift_id,binding.target_shift_id))
    or exists(select 1 from public.sygilant_reports report where report.shift_id in (original.shift_id,binding.target_shift_id)
      or report.assignment_id in (select assigned.id from public.shift_assignments assigned where assigned.shift_id in (original.shift_id,binding.target_shift_id))) then
    raise sqlstate 'PT409' using message='This patrol connection has recorded work, a report, time entry, or makeup history. No work was changed; preserve it for a separate review.';
  end if;
  if exists(select 1 from private.patrol_schedule_continuity other
    where other.assignment_id=original.id and other.target_shift_id is distinct from binding.target_shift_id
      and private.patrol_assignment_shift_is_authorized_v1(original.id,other.target_shift_id,original.employee_id)) then
    raise sqlstate 'PT409' using message='This patrol work still serves another current connection. No work was changed.';
  end if;
  if destination.id is null or destination.canceled_at is not null then
    if target_employee_id is not null then
      raise invalid_parameter_value using message='A removed shift can only close its unused future patrol work.';
    end if;
    resolution_status:='closed';
  else
    if destination.starts_at<=clock_timestamp() then
      raise sqlstate 'PT409' using message='The replacement shift has already started. No work was changed.';
    end if;
    if target_employee_id is null or not exists(select 1 from public.shift_assignments assigned
      join public.employees employee on employee.id=assigned.employee_id and employee.status='active'
      where assigned.shift_id=destination.id and assigned.employee_id=target_employee_id
        and assigned.status in ('assigned','confirmed') and assigned.canceled_at is null) then
      raise invalid_parameter_value using message='Choose an active employee assigned to this published shift.';
    end if;
    if exists(select 1 from private.patrol_schedule_continuity other where other.target_shift_id=destination.id
      and other.assignment_id<>original.id and not exists(select 1 from private.patrol_schedule_resolution_receipts resolved where resolved.continuity_id=other.id)) then
      raise sqlstate 'PT409' using message='Several earlier patrol assignments need reconciliation for this shift. No work was changed.';
    end if;
    if exists(select 1 from public.patrol_assignments assigned where assigned.shift_id=destination.id
      and assigned.employee_id=target_employee_id and assigned.status<>'canceled' and assigned.canceled_at is null) then
      raise sqlstate 'PT409' using message='This employee already has a patrol route on the current shift. Refresh and review it.';
    end if;
    replacement_id:=private.link_patrol_route_shift_before_continuity_v1(original.route_id,destination.id,target_employee_id);
    resolution_status:='reconnected';
  end if;
  update public.patrol_hit_obligations set status='waived',reconciled_at=clock_timestamp()
    where assignment_id=original.id and status='scheduled';
  get diagnostics waived_count=row_count;
  update public.patrol_assignments set status='canceled',canceled_at=clock_timestamp(),
    cancellation_reason='Reviewed schedule revision: ' || clean_reason where id=original.id returning * into after_original;
  insert into private.patrol_schedule_resolution_receipts(continuity_id,employee_id,assignment_id,status,reason,resolved_by)
    values(binding.id,target_employee_id,replacement_id,resolution_status,clean_reason,actor_id);
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,old_record,new_record)
    values(auth.uid(),actor_id,'public','patrol_assignments','reconcile_unused_schedule_revision',original.id::text,to_jsonb(original),
      jsonb_build_object('retainedAssignment',to_jsonb(after_original),'continuityId',binding.id,
        'replacementAssignmentId',replacement_id,'waivedUnusedRequirements',waived_count,'reason',clean_reason));
  return jsonb_build_object('assignmentId',replacement_id,'status',resolution_status);
exception when lock_not_available then
  raise sqlstate 'PT409' using message='This patrol work is being updated. No work was changed; refresh the review and try again after that update finishes.';
end;
$$;
revoke all on function public.reconcile_patrol_schedule_connection_v1(uuid,uuid,text) from public,anon,service_role;
grant execute on function public.reconcile_patrol_schedule_connection_v1(uuid,uuid,text) to authenticated;
commit;
