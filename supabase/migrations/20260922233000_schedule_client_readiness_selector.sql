begin;

create or replace function public.get_schedule_client_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.current_employee_id() is null or not (
    private.can_manage_schedule_drafts()
    or public.has_effective_permission('scheduler.view')
  ) then
    raise insufficient_privilege using message = 'Schedule access is required to view client options.';
  end if;

  return (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', client.id,
    'client_number', client.client_number,
    'name', client.display_name,
    'site_ids', coalesce((
      select jsonb_agg(site.id order by site.name, site.id)
      from public.sites site
      where site.client_id = client.id and site.active
    ), '[]'::jsonb),
    'active_post_count', (
      select count(*) from public.posts post
      join public.sites site on site.id = post.site_id
      where site.client_id = client.id and site.active and post.active
    )
  ) order by client.display_name, client.id), '[]'::jsonb)
  from (
    select id, client_number, display_name
    from public.clients
    where status = 'active' and archived_at is null
    order by display_name, id
    limit 500
  ) client
  );
end;
$$;

revoke all on function public.get_schedule_client_options() from public, anon, authenticated;
grant execute on function public.get_schedule_client_options() to authenticated;

commit;
