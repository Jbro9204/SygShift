-- Exact captured before-definitions, guarded against drift from the reviewed repaired state.
-- Forward recovery only; no history rewrite. Body contains no COMMIT.
-- REVIEW CANDIDATE ONLY. Outside active migration history; no deployment authorization.
-- Execute only inside a reviewed transaction. This body contains no COMMIT.
-- Captured production definitions, owners, ACLs, and dependent policy are guarded.
do $guard$
declare
  expected_owner text := 'postgres';
  expected record;
  actual record;
begin
  for expected in select * from (values
('public.accept_vacancy_patrol_recovery(uuid,uuid,uuid,text,uuid)','81e87b762748cd44a35ea691ee78df58',array['postgres=X/postgres','service_role=X/postgres','authenticated=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_availability_workspace(date,date)','2e462f2bdfac4eebe9492d807df2f4b2',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_bible_schedule_preview(date)','8d4afde02e4623b04572db5fe08d94e6',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_effective_permissions()','3431ae84d1ac2367fe2e3b2a2df470c7',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_imported_schedule_preview(date)','20c9dde24dadaa0e5c1cd6fe4616081a',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_licensing_center()','5b44e7733f6cb016aeeeec7a16f0a5a1',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_open_opportunities_payload()','f84f96b4629a193383d99db7c74e434c',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=public, private']::text[]),
    ('public.get_patrol_coverage()','2e58513afd1b853871ce538266dea20a',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=public, private']::text[]),
    ('public.get_schedule_builder_options()','7fd6997fc598c9d5c19eb33a38f4cf9f',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_schedule_staffing_suggestions(uuid)','41b53b202724ba8f0a02ada94411d565',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.get_scheduled_overtime_forecast(date)','2e44e90505692753ed89de7ed4c8e7c8',array['postgres=X/postgres','service_role=X/postgres','authenticated=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.has_mfa()','57d8d6a5218d30310f7dfb9c3a20bee2',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.has_valid_credential(uuid,public.credential_kind,date)','05ce24272d6d1cff14e318f1283b851f',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.announcement_visible_to_current_user(announcements)','433f742f9a1f4b5eda4855a1ae8533d0',array['postgres=X/postgres','authenticated=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.assign_required_announcement(uuid)','16796a671147be9c7a4dc45d2685be1a',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.communication_audience_employee_ids(text,app_role[],uuid[],boolean)','8b8a5e3788c613d58581153742c3f544',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.count_announcement_recipients(app_role[],boolean)','abb19e3fe94eef3a613c026e4840ff24',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.create_supervisor_open_shift_unmerged(date,uuid,text,text,uuid,text,boolean,date,time without time zone,time without time zone,integer,boolean,text,boolean,uuid,text,text)','d583c411c6b92486bf56e14fcd1db611',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.current_employee_id()','36b8fee439d6ddf26bc5d3d8a1762291',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.enforce_shift_qualification()','e0bdcc16c1c823e585baccab1d22ef6f',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.get_vacancy_patrol_recovery_payload(uuid,boolean)','2a5f9efcb849f8a75210090f12f59b53',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.require_import_admin()','f1705421fe380691b3a1e1ed54c5afd4',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.service_claim_notification_batch_pre_call_off(integer)','cdf3e8111e99d0e4066172880d092424',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.shift_coverage_candidate_payload(uuid,uuid)','b4a2a9eeb27f9f9469a5b68df44d5935',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.support_can_manage(public.support_tickets)','0b7e58a617c0ddc18fefca26cc2b799d',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.support_can_view(public.support_tickets)','761615014994b6851c3fe1d0229ee421',array['postgres=X/postgres']::text[],array['search_path=""']::text[]),
    ('private.update_schedule_draft_shift_unmerged(uuid,date,time without time zone,time without time zone,integer,boolean,boolean,text,uuid,text,text)','97d56617720c6167b915bab8e36b9c78',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.replace_schedule_week_draft_from_revision(uuid,date,boolean,boolean)','7417f5613fd589d4e33418dfc2936e14',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.resolve_schedule_review_shift(uuid,uuid,text,text)','8dae42fa82c30a4e5444132f5f2d7488',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.scheduler_add_draft_shift_assignment_core(uuid,uuid,text,text)','914ce990a0819620f735905664ba0413',array['postgres=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[]),
    ('public.submit_shift_request(uuid,text)','1c595cc5e9104c6ebfb6e41ed9edfa7f',array['postgres=X/postgres','authenticated=X/postgres','service_role=X/postgres']::text[],array['search_path=""']::text[])
  ) as baseline(identity,definition_hash,acl,configuration)
  loop
    select p.*,r.rolname as owner_name into actual
    from pg_proc p join pg_roles r on r.oid=p.proowner
    where p.oid=to_regprocedure(expected.identity);
    if actual.oid is null or md5(pg_get_functiondef(actual.oid))<>expected.definition_hash
      or actual.owner_name<>expected_owner
      or (select array_agg(item::text order by item::text) from unnest(actual.proacl) item)
        is distinct from (select array_agg(item order by item) from unnest(expected.acl) item)
      or actual.proconfig is distinct from expected.configuration then
      raise exception 'Authorization candidate baseline drift: %',expected.identity;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid='public.employee_credentials'::regclass)
    or not has_table_privilege('authenticated','public.employee_credentials','SELECT')
    or (select qual from pg_policies where schemaname='public' and tablename='employee_credentials' and policyname='credentials_read')
      is distinct from '((employee_id = current_employee_id()) OR has_any_effective_permission(ARRAY[''licensing.view''::text, ''licensing.manage''::text, ''directory.edit_credentials''::text]))'
    or exists(select 1 from public.permission_catalog where code in ('admin.security.manage','support.tickets.manage','support.tickets.view') and (not active or not requires_mfa))
    or (select count(*) from public.permission_catalog where code in ('admin.security.manage','support.tickets.manage','support.tickets.view'))<>3 then
    raise exception 'Authorization candidate permission or credential RLS contract drift.';
  end if;
  -- A changed/new invoker caller could lose internal qualification visibility.
  -- No such caller existed in the independently reviewed production inventory.
  if (with functions as materialized (
    select p.oid,p.prosecdef,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where p.prokind='f' and n.nspname in ('public','private')
  ) select count(*) from functions where oid<>'public.has_valid_credential(uuid,public.credential_kind,date)'::regprocedure
    and definition like '%has_valid_credential(%')<>22
    or exists(with functions as materialized (
      select p.oid,p.prosecdef,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where p.prokind='f' and n.nspname in ('public','private')
    ) select 1 from functions where oid<>'public.has_valid_credential(uuid,public.credential_kind,date)'::regprocedure
      and definition like '%has_valid_credential(%' and not prosecdef) then
    raise exception 'Credential caller scope changed; review the caller before hardening.';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='employee_credentials')<>2
    or not exists(select 1 from pg_policies where schemaname='public' and tablename='employee_credentials' and policyname='credentials_read' and roles=array['authenticated']::name[] and cmd='SELECT' and permissive='PERMISSIVE' and with_check is null)
    or not exists(select 1 from pg_policies where schemaname='public' and tablename='employee_credentials' and policyname='credentials_admin_write' and roles=array['authenticated']::name[] and cmd='ALL' and permissive='PERMISSIVE'
      and qual='has_any_effective_permission(ARRAY[''licensing.manage''::text, ''directory.edit_credentials''::text])' and with_check=qual) then
    raise exception 'Credential policy set changed; authorization scope requires review.';
  end if;
end;
$guard$;

create temporary table authorization_recovery_contract_before on commit drop as
select p.oid,p.oid::regprocedure::text as identity,
  to_jsonb(p)-array['prosrc','probin','prosqlbody','prolang','prosecdef'] as contract,
  p.prolang,p.prosecdef
from pg_proc p where p.oid in (
  'public.get_bible_schedule_preview(date)'::regprocedure,
  'public.has_valid_credential(uuid,public.credential_kind,date)'::regprocedure,
  'private.support_can_manage(public.support_tickets)'::regprocedure,
  'private.support_can_view(public.support_tickets)'::regprocedure
);
CREATE OR REPLACE FUNCTION public.get_bible_schedule_preview(target_week_starts_on date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with latest_import as (
    select import_run.id
    from private.import_runs import_run
    order by import_run.created_at desc
    limit 1
  ), schedule_candidate as (
    select candidate.*
    from private.import_candidates candidate
    join latest_import on latest_import.id = candidate.import_run_id
    where candidate.kind = 'weekly_schedule'
      and (candidate.payload ->> 'weekStartsOn')::date = target_week_starts_on
    order by candidate.candidate_key
    limit 1
  ), shift_candidates as (
    select candidate.*
    from private.import_candidates candidate
    join latest_import on latest_import.id = candidate.import_run_id
    where candidate.kind = 'shift'
      and (candidate.payload #>> '{sourceSchedule,weekStartsOn}')::date = target_week_starts_on
  ), issue_counts as (
    select
      count(*) filter (where issue.severity = 'blocking' and issue.resolved_at is null)::integer as blocking_count,
      count(*) filter (where issue.severity = 'warning' and issue.resolved_at is null)::integer as warning_count
    from private.import_issues issue
    join latest_import on latest_import.id = issue.import_run_id
  )
  select jsonb_build_object(
    'importRunId', latest_import.id,
    'weekStartsOn', target_week_starts_on,
    'weekEndsOn', schedule_candidate.payload ->> 'weekEndsOn',
    'sourceSheetName', schedule_candidate.payload ->> 'sourceSheetName',
    'sourceSheetIndex', nullif(schedule_candidate.payload ->> 'sourceSheetIndex', '')::integer,
    'blockingIssueCount', coalesce(issue_counts.blocking_count, 0),
    'warningIssueCount', coalesce(issue_counts.warning_count, 0),
    'shifts',
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', shift_candidate.id,
            'candidateKey', shift_candidate.candidate_key,
            'reviewStatus', shift_candidate.review_status,
            'localDate', shift_candidate.payload ->> 'localDate',
            'startTime', shift_candidate.payload ->> 'startTime',
            'endTime', shift_candidate.payload ->> 'endTime',
            'crossesMidnight', coalesce((shift_candidate.payload ->> 'crossesMidnight')::boolean, false),
            'contextLabel', nullif(shift_candidate.payload ->> 'contextLabel', ''),
            'siteKeyCandidate', nullif(shift_candidate.payload ->> 'siteKeyCandidate', ''),
            'assigneeLabel', nullif(shift_candidate.payload ->> 'assigneeLabel', ''),
            'openCandidate', coalesce((shift_candidate.payload ->> 'openCandidate')::boolean, false),
            'qualificationCandidate', nullif(shift_candidate.payload ->> 'qualificationCandidate', ''),
            'confidence', nullif(shift_candidate.payload ->> 'confidence', ''),
            'sourceTimeAddress', shift_candidate.payload #>> '{sourceTime,address}',
            'sourceAssignmentAddress', shift_candidate.payload #>> '{sourceAssignment,address}'
          )
          order by
            shift_candidate.payload ->> 'contextLabel',
            shift_candidate.payload ->> 'localDate',
            shift_candidate.payload ->> 'startTime',
            shift_candidate.candidate_key
        )
        from shift_candidates shift_candidate
      ),
      '[]'::jsonb
    )
  )
  from latest_import
  left join schedule_candidate on true
  cross join issue_counts
  where exists (select 1 from schedule_candidate)
