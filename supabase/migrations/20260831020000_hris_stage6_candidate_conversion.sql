begin;

-- Stage 6, run 2 keeps candidate records separate from permanent workers until a
-- human-approved conversion. Conversion creates no login and grants no access.
create temporary table hris_stage6_run2_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count;

alter table private.hr_applicants
  add column if not exists converted_employee_id uuid unique references public.employees(id) on delete restrict,
  add column if not exists converted_at timestamptz;

create table private.hr_candidate_conversion_requests (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references private.hr_applications(id) on delete restrict,
  status text not null default 'requested',
  proposed_role public.app_role not null,
  proposed_employment_type public.employment_type not null,
  proposed_job_title text not null,
  proposed_start_date date not null,
  requested_by uuid not null references public.employees(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  request_reason text not null,
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  review_reason text,
  converted_employee_id uuid unique references public.employees(id) on delete restrict,
  converted_at timestamptz,
  identity_snapshot jsonb not null default '{}'::jsonb,
  constraint hr_candidate_conversion_status check (status in ('requested','approved','converted','rejected','canceled')),
  constraint hr_candidate_conversion_title check (btrim(proposed_job_title) <> ''),
  constraint hr_candidate_conversion_request_reason check (btrim(request_reason) <> ''),
  constraint hr_candidate_conversion_review_consistency check (
    (status = 'requested' and reviewed_by is null and reviewed_at is null and review_reason is null and converted_employee_id is null and converted_at is null)
    or (status in ('approved','rejected','canceled') and reviewed_by is not null and reviewed_at is not null and btrim(coalesce(review_reason,'')) <> '' and converted_employee_id is null and converted_at is null)
    or (status = 'converted' and reviewed_by is not null and reviewed_at is not null and btrim(coalesce(review_reason,'')) <> '' and converted_employee_id is not null and converted_at is not null)
  )
);

create table private.hr_candidate_conversion_events (
  id bigint generated always as identity primary key,
  conversion_request_id uuid not null references private.hr_candidate_conversion_requests(id) on delete restrict,
  event_type text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hr_candidate_conversion_event_type check (event_type in ('requested','approved','rejected','canceled','converted')),
  constraint hr_candidate_conversion_event_reason check (btrim(reason) <> '')
);

create index hr_candidate_conversion_status_idx on private.hr_candidate_conversion_requests(status, requested_at desc);
create index hr_candidate_conversion_events_request_idx on private.hr_candidate_conversion_events(conversion_request_id, occurred_at desc);

create or replace function private.hr_candidate_duplicate_matches(target_application_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with candidate as (
    select applicant.*
    from private.hr_applications application
    join private.hr_applicants applicant on applicant.id = application.applicant_id
    where application.id = target_application_id
  ), matches as (
    select distinct employee.id, employee.employee_number, employee.first_name, employee.last_name,
      case
        when lower(contact.personal_email) = lower(candidate.personal_email) then 'personal_email'
        when regexp_replace(coalesce(contact.mobile_phone,''),'[^0-9]','','g') <> '' and regexp_replace(coalesce(contact.mobile_phone,''),'[^0-9]','','g') = regexp_replace(coalesce(candidate.mobile_phone,''),'[^0-9]','','g') then 'mobile_phone'
        else 'legal_name'
      end as matched_on
    from candidate
    join public.employees employee on (
      (candidate.personal_email is not null and exists (select 1 from private.employee_contacts c where c.employee_id = employee.id and lower(c.personal_email) = lower(candidate.personal_email)))
      or (candidate.mobile_phone is not null and regexp_replace(candidate.mobile_phone,'[^0-9]','','g') <> '' and exists (select 1 from private.employee_contacts c where c.employee_id = employee.id and regexp_replace(coalesce(c.mobile_phone,''),'[^0-9]','','g') = regexp_replace(candidate.mobile_phone,'[^0-9]','','g')))
      or (lower(employee.first_name) = lower(candidate.legal_first_name) and lower(employee.last_name) = lower(candidate.legal_last_name))
    )
    left join private.employee_contacts contact on contact.employee_id = employee.id
  )
  select coalesce(jsonb_agg(to_jsonb(matches.*) order by matches.last_name, matches.first_name), '[]'::jsonb) from matches
$$;

create or replace function public.service_request_candidate_conversion(
  target_actor_id uuid,
  target_application_id uuid,
  target_role public.app_role,
  target_employment_type public.employment_type,
  target_job_title text,
  target_start_date date,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare request_id uuid; duplicate_matches jsonb; application_record record;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_recruiting_assert_enabled();
  perform private.hr_recruiting_require_actor_permission(target_actor_id, 'hr.recruiting.manage');
  if btrim(coalesce(target_reason,'')) = '' or btrim(coalesce(target_job_title,'')) = '' then raise check_violation using message = 'Job title and audit reason are required.'; end if;
  select application.*, applicant.converted_employee_id into application_record
  from private.hr_applications application
  join private.hr_applicants applicant on applicant.id = application.applicant_id
  where application.id = target_application_id for update of application, applicant;
  if not found or application_record.stage <> 'accepted' or application_record.status <> 'active' then raise check_violation using message = 'Only an accepted active candidate can be converted.'; end if;
  if application_record.converted_employee_id is not null then raise unique_violation using message = 'This candidate already has a permanent employee identity.'; end if;
  if not exists(select 1 from private.hr_offers offer where offer.application_id = target_application_id and offer.status = 'accepted') then raise check_violation using message = 'An accepted offer is required before conversion.'; end if;
  duplicate_matches := private.hr_candidate_duplicate_matches(target_application_id);
  if jsonb_array_length(duplicate_matches) > 0 then raise unique_violation using message = 'Possible duplicate employee found. Resolve the identity match before conversion.', detail = duplicate_matches::text; end if;
  insert into private.hr_candidate_conversion_requests(application_id, proposed_role, proposed_employment_type, proposed_job_title, proposed_start_date, requested_by, request_reason, identity_snapshot)
  values(target_application_id, target_role, target_employment_type, btrim(target_job_title), target_start_date, target_actor_id, btrim(target_reason), jsonb_build_object('duplicateMatches', duplicate_matches))
  returning id into request_id;
  insert into private.hr_candidate_conversion_events(conversion_request_id,event_type,actor_id,reason) values(request_id,'requested',target_actor_id,btrim(target_reason));
  return jsonb_build_object('conversionRequestId',request_id,'status','requested','duplicateMatches',duplicate_matches);
end
$$;

create or replace function public.service_review_candidate_conversion(
  target_actor_id uuid,
  target_request_id uuid,
  target_decision text,
  target_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare conversion private.hr_candidate_conversion_requests%rowtype; applicant private.hr_applicants%rowtype; created_employee_id uuid; created_person_id uuid; created_worker_id uuid; created_employee_number text; duplicate_matches jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  perform private.hr_recruiting_assert_enabled();
  perform private.hr_recruiting_require_actor_permission(target_actor_id, 'hr.recruiting.approve');
  if target_decision not in ('approve','reject','cancel') or btrim(coalesce(target_reason,'')) = '' then raise check_violation using message = 'A supported decision and audit reason are required.'; end if;
  select * into conversion from private.hr_candidate_conversion_requests where id = target_request_id for update;
  if not found or conversion.status <> 'requested' then raise check_violation using message = 'Only a pending conversion request can be reviewed.'; end if;
  if conversion.requested_by = target_actor_id then raise insufficient_privilege using message = 'Candidate conversion requires a second authorized reviewer.'; end if;
  if target_decision <> 'approve' then
    update private.hr_candidate_conversion_requests set status = case target_decision when 'reject' then 'rejected' else 'canceled' end, reviewed_by=target_actor_id, reviewed_at=clock_timestamp(), review_reason=btrim(target_reason) where id=target_request_id;
    insert into private.hr_candidate_conversion_events(conversion_request_id,event_type,actor_id,reason) values(target_request_id,case target_decision when 'reject' then 'rejected' else 'canceled' end,target_actor_id,btrim(target_reason));
    return jsonb_build_object('conversionRequestId',target_request_id,'status',case target_decision when 'reject' then 'rejected' else 'canceled' end);
  end if;
  duplicate_matches := private.hr_candidate_duplicate_matches(conversion.application_id);
  if jsonb_array_length(duplicate_matches) > 0 then raise unique_violation using message = 'Possible duplicate employee found. Resolve the identity match before conversion.', detail = duplicate_matches::text; end if;
  select applicant.* into applicant from private.hr_applications application join private.hr_applicants applicant on applicant.id=application.applicant_id where application.id=conversion.application_id for update of applicant;
  insert into public.employees(first_name,middle_name,last_name,preferred_name,role,employment_type,status,job_title,hired_on)
  values(applicant.legal_first_name,applicant.legal_middle_name,applicant.legal_last_name,applicant.preferred_name,conversion.proposed_role,conversion.proposed_employment_type,'onboarding',conversion.proposed_job_title,conversion.proposed_start_date)
  returning id, employee_number into created_employee_id, created_employee_number;
  insert into private.employee_contacts(employee_id,personal_email,mobile_phone,city,region)
  values(created_employee_id,applicant.personal_email,applicant.mobile_phone,applicant.city,applicant.region);
  insert into private.hr_person_identifiers(employee_id,source_system,created_by) values(created_employee_id,'hr_recruiting',target_actor_id) returning id into created_person_id;
  insert into private.hr_worker_identifiers(person_id,worker_reference,created_by)
  values(created_person_id, created_employee_number, target_actor_id)
  returning id into created_worker_id;
  update private.hr_applicants set converted_employee_id=created_employee_id,converted_at=clock_timestamp() where id=applicant.id;
  update private.hr_applications set status='hired',updated_at=clock_timestamp() where id=conversion.application_id;
  update private.hr_candidate_conversion_requests set status='converted',reviewed_by=target_actor_id,reviewed_at=clock_timestamp(),review_reason=btrim(target_reason),converted_employee_id=created_employee_id,converted_at=clock_timestamp(),identity_snapshot=jsonb_build_object('employeeId',created_employee_id,'personId',created_person_id,'workerId',created_worker_id) where id=target_request_id;
  insert into private.hr_candidate_conversion_events(conversion_request_id,event_type,actor_id,reason,details) values(target_request_id,'converted',target_actor_id,btrim(target_reason),jsonb_build_object('employeeId',created_employee_id));
  return jsonb_build_object('conversionRequestId',target_request_id,'status','converted','employeeId',created_employee_id,'loginCreated',false,'accessGranted',false);
end
$$;

alter table private.hr_candidate_conversion_requests enable row level security;
alter table private.hr_candidate_conversion_events enable row level security;
revoke all on private.hr_candidate_conversion_requests, private.hr_candidate_conversion_events from public,anon,authenticated;
grant select,insert,update on private.hr_candidate_conversion_requests to service_role;
grant select,insert on private.hr_candidate_conversion_events to service_role;
create trigger hr_candidate_conversion_events_append_only before update or delete on private.hr_candidate_conversion_events for each row execute function private.prevent_append_only_change();
revoke all on function private.hr_candidate_duplicate_matches(uuid), public.service_request_candidate_conversion(uuid,uuid,public.app_role,public.employment_type,text,date,text), public.service_review_candidate_conversion(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function private.hr_candidate_duplicate_matches(uuid), public.service_request_candidate_conversion(uuid,uuid,public.app_role,public.employment_type,text,date,text), public.service_review_candidate_conversion(uuid,uuid,text,text) to service_role;

do $$
declare baseline record;
begin
  select * into baseline from hris_stage6_run2_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.account_count <> (select count(*) from private.employee_accounts) then
    raise exception 'Stage 6 run 2 changed protected production identities or access assignments during migration.';
  end if;
end
$$;

commit;
