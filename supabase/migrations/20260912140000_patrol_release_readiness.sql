begin;

create temporary table patrol_readiness_preservation_baseline on commit drop as
select
  (select count(*) from public.clients) as client_count,
  (select count(*) from public.sites) as site_count,
  (select count(*) from public.patrol_routes) as route_count,
  (select count(*) from public.patrol_route_versions) as route_version_count,
  (select count(*) from public.patrol_assignments) as assignment_count,
  (select count(*) from public.patrol_hits) as hit_count,
  (select count(*) from public.patrol_hit_evidence) as evidence_count;

create or replace function public.get_patrol_release_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  active_site_count integer;
  missing_client_count integer;
  missing_address_count integer;
  active_route_count integer;
  assignment_count integer;
  photo_count integer;
  video_count integer;
  longest_video_seconds integer;
  authorization_integrity_ready boolean;
begin
  if actor_id is null or not (private.patrol_can_manage() or public.has_effective_permission('patrol.routes.manage')) then
    raise insufficient_privilege using message = 'Patrol Route Management permission is required.';
  end if;

  select count(*), count(*) filter (where site.client_id is null), count(*) filter (where nullif(btrim(coalesce(site.address_line_1, '')), '') is null)
  into active_site_count, missing_client_count, missing_address_count
  from public.sites site where site.active;
  select count(*) into active_route_count from public.patrol_routes route where route.status = 'active';
  select count(*) into assignment_count from public.patrol_assignments assignment where assignment.status = 'active';
  select
    count(*) filter (where evidence.media_kind = 'photo' and evidence.status = 'stored'),
    count(*) filter (where evidence.media_kind = 'video' and evidence.status = 'stored'),
    max(evidence.duration_seconds) filter (where evidence.media_kind = 'video' and evidence.status = 'stored')
  into photo_count, video_count, longest_video_seconds
  from public.patrol_hit_evidence evidence;

  select not exists(
    select 1
    from public.patrol_route_stops stop
    join public.sites site on site.id = stop.site_id
    where stop.client_id is distinct from site.client_id
  ) and not exists(
    select 1
    from public.patrol_hits hit
    join public.patrol_route_stops stop on stop.id = hit.stop_id
    where hit.client_id is distinct from stop.client_id
  ) into authorization_integrity_ready;

  return jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'readyForBroadRelease', missing_client_count = 0 and missing_address_count = 0 and active_route_count > 0 and assignment_count > 0 and photo_count > 0 and video_count > 0 and coalesce(longest_video_seconds, 0) >= 180 and authorization_integrity_ready,
    'summary', jsonb_build_object(
      'activeSites', active_site_count,
      'sitesMissingClient', missing_client_count,
      'sitesMissingAddress', missing_address_count,
      'activeRoutes', active_route_count,
      'activeAssignments', assignment_count,
      'storedPhotos', photo_count,
      'storedVideos', video_count,
      'longestVideoSeconds', longest_video_seconds
    ),
    'checks', jsonb_build_array(
      jsonb_build_object('code','site_ownership','label','Every active site is linked to the correct client','state',case when missing_client_count=0 then 'ready' else 'blocked' end,'detail',case when missing_client_count=0 then 'All active sites have a canonical client relationship.' else format('%s active site(s) still need a verified client link.',missing_client_count) end,'action','Open Client Files and verify each site relationship.'),
      jsonb_build_object('code','site_addresses','label','Every active site has a verified address','state',case when missing_address_count=0 then 'ready' else 'blocked' end,'detail',case when missing_address_count=0 then 'All active site addresses are present.' else format('%s active site(s) still need a verified address.',missing_address_count) end,'action','Open Client Files, select the client, and edit the authoritative site location.'),
      jsonb_build_object('code','active_route','label','At least one reviewed route is active','state',case when active_route_count>0 then 'ready' else 'blocked' end,'detail',format('%s active route(s) are currently available.',active_route_count),'action','Keep route work in Draft until addresses, stops, and requirements have been reviewed.'),
      jsonb_build_object('code','field_assignment','label','A controlled field assignment is running','state',case when assignment_count>0 then 'ready' else 'blocked' end,'detail',format('%s active Patrol assignment(s) are currently linked to Schedule.',assignment_count),'action','Connect an approved active route to Joseph’s published test shift.'),
      jsonb_build_object('code','media_validation','label','Photo and long-video evidence are proven','state',case when photo_count>0 and video_count>0 and coalesce(longest_video_seconds,0)>=180 then 'ready' else 'blocked' end,'detail',format('%s photo(s), %s video(s); longest stored video: %s seconds.',photo_count,video_count,coalesce(longest_video_seconds,0)),'action','Complete a test hit with a photo, a normal video, and a video of at least three minutes.'),
      jsonb_build_object('code','authorization_integrity','label','Stored relationships have no cross-client mismatch','state',case when authorization_integrity_ready then 'ready' else 'blocked' end,'detail','Client, site, route-stop, and hit relationships are checked from canonical identifiers.','action','Resolve every mismatch before field activation.')
    ),
    'routes', coalesce((select jsonb_agg(route_stats.payload order by route_stats.route_name) from (
      select route.name route_name, jsonb_build_object(
        'id',route.id,'code',route.code,'name',route.name,'status',route.status,'version',version.version_number,
        'stops',count(stop.id),'missingAddresses',count(*) filter(where stop.id is not null and nullif(btrim(coalesce(stop.address_line_1,'')),'') is null),
        'unlinkedSites',count(*) filter(where stop.id is not null and stop.site_id is null)
      ) payload
      from public.patrol_routes route
      join public.patrol_route_versions version on version.id=route.current_version_id
      left join public.patrol_route_stops stop on stop.route_version_id=version.id
      group by route.id,route.code,route.name,route.status,version.version_number
    ) route_stats), '[]'::jsonb)
  );
end
$$;

revoke all on function public.get_patrol_release_readiness() from public, anon;
grant execute on function public.get_patrol_release_readiness() to authenticated;
comment on function public.get_patrol_release_readiness() is 'Read-only, permission-scoped Patrol field-release checklist derived from canonical client, site, route, assignment, hit, and media records.';

do $$
declare baseline patrol_readiness_preservation_baseline%rowtype;
begin
  select * into strict baseline from patrol_readiness_preservation_baseline;
  if baseline.client_count<>(select count(*) from public.clients)
    or baseline.site_count<>(select count(*) from public.sites)
    or baseline.route_count<>(select count(*) from public.patrol_routes)
    or baseline.route_version_count<>(select count(*) from public.patrol_route_versions)
    or baseline.assignment_count<>(select count(*) from public.patrol_assignments)
    or baseline.hit_count<>(select count(*) from public.patrol_hits)
    or baseline.evidence_count<>(select count(*) from public.patrol_hit_evidence)
  then raise exception 'Patrol readiness migration changed protected operational records.';
  end if;
end
$$;

notify pgrst, 'reload schema';
commit;
