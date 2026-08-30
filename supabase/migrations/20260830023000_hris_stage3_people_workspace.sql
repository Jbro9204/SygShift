begin;

create temporary table hris_stage3_people_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_person_identifiers) as person_identifier_count,
  (select count(*) from private.hr_worker_identifiers) as worker_identifier_count,
  (select gate.enabled from private.hr_stage2_backfill_gate gate where gate.singleton) as gate_enabled;

create table private.hr_people_saved_views (
  id uuid primary key default gen_random_uuid(),
  owner_employee_id uuid not null references public.employees(id) on delete cascade,
  name text not null,
  search_text text,
  status_filter text not null default 'active',
  employment_filter text not null default 'all',
  role_filter text not null default 'all',
  sort_key text not null default 'legal_name',
  sort_direction text not null default 'asc',
  page_size integer not null default 15,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_people_saved_views_name_present check (btrim(name) <> '' and char_length(name) <= 80),
  constraint hr_people_saved_views_page_size check (page_size in (5, 10, 15, 25)),
  constraint hr_people_saved_views_sort_key check (sort_key in ('legal_name', 'employee_number', 'status', 'hired_on')),
  constraint hr_people_saved_views_sort_direction check (sort_direction in ('asc', 'desc'))
);

create unique index hr_people_saved_views_owner_name_unique
  on private.hr_people_saved_views(owner_employee_id, lower(name));

create trigger set_hr_people_saved_views_updated_at
before update on private.hr_people_saved_views
for each row execute function private.set_updated_at();

create trigger hr_people_saved_views_audit
after insert or update or delete on private.hr_people_saved_views
for each row execute function private.write_audit_event();

revoke all on private.hr_people_saved_views from public, anon, authenticated;

