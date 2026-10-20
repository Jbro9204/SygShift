begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- HELD forward recovery candidate, not part of the ordinary migration queue.
-- Apply only through a newly reviewed forward ledger/release batch. Never
-- remove terminal metadata, reopen rows, reset attempts, or restore old writers.
do $$
declare expected record;
begin
  if (select count(*) from supabase_migrations.schema_migrations
      where version='20261020001825' and name='notification_terminal_state_compatibility') <> 1
    or exists(select 1 from supabase_migrations.schema_migrations where version='20261020001855') then
    raise exception 'The exact notification repair must be installed and the recovery version unapplied.';
  end if;
  for expected in select * from (values
    ('public.get_notification_center()', 'e1e39a69d2eb370bfb91bc488bfad0f7',array['search_path=public, private']::text[],'v'),
    ('public.get_notification_center(text,text,date,date,integer,integer)', '84c182bcf5067bc10b0703e82ff3783e',array['search_path=""']::text[],'s'),
    ('public.get_notification_center_v2(text,text,date,date,integer,integer)', '0bb1de22b06099f004db8976d88fa8f4',array['search_path=""']::text[],'s')
  ) as routines(signature,definition_hash,config,volatility) loop
    if not exists(select 1 from pg_proc procedure where procedure.oid=to_regprocedure(expected.signature)
      and md5(pg_get_functiondef(procedure.oid))=expected.definition_hash
      and pg_get_userbyid(procedure.proowner)='postgres'
      and procedure.proacl::text='{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
      and procedure.proconfig=expected.config and procedure.prosecdef
      and procedure.provolatile::text=expected.volatility and procedure.prorettype='jsonb'::regtype) then
      raise exception 'Notification forward recovery rejected reader drift: %',expected.signature;
    end if;
  end loop;
end;
$$;

-- Keep BOTH old client contracts and every terminal/retry writer unchanged.
-- New clients keep a callable v2 endpoint but temporarily receive the supported
-- coarse legacy statuses/counts and a visible recovery notice. Suppressed
-- and canceled rows remain terminal and authorized retries still create only
-- eligible new generations. Expanded delivery visibility is temporarily lost.
create or replace function public.get_notification_center_v2(
  target_status text default 'all', target_search text default null,
  target_date_from date default null, target_date_through date default null,
  target_page integer default 1, target_page_size integer default 10)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.get_notification_center(target_status,target_search,target_date_from,target_date_through,target_page,target_page_size)
    || jsonb_build_object('deliveryVisibility','legacy');
$$;

notify pgrst,'reload schema';
commit;