$function$
;

CREATE OR REPLACE FUNCTION public.has_valid_credential(employee uuid, credential credential_kind, on_date date DEFAULT CURRENT_DATE)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.employee_credentials item
    where item.employee_id = employee
      and item.kind = credential
      and item.status = 'active'
      and (item.valid_from is null or item.valid_from <= on_date)
      and (item.expires_on is null or item.expires_on >= on_date)
  )
$function$
;

CREATE OR REPLACE FUNCTION private.support_can_manage(target_ticket support_tickets)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    private.current_employee_id() is not null
    and (
      public.current_app_role() = 'admin'
      or (
        public.has_effective_permission('support.tickets.manage')
        and public.has_effective_permission(target_ticket.route_permission)
      )
    ),
    false
  )
$function$
;

CREATE OR REPLACE FUNCTION private.support_can_view(target_ticket support_tickets)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(
    private.current_employee_id() is not null
    and (
      target_ticket.submitted_by = private.current_employee_id()
      or public.current_app_role() = 'admin'
      or (
        public.has_effective_permission('support.tickets.view')
        and public.has_effective_permission(target_ticket.route_permission)
      )
    ),
    false
  )
$function$
;
do $contract$
declare original record; actual record;
begin
  for original in select * from pg_temp.authorization_recovery_contract_before loop
    select p.* into actual from pg_proc p where p.oid=original.oid;
    if to_jsonb(actual)-array['prosrc','probin','prosqlbody','prolang','prosecdef'] is distinct from original.contract
      or actual.prosecdef is distinct from true
      or (original.identity<>'get_bible_schedule_preview(date)' and actual.prolang<>original.prolang) then
      raise exception 'Authorization candidate changed an unrelated function contract: %',original.identity;
    end if;
  end loop;
end;
$contract$;
do $fingerprints$
declare expected record;
begin
  for expected in select * from (values ('get_bible_schedule_preview(date)','33e8759be4df799d9383e17e3265b463'),('has_valid_credential(uuid,credential_kind,date)','e5c3d9659547262f75f58c28f96bc5f1'),('private.support_can_manage(support_tickets)','dedc73265327d5b487e99593e8a30097'),('private.support_can_view(support_tickets)','3dfbde398adadddc35f2796b8c217cbf')) as expected(identity,hash) loop
    if md5(pg_get_functiondef(expected.identity::regprocedure))<>expected.hash then
      raise exception 'Installed authorization definition fingerprint differs: %',expected.identity;
    end if;
  end loop;
end;
$fingerprints$;