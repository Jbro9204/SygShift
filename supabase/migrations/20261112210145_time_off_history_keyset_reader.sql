begin;
set local lock_timeout='2s';
set local statement_timeout='10s';

-- Add a read model only. The existing center and all approval, withdrawal,
-- cancellation, early-return and scheduling mutations remain unchanged.
do $preflight$
declare item record; metadata_ok boolean;
begin
  for item in select * from (values
    ('public.get_request_center_payload_v3()','e329f3d32cc303c089744ed74688ad63'),
    ('public.get_request_center_payload_v2()','f5cbb87f301b6a6ed690d52b3354d5ef'),
    ('private.time_off_cancellation_context(uuid,uuid,timestamp with time zone)','74401d5c41d0b6d6e3dcd27675c92784'),
    ('private.current_employee_id()','fac2b39045e797012633ea4d1499ae5d'),
    ('public.current_app_role()','91960bb233b09534da26e322b24f750b'),
    ('public.has_effective_permission(text)','9f170426206862a0eaddb4236a574240'),
    ('private.time_off_window(date,date,time without time zone,time without time zone,text)','565adeb7863a8d8f0900a19a8f27a5a1')
  ) expected(signature,fingerprint) loop
    if md5(pg_get_functiondef(to_regprocedure(item.signature))) is distinct from item.fingerprint then
      raise exception 'Time-off read model dependency drift: %',item.signature;
    end if;
    select pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='s' and p.proconfig=array['search_path=""']::text[]
      and not exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.privilege_type='EXECUTE' and a.grantee not in(
        p.proowner,
        case when item.signature like 'public.%' then 'authenticated'::regrole else p.proowner end,
        case when item.signature in('private.current_employee_id()','public.current_app_role()','public.has_effective_permission(text)') then 'service_role'::regrole else p.proowner end))
      into metadata_ok from pg_proc p where p.oid=to_regprocedure(item.signature);
    if metadata_ok is distinct from true then raise exception 'Time-off read model dependency security drift: %',item.signature;end if;
  end loop;
end $preflight$;

