-- INACTIVE candidate. No production audit history is deleted or rewritten.
-- Activate only after exact release-batch review; ordinary bulk migration push remains blocked.
-- Forward recovery restores the exact original writer, preserving existing audit history.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
do $repair$
declare
  function_identity constant regprocedure := 'private.write_audit_event()'::regprocedure;
  prior_definition text;
  new_definition text;
  prior_owner oid;
  prior_acl aclitem[];
  prior_configuration text[];
  prior_definer boolean;
  old_marker constant text := $old$  -- Only a changed timestamp on public.shifts is non-material. The complete
  -- remaining row comparison includes current and future business columns.
  if tg_op = 'UPDATE' and tg_table_schema = 'public' and tg_table_name = 'shifts'
    and (before_record ? 'updated_at') and (after_record ? 'updated_at')
    and (before_record->'updated_at') is distinct from (after_record->'updated_at')
    and (before_record - 'updated_at') = (after_record - 'updated_at') then
    return new;
  end if;

  insert into private.audit_events ($old$;
  new_marker constant text := $new$  insert into private.audit_events ($new$;
begin
  select pg_get_functiondef(p.oid),p.proowner,p.proacl,p.proconfig,p.prosecdef
  into strict prior_definition,prior_owner,prior_acl,prior_configuration,prior_definer
  from pg_proc p where p.oid=function_identity::oid;
  if md5(prior_definition) <> '0144a3e9b68e95d5abc10d9ba9b377aa'
    or pg_get_userbyid(prior_owner) <> 'postgres'
    or prior_acl::text is distinct from '{postgres=X/postgres,service_role=X/postgres}'
    or prior_configuration is distinct from array['search_path=""']::text[]
    or not prior_definer then
    raise exception 'The exact reviewed audit-writer or security baseline differs; candidate refused.';
  end if;
  if (select md5(string_agg(pg_get_triggerdef(oid)||':'||tgenabled::text,E'\n' order by pg_get_triggerdef(oid) collate "C")) from pg_trigger where tgfoid='private.write_audit_event()'::regprocedure and not tgisinternal) is distinct from 'd83c5b5802cace28e445ca648502f500'
    or (select count(*) from pg_trigger where tgfoid=function_identity::oid and not tgisinternal) <> 104
    or (select count(*) from pg_trigger t where t.tgfoid=function_identity::oid
      and t.tgrelid='public.shifts'::regclass and t.tgtype=29 and t.tgenabled='O') <> 1 then
    raise exception 'The exact reviewed 104-trigger attachment matrix differs; candidate refused.';
  end if;
  if (length(prior_definition)-length(replace(prior_definition,old_marker,''))) <> length(old_marker) then
    raise exception 'The reviewed replacement marker is missing or duplicated.';
  end if;
  new_definition := replace(prior_definition,old_marker,new_marker);
  if md5(new_definition) <> 'b71cc8d34713424231da43820bc94c1e' then raise exception 'The replacement fingerprint differs.'; end if;
  execute new_definition;
  if pg_get_functiondef(function_identity::oid) is distinct from new_definition
    or exists(select 1 from pg_proc p where p.oid=function_identity::oid and (
      p.proowner is distinct from prior_owner or p.proacl is distinct from prior_acl
      or p.proconfig is distinct from prior_configuration or p.prosecdef is distinct from prior_definer
    )) then
    raise exception 'The replacement or security preservation check failed.';
  end if;
end;
$repair$;
commit;
