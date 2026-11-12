begin read only;
set local statement_timeout='5s';
set local lock_timeout='1s';
do $postflight$
declare okay boolean;
begin
  select pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='s' and p.proconfig=array['search_path=""']::text[]
    and has_function_privilege('authenticated',p.oid,'execute')
    and not has_function_privilege('anon',p.oid,'execute')
    and not has_function_privilege('service_role',p.oid,'execute')
    into okay from pg_proc p where p.oid=to_regprocedure('public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid)');
  if okay is distinct from true then raise exception 'Time-off history reader security verification failed.';end if;
  select pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.provolatile='s' and p.proconfig=array['search_path=""']::text[]
    and not has_function_privilege('authenticated',p.oid,'execute')
    and not has_function_privilege('anon',p.oid,'execute')
    and not has_function_privilege('service_role',p.oid,'execute')
    into okay from pg_proc p where p.oid=to_regprocedure('private.time_off_history_action_context_v1(uuid,uuid,timestamptz)');
  if okay is distinct from true then raise exception 'Time-off historical context helper is not private.';end if;
  if md5(pg_get_functiondef('public.get_request_center_payload_v3()'::regprocedure))<>'e329f3d32cc303c089744ed74688ad63'
    or md5(pg_get_functiondef('public.get_request_center_payload_v2()'::regprocedure))<>'f5cbb87f301b6a6ed690d52b3354d5ef'
    or md5(pg_get_functiondef('private.time_off_cancellation_context(uuid,uuid,timestamptz)'::regprocedure))<>'74401d5c41d0b6d6e3dcd27675c92784' then
    raise exception 'A preserved time-off reader or mutation-context dependency changed.';
  end if;
end $postflight$;
select md5(pg_get_functiondef('public.get_time_off_request_page_v1(text,text,text,integer,jsonb,uuid)'::regprocedure)) as definition_fingerprint;
rollback;