create function private.require_hr_people_viewer()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
begin
  if actor_id is null or not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = actor_id
      and employee.status in ('active', 'onboarding', 'leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  if not public.has_mfa() then
    raise insufficient_privilege using message = 'MFA is required.';
  end if;

  if not (
    public.has_effective_permission('hr.people.view')
    or public.has_effective_permission('hr.people.manage')
  ) then
    raise insufficient_privilege using message = 'People and HR access is required.';
  end if;

  return actor_id;
end
$$;

revoke all on function private.require_hr_people_viewer() from public, anon, authenticated;

create function public.get_hr_people_workspace(
  target_search text default null,
  target_status text default 'active',
  target_employment_type text default 'all',
  target_role text default 'all',
  target_sort text default 'legal_name',
  target_direction text default 'asc',
  target_page integer default 1,
  target_page_size integer default 15
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  clean_search text := nullif(btrim(target_search), '');
  clean_status text := lower(coalesce(nullif(btrim(target_status), ''), 'active'));
  clean_employment text := lower(coalesce(nullif(btrim(target_employment_type), ''), 'all'));
  clean_role text := lower(coalesce(nullif(btrim(target_role), ''), 'all'));
  clean_sort text := lower(coalesce(nullif(btrim(target_sort), ''), 'legal_name'));
  clean_direction text := lower(coalesce(nullif(btrim(target_direction), ''), 'asc'));
  safe_page integer := greatest(coalesce(target_page, 1), 1);
  safe_page_size integer := case when target_page_size in (5, 10, 15, 25) then target_page_size else 15 end;
  total_count bigint;
  items jsonb;
  queue_items jsonb := '[]'::jsonb;
  saved_views jsonb;
  can_manage boolean := public.has_effective_permission('hr.people.manage');
begin
  perform actor_id;

  if clean_status not in ('all', 'onboarding', 'active', 'leave', 'inactive', 'separated') then
    raise check_violation using message = 'The selected employment status is not supported.';
  end if;
  if clean_sort not in ('legal_name', 'employee_number', 'status', 'hired_on') then
    raise check_violation using message = 'The selected sort is not supported.';
  end if;
  if clean_direction not in ('asc', 'desc') then
    raise check_violation using message = 'The selected sort direction is not supported.';
  end if;

  with filtered as (
    select employee.id
    from public.employees employee
    where (clean_status = 'all' or employee.status::text = clean_status)
      and (clean_employment = 'all' or employee.employment_type::text = clean_employment)
      and (clean_role = 'all' or employee.role::text = clean_role)
      and (
        clean_search is null
        or concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) ilike '%' || clean_search || '%'
        or coalesce(employee.employee_number, '') ilike '%' || clean_search || '%'
        or coalesce(employee.username, '') ilike '%' || clean_search || '%'
      )
  )
  select count(*) into total_count from filtered;

  with filtered as (
    select
      employee.id,
      concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) as legal_name,
      employee.employee_number,
      employee.username,
      employee.job_title,
      employee.status::text as employment_status,
      employee.employment_type::text as employment_type,
      employee.role::text as primary_role,
      employee.hired_on,
      employee.separated_on,
      case
        when account.disabled_at is not null then 'disabled'
        when account.activated_at is not null then 'active'
        when account.employee_id is not null then 'pending'
        else 'not_created'
      end as account_status,
      account.last_sign_in_at,
      array_remove(array[
        case when employee.employee_number is null then 'employee_number_missing' end,
        case when employee.hired_on is null and employee.status::text in ('active', 'onboarding', 'leave') then 'hire_date_missing' end,
        case when employee.status::text = 'separated' and employee.separated_on is null then 'separation_date_missing' end
      ], null)::text[] as readiness_signals
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    where (clean_status = 'all' or employee.status::text = clean_status)
      and (clean_employment = 'all' or employee.employment_type::text = clean_employment)
      and (clean_role = 'all' or employee.role::text = clean_role)
      and (
        clean_search is null
        or concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) ilike '%' || clean_search || '%'
        or coalesce(employee.employee_number, '') ilike '%' || clean_search || '%'
        or coalesce(employee.username, '') ilike '%' || clean_search || '%'
      )
  ), paged as (
    select *
    from filtered
    order by
      case when clean_sort = 'legal_name' and clean_direction = 'asc' then legal_name end asc,
      case when clean_sort = 'legal_name' and clean_direction = 'desc' then legal_name end desc,
      case when clean_sort = 'employee_number' and clean_direction = 'asc' then employee_number end asc nulls last,
      case when clean_sort = 'employee_number' and clean_direction = 'desc' then employee_number end desc nulls last,
      case when clean_sort = 'status' and clean_direction = 'asc' then employment_status end asc,
      case when clean_sort = 'status' and clean_direction = 'desc' then employment_status end desc,
      case when clean_sort = 'hired_on' and clean_direction = 'asc' then hired_on end asc nulls last,
      case when clean_sort = 'hired_on' and clean_direction = 'desc' then hired_on end desc nulls last,
      legal_name asc,
      id
    limit safe_page_size offset (safe_page - 1) * safe_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'employeeId', paged.id,
    'legalName', paged.legal_name,
    'employeeNumber', paged.employee_number,
    'username', paged.username,
    'jobTitle', paged.job_title,
    'status', paged.employment_status,
    'employmentType', paged.employment_type,
    'primaryRole', paged.primary_role,
    'hiredOn', paged.hired_on,
    'separatedOn', paged.separated_on,
    'accountStatus', paged.account_status,
    'lastSignInAt', paged.last_sign_in_at,
    'readinessSignals', paged.readiness_signals
  ) order by paged.legal_name, paged.id), '[]'::jsonb)
  into items
  from paged;

  if can_manage then
    select coalesce(jsonb_agg(queue_item order by priority, legal_name), '[]'::jsonb)
    into queue_items
    from (
      select
        jsonb_build_object(
          'employeeId', employee.id,
          'legalName', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
          'reason', case
            when employee.employee_number is null then 'Employee number needed'
            when employee.hired_on is null then 'Verified hire date needed'
            when employee.status::text = 'separated' and employee.separated_on is null then 'Verified separation date needed'
            else 'Account activation pending'
          end
        ) as queue_item,
        case
          when employee.employee_number is null then 1
          when employee.hired_on is null then 2
          when employee.status::text = 'separated' and employee.separated_on is null then 3
          else 4
        end as priority,
        concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name) as legal_name
      from public.employees employee
      left join private.employee_accounts account on account.employee_id = employee.id
      where employee.status::text in ('active', 'onboarding', 'leave', 'separated')
        and (
          employee.employee_number is null
          or employee.hired_on is null
          or (employee.status::text = 'separated' and employee.separated_on is null)
          or (employee.status::text in ('active', 'onboarding', 'leave') and account.employee_id is not null and account.activated_at is null and account.disabled_at is null)
        )
      order by priority, legal_name
      limit 5
    ) queue;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', saved.id,
    'name', saved.name,
    'search', saved.search_text,
    'status', saved.status_filter,
    'employmentType', saved.employment_filter,
    'role', saved.role_filter,
    'sort', saved.sort_key,
    'direction', saved.sort_direction,
    'pageSize', saved.page_size
  ) order by lower(saved.name)), '[]'::jsonb)
  into saved_views
  from private.hr_people_saved_views saved
  where saved.owner_employee_id = actor_id;

  return jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'canManage', can_manage,
    'page', safe_page,
    'pageSize', safe_page_size,
    'totalCount', total_count,
    'totalPages', greatest(ceil(total_count::numeric / safe_page_size)::integer, 1),
    'summary', jsonb_build_object(
      'active', (select count(*) from public.employees where status::text = 'active'),
      'onboarding', (select count(*) from public.employees where status::text = 'onboarding'),
      'leave', (select count(*) from public.employees where status::text = 'leave'),
      'separated', (select count(*) from public.employees where status::text = 'separated'),
      'attention', (
        select count(*) from public.employees employee
        where employee.employee_number is null
          or employee.hired_on is null
          or (employee.status::text = 'separated' and employee.separated_on is null)
      )
    ),
    'items', items,
    'priorityQueue', queue_items,
    'savedViews', saved_views,
    'options', jsonb_build_object(
      'statuses', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb) from (select distinct status::text value from public.employees) status_values),
      'employmentTypes', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb) from (select distinct employment_type::text value from public.employees) employment_values),
      'roles', (select coalesce(jsonb_agg(value order by value), '[]'::jsonb) from (select distinct role::text value from public.employees) role_values)
    )
  );
