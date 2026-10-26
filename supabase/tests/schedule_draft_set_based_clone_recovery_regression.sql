-- Read-only recovery rehearsal assertions for the partial-apply path:
-- 141835 committed, 142017 committed, 151000 failed transactionally, then
-- recovery/20261026142017_schedule_draft_set_based_clone.sql was applied.

begin;

set local statement_timeout = '7s';

do $schedule_set_based_clone_recovery_regression$
declare
  ensure_function pg_catalog.pg_proc%rowtype;
  normalize_function pg_catalog.pg_proc%rowtype;
  payload_function pg_catalog.pg_proc%rowtype;
  index_is_valid boolean;
begin
  select * into strict ensure_function
  from pg_catalog.pg_proc
  where oid = 'public.ensure_schedule_draft(date)'::regprocedure;

  select * into strict normalize_function
  from pg_catalog.pg_proc
  where oid = 'private.normalize_schedule_duplicate_shift_blocks(uuid)'::regprocedure;

  select * into strict payload_function
  from pg_catalog.pg_proc
  where oid = 'public.get_weekly_schedule_payload(date)'::regprocedure;

  select index_record.indisvalid and index_record.indisready
  into index_is_valid
  from pg_catalog.pg_index index_record
  where index_record.indexrelid = to_regclass(
    'public.schedule_assignment_overrides_shift_employee_created_idx'
  );

  if not coalesce(index_is_valid, false) then
    raise check_violation using message = 'The independent 141835 online index was lost or invalidated by the 142017 recovery.';
  end if;

  if md5(pg_get_functiondef(ensure_function.oid)) <> 'b14f552161e0a3df53604bfd9067838c'
     or md5(pg_get_functiondef(normalize_function.oid)) <> 'df3b5a57e81dcb7f426a45c8a7f0e3f6'
     or pg_get_userbyid(ensure_function.proowner) <> 'postgres'
     or pg_get_userbyid(normalize_function.proowner) <> 'postgres'
     or pg_get_userbyid(payload_function.proowner) <> 'postgres'
     or ensure_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or normalize_function.proacl::text is distinct from '{postgres=X/postgres}'
     or payload_function.proacl::text is distinct from '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     or ensure_function.proconfig is distinct from array['search_path=""']::text[]
     or normalize_function.proconfig is distinct from array['search_path=""']::text[]
     or payload_function.proconfig is distinct from array['search_path=public, private']::text[]
     or not ensure_function.prosecdef
     or not normalize_function.prosecdef
     or not payload_function.prosecdef
     or ensure_function.provolatile <> 'v'
     or normalize_function.provolatile <> 'v'
     or payload_function.provolatile <> 's' then
    raise check_violation using message = 'The 142017 recovery did not restore the exact production functions, ACLs, or security attributes.';
  end if;

  if to_regprocedure('public.scheduler_materialize_and_update_shift_v1(uuid,text,date,time without time zone,time without time zone,integer,boolean,boolean,text,text,uuid,text,text,text,text,text)') is not null
     or to_regprocedure('private.materialize_schedule_draft_revision(date)') is not null
     or to_regprocedure('public.get_weekly_schedule_payload_unversioned_20261026(date)') is not null
     or to_regprocedure('private.add_schedule_shift_version_tokens(jsonb)') is not null
     or to_regprocedure('private.schedule_shift_version_token(uuid,integer,public.schedule_status,timestamp with time zone,uuid,timestamp with time zone)') is not null
     or to_regclass('private.schedule_shift_revision_links') is not null then
    raise check_violation using message = 'The failed 151000 transaction left copy-on-write objects behind.';
  end if;
end
$schedule_set_based_clone_recovery_regression$;

rollback;

select 'schedule_draft_set_based_clone_recovery_regression: PASS' as result;
