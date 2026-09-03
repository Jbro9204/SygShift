begin;

create temporary table document_studio_access_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.hr_documents) as document_count,
  (select count(*) from private.hr_document_versions) as document_version_count,
  (select count(*) from private.hr_document_requests) as document_request_count,
  (select count(*) from private.hr_document_assignments) as document_assignment_count,
  (select count(*) from private.document_templates) as template_count,
  (select count(*) from private.signature_envelopes) as envelope_count,
  (select count(*) from private.signature_recipients) as recipient_count,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', role_id::text, permission_code, enabled::text),
      '|' order by role_id, permission_code
    )), md5(''))
    from public.access_role_permissions
  ) as role_permission_fingerprint,
  (
    select coalesce(md5(string_agg(
      concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text),
      '|' order by id
    )), md5(''))
    from public.employee_permission_overrides
  ) as override_fingerprint;

do $$
begin
  if not exists (
    select 1
    from public.permission_catalog
    where code = 'documents.workspace.view' and active
  ) then
    raise exception 'The Document Studio access permission is unavailable.';
  end if;

  if exists (
    select 1
    from unnest(array['system_admin','human_resources','human_resources_employee']::text[]) expected(role_code)
    where not exists (
      select 1
      from public.access_roles role
      join public.access_role_permissions permission on permission.role_id = role.id
      where role.code = expected.role_code
        and role.active
        and permission.permission_code = 'documents.workspace.view'
        and permission.enabled
    )
  ) then
    raise exception 'Admin and both Human Resources roles must retain Document Studio access.';
  end if;
end
$$;