end
$$;

revoke all on function public.get_hr_people_workspace(text, text, text, text, text, text, integer, integer) from public, anon;
grant execute on function public.get_hr_people_workspace(text, text, text, text, text, text, integer, integer) to authenticated;

create function public.get_hr_people_record(target_employee_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  can_view_restricted boolean := public.has_effective_permission('hr.people.restricted');
  result jsonb;
begin
  perform actor_id;

  select jsonb_build_object(
    'employeeId', employee.id,
    'legalName', concat_ws(' ', employee.first_name, nullif(employee.middle_name, ''), employee.last_name),
    'firstName', employee.first_name,
    'middleName', employee.middle_name,
    'lastName', employee.last_name,
    'employeeNumber', employee.employee_number,
    'username', employee.username,
    'jobTitle', employee.job_title,
    'status', employee.status::text,
    'employmentType', employee.employment_type::text,
    'primaryRole', employee.role::text,
    'hiredOn', employee.hired_on,
    'separatedOn', employee.separated_on,
    'account', jsonb_build_object(
      'status', case when account.disabled_at is not null then 'disabled' when account.activated_at is not null then 'active' when account.employee_id is not null then 'pending' else 'not_created' end,
      'invitedAt', account.invited_at,
      'activatedAt', account.activated_at,
      'disabledAt', account.disabled_at,
      'lastSignInAt', account.last_sign_in_at
    ),
    'contacts', case when can_view_restricted then jsonb_build_object(
      'personalEmail', contact.personal_email,
      'companyEmail', contact.company_email,
      'mobilePhone', contact.mobile_phone,
      'emergencyContactName', contact.emergency_contact_name,
      'emergencyContactPhone', contact.emergency_contact_phone,
      'addressLine1', contact.address_line_1,
      'addressLine2', contact.address_line_2,
      'city', contact.city,
      'region', contact.region,
      'postalCode', contact.postal_code
    ) else null end,
    'canViewRestricted', can_view_restricted,
    'readinessSignals', array_remove(array[
      case when employee.employee_number is null then 'employee_number_missing' end,
      case when employee.hired_on is null and employee.status::text in ('active', 'onboarding', 'leave') then 'hire_date_missing' end,
      case when employee.status::text = 'separated' and employee.separated_on is null then 'separation_date_missing' end
    ], null)::text[],
    'connectedRecords', jsonb_build_object(
      'activeCredentials', (select count(*) from public.employee_credentials credential where credential.employee_id = employee.id and credential.status::text = 'active' and (credential.expires_on is null or credential.expires_on >= current_date)),
      'expiredCredentials', (select count(*) from public.employee_credentials credential where credential.employee_id = employee.id and (credential.status::text = 'expired' or credential.expires_on < current_date)),
      'upcomingAvailability', (select count(*) from public.employee_availability availability where availability.employee_id = employee.id and availability.ends_on >= current_date and availability.approval_status::text = 'approved'),
      'pendingTimeOff', (select count(*) from public.time_off_requests request where request.employee_id = employee.id and request.status::text = 'pending')
    )
  )
  into result
  from public.employees employee
  left join private.employee_accounts account on account.employee_id = employee.id
  left join private.employee_contacts contact on contact.employee_id = employee.id
  where employee.id = target_employee_id;

  if result is null then raise no_data_found using message = 'Employee record not found.'; end if;
  return result;
end
$$;

revoke all on function public.get_hr_people_record(uuid) from public, anon;
grant execute on function public.get_hr_people_record(uuid) to authenticated;

create function public.save_hr_people_view(
  target_name text,
  target_search text,
  target_status text,
  target_employment_type text,
  target_role text,
  target_sort text,
  target_direction text,
  target_page_size integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
  saved_id uuid;
begin
  if btrim(coalesce(target_name, '')) = '' or char_length(btrim(target_name)) > 80 then
    raise check_violation using message = 'Saved view name must be between 1 and 80 characters.';
  end if;
  if lower(target_status) not in ('all', 'onboarding', 'active', 'leave', 'inactive', 'separated')
    or lower(target_sort) not in ('legal_name', 'employee_number', 'status', 'hired_on')
    or lower(target_direction) not in ('asc', 'desc')
    or target_page_size not in (5, 10, 15, 25) then
    raise check_violation using message = 'Saved view settings are not supported.';
  end if;

  insert into private.hr_people_saved_views (
    owner_employee_id, name, search_text, status_filter, employment_filter, role_filter, sort_key, sort_direction, page_size
  ) values (
    actor_id, btrim(target_name), nullif(btrim(target_search), ''), lower(target_status), lower(target_employment_type), lower(target_role), lower(target_sort), lower(target_direction), target_page_size
  )
  on conflict (owner_employee_id, (lower(name))) do update set
    search_text = excluded.search_text,
    status_filter = excluded.status_filter,
    employment_filter = excluded.employment_filter,
    role_filter = excluded.role_filter,
    sort_key = excluded.sort_key,
    sort_direction = excluded.sort_direction,
    page_size = excluded.page_size
  returning id into saved_id;

  return saved_id;
end
$$;

revoke all on function public.save_hr_people_view(text, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.save_hr_people_view(text, text, text, text, text, text, text, integer) to authenticated;

create function public.delete_hr_people_view(target_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.require_hr_people_viewer();
begin
  delete from private.hr_people_saved_views where id = target_id and owner_employee_id = actor_id;
  return found;
end
$$;

revoke all on function public.delete_hr_people_view(uuid) from public, anon;
grant execute on function public.delete_hr_people_view(uuid) to authenticated;

comment on function public.get_hr_people_workspace(text, text, text, text, text, text, integer, integer) is
  'MFA-protected People and HR workspace. Returns paginated legal-name workforce records without contact details.';
comment on function public.get_hr_people_record(uuid) is
  'MFA-protected Employee File. Restricted contact fields are returned only with hr.people.restricted.';

do $$
declare
  baseline record;
begin
  select * into baseline from hris_stage3_people_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.person_identifier_count <> (select count(*) from private.hr_person_identifiers)
    or baseline.worker_identifier_count <> (select count(*) from private.hr_worker_identifiers) then
    raise exception 'Stage 3 People and HR changed protected employee, access, or HR identity records.';
  end if;
  if baseline.gate_enabled or exists (select 1 from private.hr_stage2_backfill_gate where singleton and enabled) then
    raise exception 'Stage 3 People and HR requires the identity backfill gate to remain closed.';
  end if;
end
$$;

commit;
