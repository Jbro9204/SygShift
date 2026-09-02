with claim as materialized (
  select set_config('request.jwt.claims', '{"role":"service_role"}', true)
), hr_actor as materialized (
  select employee.id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  cross join claim
  where employee.status in ('active','leave')
    and private.employee_effective_permissions(employee.id)
      && array['hr.people.view','hr.people.manage']::text[]
  limit 1
), payload as materialized (
  select public.service_get_hr_template_library(id, 'PTO', null, null, 1, 10) result
  from hr_actor
), employee_actor as materialized (
  select employee.id
  from public.employees employee
  join private.employee_accounts account
    on account.employee_id = employee.id
   and account.disabled_at is null
  cross join claim
  where employee.status in ('active','leave')
    and not (
      private.employee_effective_permissions(employee.id) && array[
        'hr.documents.view','hr.documents.manage','hr.people.view','hr.people.manage',
        'schedule.manage','schedule.publish','scheduler.manage','time.manage',
        'requests.manage','licensing.manage','patrol.manage','patrol.operations.view',
        'directory.edit_basic'
      ]::text[]
    )
  limit 1
), employee_payload as materialized (
  select public.service_get_hr_template_library(id, 'emergency contact', null, null, 1, 10) result
  from employee_actor
)
select
  (select count(*) from private.hr_template_library_items) as indexed_forms,
  (select count(distinct category) from private.hr_template_library_items) as categories,
  (select count(*) from private.hr_template_library_items where search_vector = ''::tsvector) as blank_search_vectors,
  (select result -> 'permissions' ->> 'canSeeHr' from payload) as hr_scope,
  (select result -> 'summary' ->> 'matchingCount' from payload) as pto_matches,
  (select result -> 'items' -> 0 ->> 'code' from payload) as pto_first_code,
  (select result -> 'permissions' ->> 'canSeeSupervisor' from employee_payload) as employee_supervisor_scope,
  (select result -> 'permissions' ->> 'canSeeHr' from employee_payload) as employee_hr_scope,
  (select result -> 'summary' ->> 'matchingCount' from employee_payload) as employee_contact_matches,
  (select result -> 'items' -> 0 ->> 'audience' from employee_payload) as employee_first_audience,
  (select relrowsecurity from pg_class where oid = 'private.hr_template_library_items'::regclass) as row_security,
  has_function_privilege(
    'authenticated',
    'public.service_get_hr_template_library(uuid,text,text,text,integer,integer)',
    'execute'
  ) as browser_execute,
  (select count(*) from public.employees) as employees,
  (select count(*) from public.employee_access_roles) as role_assignments,
  (select count(*) from public.employee_permission_overrides) as overrides,
  (select count(*) from private.hr_documents) as documents,
  (select count(*) from private.hr_document_versions) as document_versions;