-- A malformed historical interval must not hide the rest of the register.
-- No substitute eligibility is invented; protected mutations still recheck
-- the unchanged canonical context. Infrastructure/authorization errors escape.
create function private.time_off_history_action_context_v1(target_request_id uuid,target_viewer_id uuid,target_evaluated_at timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare context jsonb;
begin
  context:=private.time_off_cancellation_context(target_request_id,target_viewer_id,target_evaluated_at);
  if context is null then return jsonb_build_object('available',false);end if;
  return jsonb_build_object('available',true,'context',context);
exception when check_violation or invalid_parameter_value or null_value_not_allowed then
  return jsonb_build_object('available',false);
end $$;
revoke all on function private.time_off_history_action_context_v1(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function public.get_time_off_request_page_v1(
  target_search text default null,
  target_status text default 'all',
  target_bucket text default 'all',
  target_limit integer default 20,
  target_cursor jsonb default null,
  target_request_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  viewer_id uuid:=public.current_employee_id();
  can_manage boolean:=coalesce(public.has_effective_permission('requests.manage'),false);
  viewer_zone text;
  search_text text:=lower(btrim(coalesce(target_search,'')));
  status_text text:=coalesce(target_status,'all');
  bucket_text text:=coalesce(target_bucket,'all');
  page_limit integer:=coalesce(target_limit,20);
  cutoff timestamptz:=statement_timestamp();
  last_at timestamptz;
  last_id uuid;
  scope_hash text;
  cursor_keys text[];
  cursor_json jsonb;
  local_today date;
  result jsonb;
begin
  if viewer_id is null then raise insufficient_privilege using message='An active SygShift account is required to view time-off requests.';end if;
  select time_zone into viewer_zone from public.employees where id=viewer_id;
  if viewer_zone is null then raise insufficient_privilege using message='The current employee time zone could not be verified.';end if;
  if char_length(search_text)>200 or page_limit not between 1 and 50
    or status_text not in('all','pending','approved','declined','withdrawn','canceled','ended_early')
    or bucket_text not in('all','pending','history','upcoming','past') then
    raise invalid_parameter_value using message='Choose valid time-off search, status and page options.';
  end if;
  if target_request_id is not null and (search_text<>'' or status_text<>'all' or bucket_text<>'all' or target_cursor is not null) then
    raise invalid_parameter_value using message='An exact time-off lookup cannot be combined with list filters.';
  end if;
  scope_hash:=encode(sha256(convert_to(jsonb_build_object('version',1,'employeeId',viewer_id,'canManage',can_manage,
    'timeZone',viewer_zone,'search',search_text,'status',status_text,'bucket',bucket_text,'limit',page_limit,'requestId',target_request_id)::text,'UTF8')),'hex');
  if target_cursor is not null then
    if jsonb_typeof(target_cursor)<>'object' or octet_length(target_cursor::text)>2048 then raise invalid_parameter_value using message='Invalid time-off page cursor.';end if;
    select array_agg(key order by key) into cursor_keys from jsonb_object_keys(target_cursor) key;
    if cursor_keys is distinct from array['asOf','createdAt','id','scope','version']::text[]
      or target_cursor->'version' is distinct from '1'::jsonb
      or target_cursor->>'scope' is distinct from scope_hash
      or jsonb_typeof(target_cursor->'asOf')<>'string'
      or (target_cursor->>'asOf')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
      or not ((target_cursor->'createdAt'='null'::jsonb and target_cursor->'id'='null'::jsonb)
        or (jsonb_typeof(target_cursor->'createdAt')='string' and jsonb_typeof(target_cursor->'id')='string'
          and (target_cursor->>'createdAt')~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
          and (target_cursor->>'id')~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) then
      raise invalid_parameter_value using message='This time-off page cursor does not match the current view.';
    end if;
    begin
      cutoff:=(target_cursor->>'asOf')::timestamptz;
      last_at:=(target_cursor->>'createdAt')::timestamptz;
      last_id:=(target_cursor->>'id')::uuid;
    exception when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
      raise invalid_parameter_value using message='Invalid time-off page boundary.';
    end;
    if cutoff>statement_timestamp() or (last_at is not null and last_at>cutoff) then raise invalid_parameter_value using message='Invalid future time-off page boundary.';end if;
  end if;
  local_today:=(cutoff at time zone viewer_zone)::date;
  cursor_json:=jsonb_build_object('version',1,'scope',scope_hash,'asOf',to_char(cutoff at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'createdAt',case when last_at is null then null else to_char(last_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,'id',last_id);

  with cohort as materialized (
    select r.id,r.created_at,r.ends_on,r.status::text as status,
      case when early.request_id is not null then 'ended_early' else r.status::text end as display_status,
      early.request_id is null and r.ends_on>=local_today and r.status in('pending','approved') as upcoming
    from public.time_off_requests r join public.employees e on e.id=r.employee_id
    left join private.time_off_request_early_returns early on early.request_id=r.id
    left join private.time_off_request_cancellations cancel on cancel.request_id=r.id
    where (r.employee_id=viewer_id or can_manage) and r.created_at<=cutoff
      and (target_request_id is null or r.id=target_request_id)
      and (search_text='' or strpos(lower(concat_ws(' ',coalesce(nullif(e.preferred_name,''),e.first_name),e.last_name,e.username,e.employee_number,
        case r.request_type when 'paid_vacation' then 'Paid vacation' when 'sick_time' then 'Sick time' when 'unpaid_time_off' then 'Unpaid time off' else 'Unspecified time off' end,
        r.reason,r.decision_note,early.note,cancel.note,r.starts_on::text,r.ends_on::text,to_char(r.starts_on,'MM/DD/YYYY'),to_char(r.ends_on,'MM/DD/YYYY'))),search_text)>0)
  ), counts as (
    select jsonb_build_object('all',count(*),'pending',count(*) filter(where display_status='pending'),
      'approved',count(*) filter(where display_status='approved'),'declined',count(*) filter(where display_status='declined'),
      'withdrawn',count(*) filter(where display_status='withdrawn'),'canceled',count(*) filter(where display_status='canceled'),
      'endedEarly',count(*) filter(where display_status='ended_early'),
      'closed',count(*) filter(where display_status in('declined','withdrawn','canceled','ended_early')),
      'pastOrClosed',count(*) filter(where ends_on<local_today or display_status in('declined','withdrawn','canceled','ended_early')),
      'upcoming',count(*) filter(where upcoming),'history',count(*) filter(where status<>'pending')) as value from cohort
  ), filtered as materialized (
    select * from cohort where (status_text='all' or display_status=status_text)
      and (bucket_text='all' or (bucket_text='pending' and status='pending') or (bucket_text='history' and status<>'pending')
        or (bucket_text='upcoming' and upcoming) or (bucket_text='past' and not upcoming))
  ), page_refs as materialized (
    select id,created_at from filtered where last_at is null or (created_at,id)<(last_at,last_id)
    order by created_at desc,id desc limit page_limit+1
  ), page_rows as materialized (
    select id,created_at from page_refs order by created_at desc,id desc limit page_limit
  ), action_contexts as materialized (
    select p.id,private.time_off_history_action_context_v1(p.id,viewer_id,statement_timestamp()) as value from page_rows p
  ), items as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',r.id,'employeeId',r.employee_id,'employeeNumber',e.employee_number,
      'employeeName',coalesce(nullif(e.preferred_name,''),e.first_name)||' '||e.last_name,
      'requestType',r.request_type,'employmentType',r.employment_type_snapshot,'payTreatment',r.pay_treatment,
      'startsOn',r.starts_on,'endsOn',r.ends_on,'partialDayStart',r.partial_day_start,'partialDayEnd',r.partial_day_end,
      'returnOn',r.return_on,'requestedMinutes',r.requested_minutes,
      'affectedShiftCount',case when jsonb_typeof(r.affected_shifts_snapshot)='array' then jsonb_array_length(r.affected_shifts_snapshot) else 0 end,
      'affectedShifts',case when jsonb_typeof(r.affected_shifts_snapshot)='array' then r.affected_shifts_snapshot else '[]'::jsonb end,
      'reason',r.reason,'status',r.status,'decisionNote',r.decision_note,'decidedAt',r.decided_at,
      'decidedByName',case when decider.id is null then null else coalesce(nullif(decider.preferred_name,''),decider.first_name)||' '||decider.last_name end,
      'createdAt',r.created_at,'updatedAt',r.updated_at,
      'cancellation',case when cancel.request_id is null then null else jsonb_build_object('canceledAt',cancel.canceled_at,
        'canceledByName',coalesce(nullif(canceler.preferred_name,''),canceler.first_name)||' '||canceler.last_name,'note',cancel.note) end,
      'earlyReturn',case when early.request_id is null then null else jsonb_build_object('endedAt',early.ended_at,'recordedAt',early.recorded_at,
        'endedByName',coalesce(nullif(returner.preferred_name,''),returner.first_name)||' '||returner.last_name,'note',early.note,'timeZone',early.time_zone) end
    )||case when (context.value->>'available')::boolean then jsonb_build_object('cancellationContext',context.value->'context')
      else jsonb_build_object('cancellationContextUnavailable',true,'cancellationContextIssue','Action availability could not be verified for this historical request. Ask HR to review it before making changes.') end
      order by p.created_at desc,p.id desc),'[]'::jsonb) as value
    from page_rows p join public.time_off_requests r on r.id=p.id join public.employees e on e.id=r.employee_id
    join action_contexts context on context.id=p.id
    left join public.employees decider on decider.id=r.decided_by
    left join private.time_off_request_cancellations cancel on cancel.request_id=r.id left join public.employees canceler on canceler.id=cancel.canceled_by
    left join private.time_off_request_early_returns early on early.request_id=r.id left join public.employees returner on returner.id=early.ended_by
  )
  select jsonb_build_object('employeeId',viewer_id,'employeeTimeZone',viewer_zone,'permissions',jsonb_build_object('canManage',can_manage),
    'items',items.value,'counts',counts.value,'filters',jsonb_build_object('search',search_text,'status',status_text,'bucket',bucket_text,'requestId',target_request_id),
    'page',jsonb_build_object('limit',page_limit,'total',(select count(*) from filtered),'currentCursor',cursor_json,
      'asOf',cursor_json->'asOf','hasMore',(select count(*)>page_limit from page_refs),
      'nextCursor',case when (select count(*)>page_limit from page_refs) then
        (select jsonb_build_object('version',1,'scope',scope_hash,'asOf',cursor_json->'asOf',
          'createdAt',to_char(p.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',p.id)
          from page_rows p order by p.created_at,p.id limit 1) else null end))
    into result from items cross join counts;
  return result;
end $$;
revoke all on function public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid) from public,anon,service_role;
grant execute on function public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid) to authenticated;
comment on function public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid) is 'Bounded authenticated time-off history read. Original requests and effective early-return/cancellation facts are preserved. Counts precede status and bucket filtering; asOf excludes new records but is not a repeatable-read snapshot.';
notify pgrst,'reload schema';
commit;
