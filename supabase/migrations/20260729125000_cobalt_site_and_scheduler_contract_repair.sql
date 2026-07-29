begin;

-- Cobalt was added as an active operational site after the original workbook promotion.
-- Keep this migration idempotent so production and rebuilds can safely converge.
do $$
declare
  cobalt_site_id uuid;
begin
  select site.id
    into cobalt_site_id
  from public.sites site
  where lower(site.name) = 'cobalt'
     or site.code = 'COB'
  order by case when site.code = 'COB' then 0 else 1 end, site.created_at
  limit 1;

  if cobalt_site_id is null then
    insert into public.sites (
      code,
      name,
      time_zone,
      active
    ) values (
      'COB',
      'Cobalt',
      'America/Denver',
      true
    )
    returning id into cobalt_site_id;
  else
    update public.sites site
    set
      code = coalesce(site.code, 'COB'),
      name = 'Cobalt',
      time_zone = coalesce(nullif(site.time_zone, ''), 'America/Denver'),
      active = true,
      updated_at = clock_timestamp()
    where site.id = cobalt_site_id;
  end if;

  insert into public.posts (
    site_id,
    name,
    requires_armed,
    active
  ) values
    (cobalt_site_id, 'Unarmed coverage', false, true),
    (cobalt_site_id, 'Armed coverage', true, true)
  on conflict (site_id, name) do update
  set
    requires_armed = excluded.requires_armed,
    active = true,
    updated_at = clock_timestamp();
end
$$;

notify pgrst, 'reload schema';

commit;
