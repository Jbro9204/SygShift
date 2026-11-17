-- Versioned route configuration only. Do not rewrite existing assignments,
-- obligations, schedules, punches, payroll, report content or identity records.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create table private.patrol_route_save_receipts (
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  idempotency_key uuid not null,
  request_checksum text not null check (request_checksum ~ '^[a-f0-9]{64}$'),
  route_id uuid not null references public.patrol_routes(id) on delete restrict,
  route_version_id uuid not null references public.patrol_route_versions(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor_employee_id,idempotency_key)
);
alter table private.patrol_route_save_receipts enable row level security;
alter table private.patrol_route_save_receipts force row level security;
revoke all on private.patrol_route_save_receipts from public,anon,authenticated,service_role;

create function private.patrol_route_save_receipt_immutable()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise insufficient_privilege using message = 'Patrol route save receipts are retained audit records.';
end;
$$;
revoke all on function private.patrol_route_save_receipt_immutable() from public,anon,authenticated,service_role;
create trigger patrol_route_save_receipts_immutable before update or delete on private.patrol_route_save_receipts
for each row execute function private.patrol_route_save_receipt_immutable();

-- Retain the reviewed version-writing bodies behind private-only wrappers.
-- Public names/OIDs, current employee checks, effective permission/MFA checks,
-- native version creation, audit events and return contracts remain intact.
do $retain$
declare
  definition text;
begin
  if not exists(select 1 from pg_proc function where function.oid = 'public.save_patrol_route(jsonb)'::regprocedure
    and function.prosecdef and function.provolatile = 'v' and function.proconfig = array['search_path=""']::text[]
    and encode(extensions.digest(replace(function.prosrc,E'\r\n',E'\n'),'sha256'),'hex') = '2283b1365520e87e6c3935593d865020d8249544518e9bf597715279c54d30d6')
    or not exists(select 1 from pg_proc function where function.oid = 'public.link_patrol_route_shift(uuid,uuid,uuid)'::regprocedure
    and function.prosecdef and function.provolatile = 'v' and function.proconfig = array['search_path=""']::text[]
    and encode(extensions.digest(replace(function.prosrc,E'\r\n',E'\n'),'sha256'),'hex') = '4f0d7b1d6962ce445f47780df1aad66b14392e330fb0325ac8a436b50b1008b1') then
    raise exception 'The exact reviewed patrol writers changed; repair refused.';
  end if;
  definition := pg_get_functiondef('public.save_patrol_route(jsonb)'::regprocedure);
  if definition not like '%resolved_route_id%'
    or definition not like '%Patrol Route Management permission is required.%'
    or definition not like '%insert into public.patrol_route_versions%'
    or definition not like '%insert into private.audit_events%' then
    raise exception 'The reviewed patrol route version writer changed; repair refused.';
  end if;
  execute replace(definition, 'FUNCTION public.save_patrol_route(',
    'FUNCTION private.save_patrol_route_version_body_v1(');
  definition := pg_get_functiondef('public.link_patrol_route_shift(uuid,uuid,uuid)'::regprocedure);
  if definition not like '%patrol_assignment_id uuid%'
    or definition not like '%Patrol Assignment Management permission is required.%'
    or definition not like '%on conflict on constraint patrol_hit_obligations_unique do nothing%' then
    raise exception 'The reviewed patrol assignment writer changed; repair refused.';
  end if;
  execute replace(definition, 'FUNCTION public.link_patrol_route_shift(',
    'FUNCTION private.link_patrol_route_shift_body_v1(');
