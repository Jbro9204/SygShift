begin;

-- Existing-route saves previously failed before any update or version insert because
-- the unqualified route_id in the version lookup conflicted with the PL/pgSQL
-- variable of the same name. Keep the public contract and all route behavior intact;
-- qualify the table column so PostgreSQL can resolve the lookup deterministically.
create or replace function public.save_patrol_route(target_route jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  resolved_route_id uuid;
  version_id uuid := gen_random_uuid();
  next_version integer;
  route_status text;
  route_code text;
  route_name text;
  route_time_zone text;
  stop_payload jsonb;
  requirement_payload jsonb;
  stop_id uuid;
  stable_key uuid;
  sequence_value integer := 0;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.routes.manage')) then
    raise insufficient_privilege using message = 'Patrol Route Management permission is required.';
  end if;

  resolved_route_id := nullif(target_route ->> 'id', '')::uuid;
  route_code := lower(btrim(coalesce(target_route ->> 'code', '')));
  route_name := btrim(coalesce(target_route ->> 'name', ''));
  route_status := coalesce(nullif(target_route ->> 'status', ''), 'draft');
  route_time_zone := coalesce(nullif(target_route ->> 'timeZone', ''), 'America/Denver');
  if route_code !~ '^[a-z0-9][a-z0-9-]{1,62}$' or route_name = '' then
    raise exception using errcode = '22023', message = 'Route code and name are required.';
  end if;
  if route_status not in ('draft', 'active', 'paused', 'archived') then
    raise exception using errcode = '22023', message = 'Choose a valid route status.';
  end if;
  if route_time_zone not in ('America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles') then
    raise exception using errcode = '22023', message = 'Choose a supported continental U.S. time zone.';
  end if;
  if jsonb_array_length(coalesce(target_route -> 'stops', '[]'::jsonb)) = 0 then
    raise exception using errcode = '22023', message = 'Add at least one route stop.';
  end if;

  if resolved_route_id is null then
    resolved_route_id := gen_random_uuid();
    insert into public.patrol_routes(id, code, name, requires_armed, status, time_zone, created_by, updated_by)
    values (resolved_route_id, route_code, route_name, coalesce((target_route ->> 'requiresArmed')::boolean, false), route_status, route_time_zone, actor_id, actor_id);
    next_version := 1;
  else
    perform 1 from public.patrol_routes where id = resolved_route_id for update;
    if not found then raise exception using errcode = 'P0002', message = 'Patrol route was not found.'; end if;
    select coalesce(max(route_version.version_number), 0) + 1
    into next_version
    from public.patrol_route_versions route_version
    where route_version.route_id = resolved_route_id;
    update public.patrol_routes
    set code = route_code,
        name = route_name,
        requires_armed = coalesce((target_route ->> 'requiresArmed')::boolean, false),
        status = route_status,
        time_zone = route_time_zone,
        updated_by = actor_id,
        updated_at = now()
    where id = resolved_route_id;
  end if;

  insert into public.patrol_route_versions(id, route_id, version_number, effective_from, effective_through, change_reason, created_by)
  values (
    version_id,
    resolved_route_id,
    next_version,
    nullif(target_route ->> 'effectiveFrom', '')::date,
    nullif(target_route ->> 'effectiveThrough', '')::date,
    btrim(coalesce(nullif(target_route ->> 'changeReason', ''), 'Initial route configuration')),
    actor_id
  );

  for stop_payload in select value from jsonb_array_elements(target_route -> 'stops') loop
    sequence_value := sequence_value + 1;
    stop_id := gen_random_uuid();
    stable_key := coalesce(nullif(stop_payload ->> 'stableKey', '')::uuid, gen_random_uuid());
    insert into public.patrol_route_stops(
      id, route_version_id, stable_key, sequence_number, location_label, site_id, post_id,
      address_line_1, city, region, postal_code, latitude, longitude, geofence_radius_meters,
      instructions, allow_photos, allow_videos, require_evidence, evidence_instructions,
      standard_video_limit_seconds, incident_video_limit_seconds
    ) values (
      stop_id, version_id, stable_key, sequence_value, btrim(coalesce(stop_payload ->> 'locationLabel', '')),
      nullif(stop_payload ->> 'siteId', '')::uuid, nullif(stop_payload ->> 'postId', '')::uuid,
      nullif(btrim(coalesce(stop_payload ->> 'addressLine1', '')), ''), nullif(btrim(coalesce(stop_payload ->> 'city', '')), ''),
      nullif(btrim(coalesce(stop_payload ->> 'region', '')), ''), nullif(btrim(coalesce(stop_payload ->> 'postalCode', '')), ''),
      nullif(stop_payload ->> 'latitude', '')::numeric, nullif(stop_payload ->> 'longitude', '')::numeric,
      nullif(stop_payload ->> 'geofenceRadiusMeters', '')::integer,
      nullif(btrim(coalesce(stop_payload ->> 'instructions', '')), ''),
      coalesce((stop_payload ->> 'allowPhotos')::boolean, true), coalesce((stop_payload ->> 'allowVideos')::boolean, true),
      coalesce((stop_payload ->> 'requireEvidence')::boolean, false), nullif(btrim(coalesce(stop_payload ->> 'evidenceInstructions', '')), ''),
      coalesce(nullif(stop_payload ->> 'standardVideoLimitSeconds', '')::integer, 180),
      coalesce(nullif(stop_payload ->> 'incidentVideoLimitSeconds', '')::integer, 900)
    );
    if btrim(coalesce(stop_payload ->> 'locationLabel', '')) = '' then
      raise exception using errcode = '22023', message = 'Every patrol stop needs a location name.';
    end if;

    for requirement_payload in select value from jsonb_array_elements(coalesce(stop_payload -> 'requirements', '[]'::jsonb)) loop
      insert into public.patrol_stop_requirements(
        stop_id, day_of_week, requirement_label, required_hits, status, window_start, window_end,
        minimum_spacing_minutes, sequence_required
      ) values (
        stop_id,
        (requirement_payload ->> 'dayOfWeek')::smallint,
        btrim(coalesce(nullif(requirement_payload ->> 'label', ''), 'Night patrol')),
        (requirement_payload ->> 'requiredHits')::integer,
        coalesce(nullif(requirement_payload ->> 'status', ''), 'active'),
        nullif(requirement_payload ->> 'windowStart', '')::time,
        nullif(requirement_payload ->> 'windowEnd', '')::time,
        nullif(requirement_payload ->> 'minimumSpacingMinutes', '')::integer,
        coalesce((requirement_payload ->> 'sequenceRequired')::boolean, false)
      );
    end loop;
  end loop;

  update public.patrol_routes set current_version_id = version_id, updated_at = now() where id = resolved_route_id;
  insert into private.audit_events(auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record)
  values ((select auth.uid()), actor_id, 'public', 'patrol_routes', case when next_version = 1 then 'insert' else 'version' end, resolved_route_id::text,
    jsonb_build_object('routeId', resolved_route_id, 'versionId', version_id, 'versionNumber', next_version, 'status', route_status, 'changeReason', target_route ->> 'changeReason'));
  return resolved_route_id;
end
$$;

revoke all on function public.save_patrol_route(jsonb) from public, anon;
grant execute on function public.save_patrol_route(jsonb) to authenticated;

comment on function public.save_patrol_route(jsonb) is
  'Creates or versions a patrol route. The local route identifier has a distinct name so route and stop edits persist without PL/pgSQL name ambiguity.';

commit;
