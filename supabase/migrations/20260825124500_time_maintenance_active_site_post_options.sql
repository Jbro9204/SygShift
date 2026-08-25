begin;

-- Time Maintenance must offer every active operational Site/Post, even when
-- the selected workday has no schedule occurrence at that location. Scheduled
-- shift choices remain a separate, preferred path because they create a true
-- schedule link; these records provide a canonical audited location for
-- verified work that was not already represented by a shift.
create or replace function public.get_time_maintenance_location_options()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.timekeeping_require_permission('time.manage');
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'postId', post.id,
      'siteId', site.id,
      'siteCode', site.code,
      'siteName', site.name,
      'postName', post.name,
      'timeZone', site.time_zone,
      'requiresArmed', post.requires_armed
    ) order by
      lower(coalesce(site.code, '')),
      lower(site.name),
      lower(post.name),
      post.id
    ), '[]'::jsonb)
    from public.posts post
    join public.sites site on site.id = post.site_id
    where site.active
      and post.active
  );
end
$$;

comment on function public.get_time_maintenance_location_options() is
  'Returns canonical active Site/Post choices to MFA-verified users with time.manage, independently of schedule occurrence dates.';

revoke all on function public.get_time_maintenance_location_options() from public, anon;
grant execute on function public.get_time_maintenance_location_options() to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
