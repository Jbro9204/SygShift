begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  admin_auth_user_id uuid;
  sample_site public.sites%rowtype;
  invalid_message text;
  client_constraint_definition text;
  site_constraint_definition text;
begin
  select account.auth_user_id
  into admin_auth_user_id
  from private.employee_accounts account
  join public.employees employee on employee.id = account.employee_id
  where account.disabled_at is null
    and employee.status = 'active'
    and employee.role = 'admin'
  order by employee.created_at
  limit 1;

  if admin_auth_user_id is null then
    raise exception 'An active Admin account is required for the Site time-zone regression.';
  end if;

  select site.*
  into sample_site
  from public.sites site
  where site.client_id is not null
  order by site.id
  limit 1;

  if sample_site.id is null then
    raise exception 'A linked Site is required for the Site time-zone regression.';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', admin_auth_user_id,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  if not has_function_privilege(
    'authenticated',
    'public.update_client_site_location(uuid,uuid,text,text,text,text,text,text,numeric,numeric,integer,text)',
    'EXECUTE'
  ) then
    raise exception 'Authorized Client File users cannot execute the Site location boundary.';
  end if;

  if has_function_privilege(
    'anon',
    'public.update_client_site_location(uuid,uuid,text,text,text,text,text,text,numeric,numeric,integer,text)',
    'EXECUTE'
  ) then
    raise exception 'Anonymous users can execute the protected Site location boundary.';
  end if;

  begin
    perform public.update_client_site_location(
      target_site_id => sample_site.id,
      target_client_id => sample_site.client_id,
      target_address_line_1 => sample_site.address_line_1,
      target_address_line_2 => sample_site.address_line_2,
      target_city => sample_site.city,
      target_region => sample_site.region,
      target_postal_code => sample_site.postal_code,
      target_time_zone => 'UTC',
      target_latitude => sample_site.latitude,
      target_longitude => sample_site.longitude,
      target_geofence_radius_meters => sample_site.geofence_radius_meters,
      target_reason => 'Regression verifies invalid zone denial.'
    );
    raise exception 'The Site location boundary accepted an unsupported time zone.';
  exception
    when check_violation then
      get stacked diagnostics invalid_message = message_text;
      if invalid_message <> 'Choose Eastern, Central, Mountain, Arizona, or Pacific Time.' then
        raise exception 'Unexpected unsupported Site time-zone denial: %', invalid_message;
      end if;
  end;

  perform public.update_client_site_location(
    target_site_id => sample_site.id,
    target_client_id => sample_site.client_id,
    target_address_line_1 => sample_site.address_line_1,
    target_address_line_2 => sample_site.address_line_2,
    target_city => sample_site.city,
    target_region => sample_site.region,
    target_postal_code => sample_site.postal_code,
    target_time_zone => 'America/Phoenix',
    target_latitude => sample_site.latitude,
    target_longitude => sample_site.longitude,
    target_geofence_radius_meters => sample_site.geofence_radius_meters,
    target_reason => 'Regression verifies Arizona Site time.'
  );

  if not exists (
    select 1
    from public.sites site
    where site.id = sample_site.id
      and site.time_zone = 'America/Phoenix'
  ) then
    raise exception 'The Site location boundary did not retain Arizona Time.';
  end if;

  if not exists (
    select 1
    from private.audit_events event
    where event.table_name = 'sites'
      and event.row_id = sample_site.id::text
      and event.operation = 'CLIENT_SITE_LOCATION_UPDATED'
      and event.new_record ->> 'timeZone' = 'America/Phoenix'
  ) then
    raise exception 'The Site time-zone change was not included in the audit evidence.';
  end if;

  update public.clients
  set time_zone = 'America/Phoenix'
  where id = sample_site.client_id;

  if not exists (
    select 1
    from public.clients client
    where client.id = sample_site.client_id
      and client.time_zone = 'America/Phoenix'
  ) then
    raise exception 'The Client constraint did not accept Arizona Time.';
  end if;

  begin
    update public.sites
    set time_zone = 'UTC'
    where id = sample_site.id;
    raise exception 'The Site table accepted an unsupported time zone.';
  exception
    when check_violation then null;
  end;

  begin
    update public.clients
    set time_zone = 'UTC'
    where id = sample_site.client_id;
    raise exception 'The Client table accepted an unsupported time zone.';
  exception
    when check_violation then null;
  end;

  select pg_get_constraintdef(constraint_record.oid, true)
  into client_constraint_definition
  from pg_constraint constraint_record
  where constraint_record.conrelid = 'public.clients'::regclass
    and constraint_record.conname = 'clients_time_zone_check';

  select pg_get_constraintdef(constraint_record.oid, true)
  into site_constraint_definition
  from pg_constraint constraint_record
  where constraint_record.conrelid = 'public.sites'::regclass
    and constraint_record.conname = 'sites_supported_us_time_zone';

  if client_constraint_definition is null
    or site_constraint_definition is null
    or position('America/Phoenix' in client_constraint_definition) = 0
    or position('America/Phoenix' in site_constraint_definition) = 0
  then
    raise exception 'Client and Site constraints do not share the complete supported time-zone catalog.';
  end if;
end
$$;

rollback;
