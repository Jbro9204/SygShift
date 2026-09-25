begin;

-- Client and Site/Post time zones are schedule authorities. Keep every supported
-- value explicit at the database boundary so a typo cannot make schedule entry
-- or daylight-saving validation unusable.
alter table public.clients
  add constraint clients_supported_us_time_zone
  check (
    time_zone = any (
      array[
        'America/New_York'::text,
        'America/Chicago'::text,
        'America/Denver'::text,
        'America/Phoenix'::text,
        'America/Los_Angeles'::text
      ]
    )
  ) not valid;

alter table public.clients
  validate constraint clients_supported_us_time_zone;

alter table public.clients
  drop constraint clients_time_zone_check;

alter table public.clients
  rename constraint clients_supported_us_time_zone to clients_time_zone_check;

alter table public.sites
  add constraint sites_supported_us_time_zone
  check (
    time_zone = any (
      array[
        'America/New_York'::text,
        'America/Chicago'::text,
        'America/Denver'::text,
        'America/Phoenix'::text,
        'America/Los_Angeles'::text
      ]
    )
  ) not valid;

alter table public.sites
  validate constraint sites_supported_us_time_zone;

create or replace function public.update_client_site_location(
  target_site_id uuid,
  target_client_id uuid,
  target_address_line_1 text,
  target_address_line_2 text,
  target_city text,
  target_region text,
  target_postal_code text,
  target_time_zone text,
  target_latitude numeric,
  target_longitude numeric,
  target_geofence_radius_meters integer,
  target_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  normalized_time_zone text := nullif(btrim(coalesce(target_time_zone, '')), '');
begin
  if actor_id is null
    or not private.client_can('clients.manage')
    or not (public.is_admin() or public.has_effective_permission('sites.manage'))
  then
    raise insufficient_privilege using message = 'Client and Site management permissions are required.';
  end if;

  if length(btrim(coalesce(target_reason, ''))) < 5 then
    raise check_violation using message = 'Enter a reason for changing this location.';
  end if;

  if normalized_time_zone is null
    or normalized_time_zone <> all (
      array[
        'America/New_York'::text,
        'America/Chicago'::text,
        'America/Denver'::text,
        'America/Phoenix'::text,
        'America/Los_Angeles'::text
      ]
    )
  then
    raise check_violation using message = 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.';
  end if;

  if num_nonnulls(target_latitude, target_longitude) not in (0, 2) then
    raise check_violation using message = 'Latitude and longitude must be entered together.';
  end if;

  update public.sites
  set client_id = target_client_id,
      address_line_1 = nullif(btrim(coalesce(target_address_line_1, '')), ''),
      address_line_2 = nullif(btrim(coalesce(target_address_line_2, '')), ''),
      city = nullif(btrim(coalesce(target_city, '')), ''),
      region = nullif(upper(btrim(coalesce(target_region, ''))), ''),
      postal_code = nullif(btrim(coalesce(target_postal_code, '')), ''),
      time_zone = normalized_time_zone,
      latitude = target_latitude,
      longitude = target_longitude,
      geofence_radius_meters = target_geofence_radius_meters,
      updated_at = clock_timestamp()
  where id = target_site_id
    and (client_id = target_client_id or client_id is null);

  if not found then
    raise no_data_found using message = 'The linked Site was not found.';
  end if;

  update public.patrol_route_stops
  set client_id = target_client_id,
      address_line_1 = coalesce(nullif(btrim(coalesce(target_address_line_1, '')), ''), address_line_1),
      city = coalesce(nullif(btrim(coalesce(target_city, '')), ''), city),
      region = coalesce(nullif(upper(btrim(coalesce(target_region, ''))), ''), region),
      postal_code = coalesce(nullif(btrim(coalesce(target_postal_code, '')), ''), postal_code),
      latitude = target_latitude,
      longitude = target_longitude,
      geofence_radius_meters = target_geofence_radius_meters
  where site_id = target_site_id;

  insert into private.audit_events (
    auth_user_id,
    employee_id,
    schema_name,
    table_name,
    operation,
    row_id,
    new_record
  )
  values (
    (select auth.uid()),
    actor_id,
    'public',
    'sites',
    'CLIENT_SITE_LOCATION_UPDATED',
    target_site_id::text,
    jsonb_build_object(
      'clientId', target_client_id,
      'reason', btrim(target_reason),
      'timeZone', normalized_time_zone,
      'geofenceConfigured', target_latitude is not null and target_geofence_radius_meters is not null
    )
  );
end
$$;

revoke all on function public.update_client_site_location(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, integer, text
) from public, anon;

grant execute on function public.update_client_site_location(
  uuid, uuid, text, text, text, text, text, text, numeric, numeric, integer, text
) to authenticated, service_role;

commit;