end;
$retain$;
revoke all on function private.save_patrol_route_version_body_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.link_patrol_route_shift_body_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function private.patrol_assert_route_stops_v1(stops jsonb, require_complete boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  stop jsonb;
  requirement jsonb;
  site_identifier uuid;
  post_identifier uuid;
  active_requirements integer;
begin
  if jsonb_typeof(stops) is distinct from 'array' or jsonb_array_length(stops) not between 1 and 100 then
    raise invalid_parameter_value using message = 'Add between one and 100 patrol stops.';
  end if;
  for stop in select value from jsonb_array_elements(stops) loop
    if jsonb_typeof(stop) is distinct from 'object' then
      raise invalid_parameter_value using message = 'Each patrol stop must be a structured location.';
    end if;
    site_identifier := nullif(stop ->> 'siteId','')::uuid;
    post_identifier := nullif(stop ->> 'postId','')::uuid;
    if site_identifier is null then
      if require_complete or post_identifier is not null then
        raise invalid_parameter_value using message = 'Choose a verified property for every active patrol stop.';
      end if;
    else
      perform 1 from public.sites site
      join public.clients client on client.id = site.client_id and client.status = 'active'
      where site.id = site_identifier and site.active
      for share of site,client;
      if not found then
        raise invalid_parameter_value using message = 'A patrol property must be active and linked to an active client.';
      end if;
      if post_identifier is not null then
        perform 1 from public.posts post
        where post.id = post_identifier and post.site_id = site_identifier and post.active
        for share;
        if not found then
          raise invalid_parameter_value using message = 'Choose an active post belonging to the selected patrol property.';
        end if;
      end if;
    end if;
    if jsonb_typeof(coalesce(stop -> 'requirements','[]'::jsonb)) is distinct from 'array'
      or jsonb_array_length(coalesce(stop -> 'requirements','[]'::jsonb)) > 100 then
      raise invalid_parameter_value using message = 'Each patrol stop needs a bounded list of weekday requirements.';
    end if;
    active_requirements := 0;
    for requirement in select value from jsonb_array_elements(coalesce(stop -> 'requirements','[]'::jsonb)) loop
      if (requirement ->> 'dayOfWeek')::integer not between 0 and 6
        or (requirement ->> 'requiredHits')::integer not between 1 and 50 then
        raise invalid_parameter_value using message = 'Choose a valid weekday and one to 50 hits per requirement.';
      end if;
      if coalesce(requirement ->> 'status','active') = 'active' then active_requirements := active_requirements + 1; end if;
    end loop;
    if require_complete and active_requirements = 0 then
      raise invalid_parameter_value using message = 'Add at least one active weekday hit requirement to every active patrol stop.';
    end if;
  end loop;
end;
$$;
revoke all on function private.patrol_assert_route_stops_v1(jsonb,boolean) from public,anon,authenticated,service_role;

create or replace function public.save_patrol_route(target_route jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := private.current_employee_id();
  request_key uuid;
  request_checksum text;
  receipt private.patrol_route_save_receipts%rowtype;
  requested_route_id uuid;
  expected_version_id uuid;
  actual_version_id uuid;
  saved_route_id uuid;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.routes.manage')) then
    raise insufficient_privilege using message = 'Patrol Route Management permission is required.';
  end if;
  if jsonb_typeof(target_route) is distinct from 'object' or octet_length(target_route::text) > 262144
    or coalesce(target_route ->> 'idempotencyKey','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise invalid_parameter_value using message = 'Refresh Patrol and submit a protected route-save request.';
  end if;
  request_key := (target_route ->> 'idempotencyKey')::uuid;
  request_checksum := encode(extensions.digest(convert_to(target_route::text,'UTF8'),'sha256'),'hex');
  perform pg_advisory_xact_lock(hashtextextended('patrol:route-save:' || actor_id::text || ':' || request_key::text,0));
  select * into receipt from private.patrol_route_save_receipts
  where actor_employee_id = actor_id and idempotency_key = request_key;
  if found then
    if receipt.request_checksum is distinct from request_checksum then
      raise sqlstate 'PT409' using message = 'This route-save request already belongs to different changes. Reload and review the route.', detail = 'patrol_route_request_changed';
    end if;
    return receipt.route_id;
  end if;
  requested_route_id := nullif(target_route ->> 'id','')::uuid;
  expected_version_id := nullif(target_route ->> 'expectedVersionId','')::uuid;
  if requested_route_id is null then
    if expected_version_id is not null then
      raise invalid_parameter_value using message = 'A new route cannot refer to an earlier route version.';
    end if;
  else
    select current_version_id into actual_version_id from public.patrol_routes
    where id = requested_route_id for update;
    if not found then raise no_data_found using message = 'Patrol route was not found.'; end if;
    if expected_version_id is null or expected_version_id is distinct from actual_version_id then
      raise sqlstate 'PT409' using message = 'This route changed. Load the latest version and review your changes before saving.', detail = 'patrol_route_version_conflict';
    end if;
  end if;
  perform private.patrol_assert_route_stops_v1(target_route -> 'stops', target_route ->> 'status' = 'active');
  saved_route_id := private.save_patrol_route_version_body_v1(target_route);
  select current_version_id into actual_version_id from public.patrol_routes where id = saved_route_id;
  if actual_version_id is null then raise exception 'The saved route version could not be verified.'; end if;
  insert into private.patrol_route_save_receipts(actor_employee_id,idempotency_key,request_checksum,route_id,route_version_id)
  values(actor_id,request_key,request_checksum,saved_route_id,actual_version_id);
  return saved_route_id;
end;
$$;
revoke all on function public.save_patrol_route(jsonb) from public,anon;
grant execute on function public.save_patrol_route(jsonb) to authenticated;

create or replace function public.link_patrol_route_shift(target_route_id uuid,target_shift_id uuid,target_employee_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid := private.current_employee_id();
  route_record public.patrol_routes%rowtype;
  existing_assignment public.patrol_assignments%rowtype;
  local_day integer;
  shift_requires_armed boolean;
  stops jsonb;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.assignments.manage')) then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission is required.';
  end if;
  if target_route_id is null or target_shift_id is null or target_employee_id is null then
    raise invalid_parameter_value using message = 'Choose the exact route, published shift and employee.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('patrol:route-link:' || target_shift_id::text || ':' || target_employee_id::text,0));
  select * into route_record from public.patrol_routes
  where id = target_route_id and status = 'active' and current_version_id is not null for share;
  if not found then raise invalid_parameter_value using message = 'Activate a complete patrol route before assigning it.'; end if;
  if exists(select 1 from public.patrol_assignments assignment
    where assignment.route_id = target_route_id and assignment.shift_id = target_shift_id
      and assignment.employee_id = target_employee_id and assignment.status <> 'canceled'
      and assignment.route_version_id <> route_record.current_version_id) then
    raise sqlstate 'PT409' using message = 'This shift already has a retained earlier route version. Operations must reconcile that assignment before connecting the updated route.', detail = 'patrol_route_assignment_reconciliation_required';
  end if;
  select * into existing_assignment from public.patrol_assignments assignment
  where assignment.route_version_id = route_record.current_version_id
    and assignment.shift_id = target_shift_id and assignment.employee_id = target_employee_id for update;
  if found then
    if existing_assignment.status = 'canceled' then
      raise sqlstate 'PT409' using message = 'This patrol assignment was canceled. Operations must review it before restoring work.', detail = 'patrol_route_assignment_reconciliation_required';
    end if;
  end if;
  select extract(dow from shift.starts_at at time zone route_record.time_zone)::integer,shift.requires_armed into local_day,shift_requires_armed
  from public.shifts shift join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
  join public.shift_assignments assigned on assigned.shift_id = shift.id and assigned.employee_id = target_employee_id and assigned.status in ('assigned','confirmed') and assigned.canceled_at is null
  where shift.id = target_shift_id and shift.canceled_at is null and shift.ends_at > shift.starts_at
    and (shift.post_id is null or exists(select 1 from public.posts post where post.id = shift.post_id and post.active))
    and schedule.id = (select published.id from public.schedules published
      where published.week_starts_on = schedule.week_starts_on and published.status = 'published'
      order by published.revision desc nulls last,published.published_at desc nulls last,published.id desc limit 1)
  for share of shift,schedule,assigned;
  if not found then raise invalid_parameter_value using message = 'Choose a published shift assigned to this employee.'; end if;
  if route_record.requires_armed and not shift_requires_armed then
    raise invalid_parameter_value using message = 'An armed patrol route must be linked to an armed shift.';
  end if;
  select jsonb_agg(jsonb_build_object('siteId',stop.site_id,'postId',stop.post_id,
    'requirements',(select coalesce(jsonb_agg(jsonb_build_object('dayOfWeek',r.day_of_week,'requiredHits',r.required_hits,'status',r.status)),'[]'::jsonb)
      from public.patrol_stop_requirements r where r.stop_id = stop.id))) into stops
  from public.patrol_route_stops stop where stop.route_version_id = route_record.current_version_id;
  perform private.patrol_assert_route_stops_v1(stops,true);
  if not exists(select 1 from public.patrol_stop_requirements requirement
    join public.patrol_route_stops stop on stop.id = requirement.stop_id
    where stop.route_version_id = route_record.current_version_id and requirement.day_of_week = local_day and requirement.status = 'active') then
    raise invalid_parameter_value using message = 'This route has no active hit requirements for the selected shift weekday.';
  end if;
  if existing_assignment.id is not null then return existing_assignment.id; end if;
  return private.link_patrol_route_shift_body_v1(target_route_id,target_shift_id,target_employee_id);
end;
$$;
revoke all on function public.link_patrol_route_shift(uuid,uuid,uuid) from public,anon;
grant execute on function public.link_patrol_route_shift(uuid,uuid,uuid) to authenticated;

-- The manager's catalog is property-first. Guard route scope stays unchanged.
do $locations$
declare definition text;
  old_fragment text := $old$'postId', post.id,
        'postName', post.name,
        'requiresArmed', post.requires_armed,$old$;
  new_fragment text := $new$'postId', post.id,
        'postName', post.name,
        'clientId', client.id,
        'clientName', client.display_name,
        'requiresArmed', coalesce(post.requires_armed,false),$new$;
  old_join text := $old$from public.sites site
      join public.posts post on post.site_id = site.id and post.active
      where site.active$old$;
  new_join text := $new$from public.sites site
      join public.clients client on client.id = site.client_id and client.status = 'active'
      left join public.posts post on post.site_id = site.id and post.active
      where site.active$new$;
  old_candidates text := $old$where shift.ends_at >= now() - interval '1 day'
        and shift.starts_at <= now() + interval '60 days'$old$;
  new_candidates text := $new$where shift.ends_at >= now() - interval '1 day'
        and shift.starts_at <= now() + interval '60 days'
        and shift.canceled_at is null and shift.ends_at > shift.starts_at
        and assignment.canceled_at is null
        and (shift.post_id is null or post.active)
        and schedule.id = (select published.id from public.schedules published
          where published.week_starts_on = schedule.week_starts_on and published.status = 'published'
          order by published.revision desc nulls last,published.published_at desc nulls last,published.id desc limit 1)$new$;
begin
  definition := replace(pg_get_functiondef('public.get_patrol_workspace()'::regprocedure),E'\r\n',E'\n');
  if (length(definition)-length(replace(definition,old_fragment,'')))/length(old_fragment) <> 1
    or (length(definition)-length(replace(definition,old_join,'')))/length(old_join) <> 1
    or (length(definition)-length(replace(definition,old_candidates,'')))/length(old_candidates) <> 1 then
    raise exception 'The patrol location catalog changed; repair refused.';
  end if;
  execute replace(replace(replace(definition,old_fragment,new_fragment),old_join,new_join),old_candidates,new_candidates);
end;
$locations$;
commit;
