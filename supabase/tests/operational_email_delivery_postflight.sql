begin read only;
set local statement_timeout='5s';
set local lock_timeout='1s';
do $postflight$
declare signature text; okay boolean;
begin
  foreach signature in array array[
    'public.service_resolve_operational_email_recipients(uuid,text)',
    'public.service_claim_operational_email_recipient(uuid,text,uuid)',
    'public.service_record_operational_email_recipient_result(uuid,text,uuid,uuid,text)',
    'public.service_finalize_operational_email_job(uuid,text)',
    'public.service_defer_operational_email_job(uuid,text)',
    'public.service_claim_guarded_operational_email_batch(text,integer)'
  ] loop
    select pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig=array['search_path=""']::text[]
      and has_function_privilege('service_role',p.oid,'execute')
      and not has_function_privilege('anon',p.oid,'execute')
      and not has_function_privilege('authenticated',p.oid,'execute')
      into okay from pg_proc p where p.oid=to_regprocedure(signature);
    if okay is distinct from true then raise exception 'Operational email postflight failed for %',signature;end if;
  end loop;
  if not exists(select 1 from pg_class where oid='private.operational_email_delivery_ledger'::regclass and relrowsecurity and relforcerowsecurity)
    or has_table_privilege('anon','private.operational_email_delivery_ledger','select,insert,update,delete')
    or has_table_privilege('authenticated','private.operational_email_delivery_ledger','select,insert,update,delete')
    or has_table_privilege('service_role','private.operational_email_delivery_ledger','select,insert,update,delete') then
    raise exception 'Operational email ledger boundary is not private.';
  end if;
  if not exists(select 1 from pg_index where indexrelid='private.operational_email_current_address_idx'::regclass and indisvalid and indisready) then
    raise exception 'Operational email canonical-address index is not ready.';
  end if;
  if (select count(*) from private.operational_email_delivery_control)<>1
    or has_table_privilege('service_role','private.operational_email_delivery_control','select,insert,update,delete')
    or has_table_privilege('authenticated','private.operational_email_delivery_control','select,insert,update,delete') then
    raise exception 'Operational email cutover control is not private or has invalid cardinality.';
  end if;
end
$postflight$;
select p.oid::regprocedure::text as signature,md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in('private','public') and p.proname in(
  'operational_email_job','operational_email_source_member','operational_email_address',
  'service_resolve_operational_email_recipients','service_claim_operational_email_recipient',
  'service_record_operational_email_recipient_result','service_finalize_operational_email_job','service_defer_operational_email_job',
  'operational_email_claim_allowed','service_claim_guarded_operational_email_batch')
order by 1;
-- Counts only: no recipient identities, email addresses or bodies are exposed.
select lane,event,count(*) from private.operational_email_delivery_ledger group by lane,event order by lane,event;
select guarded_enabled,legacy_pause_until,changed_at from private.operational_email_delivery_control;
rollback;
