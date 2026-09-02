begin;

create or replace function public.export_client_activity(target_client_id uuid,target_from date default null,target_through date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor_id uuid:=private.current_employee_id(); client_name text; rows jsonb;
begin
  if actor_id is null or not private.client_can('clients.reports.export') then raise insufficient_privilege using message='Client report export permission is required.'; end if;
  select display_name into client_name from public.clients where id=target_client_id and archived_at is null;
  if not found then raise no_data_found using message='Client File was not found.'; end if;
  with activity as (
    select shift.id,'shift'::text kind,shift.starts_at occurred_at,site.name||' · '||post.name title,concat(shift.headcount_required,' required · ',count(assignment.id),' assigned') detail,site.name site_name,post.name post_name
    from public.shifts shift join public.posts post on post.id=shift.post_id join public.sites site on site.id=post.site_id left join public.shift_assignments assignment on assignment.shift_id=shift.id and assignment.status<>'canceled'
    where site.client_id=target_client_id group by shift.id,site.id,site.name,post.id,post.name
    union all
    select shift.id,'shift',shift.starts_at,event.name,concat(shift.headcount_required,' required · ',count(assignment.id),' assigned'),site.name,null::text
    from public.shifts shift join public.events event on event.id=shift.event_id left join public.sites site on site.id=event.site_id left join public.shift_assignments assignment on assignment.shift_id=shift.id and assignment.status<>'canceled'
    where event.client_id=target_client_id group by shift.id,event.id,event.name,site.name
    union all
    select hit.id,'patrol_hit',coalesce(hit.submitted_at,hit.created_at),stop.location_label,concat(initcap(hit.classification),' · ',coalesce(hit.outcome,hit.status),' · ',employee.first_name,' ',employee.last_name),site.name,post.name
    from public.patrol_hits hit join public.patrol_route_stops stop on stop.id=hit.stop_id left join public.sites site on site.id=stop.site_id left join public.posts post on post.id=stop.post_id join public.employees employee on employee.id=hit.submitted_by
    where coalesce(hit.client_id,stop.client_id)=target_client_id and hit.invalidated_at is null
    union all
    select record.id,record.record_type,record.occurred_at,record.title,record.summary,site.name,post.name
    from public.client_service_records record left join public.sites site on site.id=record.site_id left join public.posts post on post.id=record.post_id where record.client_id=target_client_id and record.invalidated_at is null
  ), bounded_activity as (
    select * from activity
    where (target_from is null or occurred_at::date>=target_from)
      and (target_through is null or occurred_at::date<=target_through)
    order by occurred_at desc,id desc
    limit 10000
  )
  select coalesce(jsonb_agg(jsonb_build_object('recordId',id,'type',kind,'occurredAt',occurred_at,'title',title,'detail',detail,'site',site_name,'post',post_name) order by occurred_at desc,id desc),'[]'::jsonb)
  into rows from bounded_activity;
  insert into private.audit_events(auth_user_id,employee_id,schema_name,table_name,operation,row_id,new_record) values((select auth.uid()),actor_id,'public','clients','CLIENT_ACTIVITY_EXPORTED',target_client_id::text,jsonb_build_object('from',target_from,'through',target_through,'rowCount',jsonb_array_length(rows)));
  return jsonb_build_object('clientId',target_client_id,'clientName',client_name,'generatedAt',clock_timestamp(),'rows',rows);
end $$;

revoke all on function public.export_client_activity(uuid,date,date) from public,anon;
grant execute on function public.export_client_activity(uuid,date,date) to authenticated;

commit;