create or replace function private.document_studio_require_permission(
  target_actor_id uuid,
  target_permission text
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := private.document_studio_require_actor(target_actor_id);
begin
  if not ('documents.workspace.view' = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Document Studio access is required.';
  end if;

  if target_permission <> 'documents.workspace.view'
    and not (target_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'The required Document Studio permission is missing.';
  end if;

  return effective_permissions;
end
$$;

create or replace function private.document_studio_can_view_document(
  target_actor_id uuid,
  target_document_id uuid,
  target_permissions text[] default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[] := coalesce(
    target_permissions,
    private.document_studio_require_actor(target_actor_id)
  );
  document_vault private.hr_document_vaults%rowtype;
begin
  if not ('documents.workspace.view' = any(effective_permissions)) then
    return false;
  end if;

  select vault.* into document_vault
  from private.hr_documents document
  join private.hr_document_vaults vault
    on vault.code = document.vault_code
   and vault.active
  where document.id = target_document_id
    and document.archived_at is null;

  if document_vault.code is null then
    return false;
  end if;

  return (
    document_vault.view_permission in ('hr.documents.view','hr.documents.manage')
    or document_vault.view_permission = any(effective_permissions)
    or document_vault.manage_permission = any(effective_permissions)
  );
end
$$;

create or replace function private.service_require_hr_document_permission(
  target_actor_id uuid,
  target_vault_code text,
  target_action text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  vault_record private.hr_document_vaults%rowtype;
  effective_permissions text[];
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if target_action not in ('view','manage') then
    raise check_violation using message = 'Unsupported document permission action.';
  end if;
  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_actor_id
      and employee.status in ('active','leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  select * into vault_record
  from private.hr_document_vaults vault
  where vault.code = target_vault_code and vault.active;
  if vault_record.code is null then
    raise check_violation using message = 'The requested document vault is unavailable.';
  end if;

  effective_permissions := private.employee_effective_permissions(target_actor_id);
  if not ('documents.workspace.view' = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Document Studio access is required.';
  end if;
  if target_action = 'manage' and not ('hr.documents.manage' = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Document management access is required.';
  end if;
  if target_action = 'view' and not (
    'hr.documents.view' = any(effective_permissions)
    or 'hr.documents.manage' = any(effective_permissions)
  ) then
    raise insufficient_privilege using message = 'Document access is required.';
  end if;
  if target_action = 'manage'
    and vault_record.manage_permission <> 'hr.documents.manage'
    and not (vault_record.manage_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Management access to this document vault is required.';
  end if;
  if target_action = 'view'
    and vault_record.view_permission not in ('hr.documents.view','hr.documents.manage')
    and not (vault_record.view_permission = any(effective_permissions))
    and not (vault_record.manage_permission = any(effective_permissions)) then
    raise insufficient_privilege using message = 'Access to this document vault is required.';
  end if;
end
$$;

alter function public.service_get_hr_template_library(uuid,text,text,text,integer,integer)
  set schema private;
alter function private.service_get_hr_template_library(uuid,text,text,text,integer,integer)
  rename to hr_template_library_catalog;

revoke all on function private.hr_template_library_catalog(uuid,text,text,text,integer,integer)
  from public, anon, authenticated, service_role;

create function public.service_get_hr_template_library(
  target_actor_id uuid,
  target_search text default null,
  target_category text default null,
  target_audience text default null,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.document_studio_require_permission(
    target_actor_id,
    'documents.workspace.view'
  );

  return private.hr_template_library_catalog(
    target_actor_id,
    target_search,
    target_category,
    target_audience,
    target_page,
    target_page_size
  );
end
$$;

revoke all on function public.service_get_hr_template_library(uuid,text,text,text,integer,integer)
  from public, anon, authenticated;
grant execute on function public.service_get_hr_template_library(uuid,text,text,text,integer,integer)
  to service_role;

do $$
declare
  original_definition text;
  secured_definition text;
begin
  select pg_get_functiondef(p.oid)
  into original_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'get_hr_people_record'
    and pg_get_function_identity_arguments(p.oid) = 'target_employee_id uuid';

  if original_definition is null then
    raise exception 'The HR employee-file function is unavailable.';
  end if;

  secured_definition := replace(
    original_definition,
    $old$can_view_documents boolean :=
    (public.has_effective_permission('hr.documents.view') or public.has_effective_permission('hr.documents.manage'))
    and$old$,
    $new$can_view_documents boolean :=
    public.has_effective_permission('documents.workspace.view')
    and$new$
  );

  if secured_definition = original_definition then
    raise exception 'The HR employee-file document access clause did not match the expected definition.';
  end if;

  execute secured_definition;
end
$$;

revoke all on function private.document_studio_require_permission(uuid,text)
  from public, anon, authenticated;
revoke all on function private.document_studio_can_view_document(uuid,uuid,text[])
  from public, anon, authenticated;
revoke all on function private.service_require_hr_document_permission(uuid,text,text)
  from public, anon, authenticated;

do $$
declare baseline record;
begin
  select * into baseline from document_studio_access_preservation_baseline;

  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.document_count <> (select count(*) from private.hr_documents)
    or baseline.document_version_count <> (select count(*) from private.hr_document_versions)
    or baseline.document_request_count <> (select count(*) from private.hr_document_requests)
    or baseline.document_assignment_count <> (select count(*) from private.hr_document_assignments)
    or baseline.template_count <> (select count(*) from private.document_templates)
    or baseline.envelope_count <> (select count(*) from private.signature_envelopes)
    or baseline.recipient_count <> (select count(*) from private.signature_recipients)
    or baseline.role_permission_fingerprint <> (
      select coalesce(md5(string_agg(
        concat_ws(':', role_id::text, permission_code, enabled::text),
        '|' order by role_id, permission_code
      )), md5(''))
      from public.access_role_permissions
    )
    or baseline.override_fingerprint <> (
      select coalesce(md5(string_agg(
        concat_ws(':', id::text, employee_id::text, permission_code, effect, reason, active::text),
        '|' order by id
      )), md5(''))
      from public.employee_permission_overrides
    ) then
    raise exception 'Document Studio access hardening changed protected records or permission assignments.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;
