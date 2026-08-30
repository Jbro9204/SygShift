begin;

-- Stage 4, run 3 adds the service-only inventory contract used by the dormant
-- HR Documents workspace. The release gate remains disabled and this migration
-- does not assign document permissions or change any employee access.
create temporary table hris_stage4_run3_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count;

create or replace function public.service_get_hr_document_workspace(
  target_actor_id uuid,
  target_search text default null,
  target_employee_id uuid default null,
  target_vault_code text default null,
  target_include_archived boolean default false,
  target_page integer default 1,
  target_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
  safe_search text := lower(nullif(btrim(target_search), ''));
  safe_page integer := greatest(coalesce(target_page, 1), 1);
  safe_page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 10 end;
  total_count integer := 0;
  total_pages integer := 0;
  vaults_result jsonb := '[]'::jsonb;
  employees_result jsonb := '[]'::jsonb;
  documents_result jsonb := '[]'::jsonb;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;

  if not exists (
    select 1
    from private.hr_document_release_gate gate
    where gate.singleton and gate.enabled
  ) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;

  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_actor_id
      and employee.status in ('active', 'leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  effective_permissions := private.employee_effective_permissions(target_actor_id);
  if not (
    'hr.documents.view' = any(effective_permissions)
    or 'hr.documents.manage' = any(effective_permissions)
  ) then
    raise insufficient_privilege using message = 'Document access is required.';
  end if;

  with authorized_vaults as (
    select
      vault.code,
      vault.name,
      vault.description,
      vault.classification,
      vault.maximum_file_size_bytes,
      vault.allowed_mime_types,
      (
        'hr.documents.manage' = any(effective_permissions)
        and (
          vault.manage_permission = 'hr.documents.manage'
          or vault.manage_permission = any(effective_permissions)
        )
      ) as can_manage,
      (
        ('hr.documents.view' = any(effective_permissions) or 'hr.documents.manage' = any(effective_permissions))
        and (
          vault.view_permission in ('hr.documents.view', 'hr.documents.manage')
          or vault.view_permission = any(effective_permissions)
          or vault.manage_permission = any(effective_permissions)
        )
      ) as can_view
    from private.hr_document_vaults vault
    where vault.active
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'code', authorized.code,
    'name', authorized.name,
    'description', authorized.description,
    'classification', authorized.classification,
    'canView', authorized.can_view,
    'canManage', authorized.can_manage,
    'maximumFileSizeBytes', authorized.maximum_file_size_bytes,
    'allowedMimeTypes', to_jsonb(authorized.allowed_mime_types)
  ) order by authorized.name), '[]'::jsonb)
  into vaults_result
  from authorized_vaults authorized
  where authorized.can_view or authorized.can_manage;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', employee.id,
    'employeeNumber', employee.employee_number,
    'legalName', concat_ws(' ', employee.first_name, nullif(btrim(employee.middle_name), ''), employee.last_name),
    'status', employee.status::text
  ) order by lower(employee.last_name), lower(employee.first_name)), '[]'::jsonb)
  into employees_result
  from public.employees employee
  where employee.status in ('active', 'onboarding', 'leave');

  with authorized_vaults as (
    select
      vault.code,
      (
        'hr.documents.manage' = any(effective_permissions)
        and (vault.manage_permission = 'hr.documents.manage' or vault.manage_permission = any(effective_permissions))
      ) as can_manage,
      (
        ('hr.documents.view' = any(effective_permissions) or 'hr.documents.manage' = any(effective_permissions))
        and (
          vault.view_permission in ('hr.documents.view', 'hr.documents.manage')
          or vault.view_permission = any(effective_permissions)
          or vault.manage_permission = any(effective_permissions)
        )
      ) as can_view
    from private.hr_document_vaults vault
    where vault.active
  ), filtered as (
    select document.id
    from private.hr_documents document
    join authorized_vaults vault on vault.code = document.vault_code and (vault.can_view or vault.can_manage)
    left join public.employees employee on employee.id = document.employee_id
    where (target_employee_id is null or document.employee_id = target_employee_id)
      and (target_vault_code is null or document.vault_code = target_vault_code)
      and (coalesce(target_include_archived, false) or document.archived_at is null)
      and (
        safe_search is null
        or lower(document.title) like '%' || safe_search || '%'
        or lower(document.category) like '%' || safe_search || '%'
        or lower(coalesce(document.description, '')) like '%' || safe_search || '%'
        or lower(coalesce(employee.employee_number, '')) like '%' || safe_search || '%'
        or lower(concat_ws(' ', employee.first_name, employee.middle_name, employee.last_name)) like '%' || safe_search || '%'
      )
  )
  select count(*) into total_count from filtered;

  total_pages := case when total_count = 0 then 0 else ceil(total_count::numeric / safe_page_size)::integer end;
  if total_pages > 0 then safe_page := least(safe_page, total_pages); else safe_page := 1; end if;

  with authorized_vaults as (
    select
      vault.code,
      (
        'hr.documents.manage' = any(effective_permissions)
        and (vault.manage_permission = 'hr.documents.manage' or vault.manage_permission = any(effective_permissions))
      ) as can_manage,
      (
        ('hr.documents.view' = any(effective_permissions) or 'hr.documents.manage' = any(effective_permissions))
        and (
          vault.view_permission in ('hr.documents.view', 'hr.documents.manage')
          or vault.view_permission = any(effective_permissions)
          or vault.manage_permission = any(effective_permissions)
        )
      ) as can_view
    from private.hr_document_vaults vault
    where vault.active
  ), filtered as (
    select
      document.*,
      employee.employee_number,
      concat_ws(' ', employee.first_name, nullif(btrim(employee.middle_name), ''), employee.last_name) as employee_legal_name,
      vault.can_manage,
      vault.can_view
    from private.hr_documents document
    join authorized_vaults vault on vault.code = document.vault_code and (vault.can_view or vault.can_manage)
    left join public.employees employee on employee.id = document.employee_id
    where (target_employee_id is null or document.employee_id = target_employee_id)
      and (target_vault_code is null or document.vault_code = target_vault_code)
      and (coalesce(target_include_archived, false) or document.archived_at is null)
      and (
        safe_search is null
        or lower(document.title) like '%' || safe_search || '%'
        or lower(document.category) like '%' || safe_search || '%'
        or lower(coalesce(document.description, '')) like '%' || safe_search || '%'
        or lower(coalesce(employee.employee_number, '')) like '%' || safe_search || '%'
        or lower(concat_ws(' ', employee.first_name, employee.middle_name, employee.last_name)) like '%' || safe_search || '%'
      )
    order by document.updated_at desc, document.id
    offset (safe_page - 1) * safe_page_size
    limit safe_page_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', document.id,
    'employeeId', document.employee_id,
    'employeeNumber', document.employee_number,
    'employeeLegalName', document.employee_legal_name,
    'vaultCode', document.vault_code,
    'title', document.title,
    'category', document.category,
    'description', document.description,
    'accessClassification', document.access_classification,
    'effectiveDate', document.effective_date,
    'expirationDate', document.expiration_date,
    'archivedAt', document.archived_at,
    'canManage', document.can_manage,
    'canPreview', document.archived_at is null
      and document.can_view
      and version.id is not null
      and scan.state = 'clean'
      and version.detected_mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'text/plain'),
    'canDownload', document.archived_at is null and document.can_view and version.id is not null and scan.state = 'clean',
    'version', case when version.id is null then null else jsonb_build_object(
      'id', version.id,
      'versionNumber', version.version_number,
      'filename', version.sanitized_filename,
      'mimeType', version.detected_mime_type,
      'sizeBytes', version.size_bytes,
      'uploadedAt', version.uploaded_at,
      'scanState', coalesce(scan.state, 'quarantined')
    ) end
  ) order by document.updated_at desc, document.id), '[]'::jsonb)
  into documents_result
  from filtered document
  left join private.hr_document_versions version on version.id = document.current_version_id
  left join lateral (
    select event.state
    from private.hr_document_scan_events event
    where event.version_id = version.id
    order by event.scanned_at desc, event.id desc
    limit 1
  ) scan on true;

  return jsonb_build_object(
    'releaseState', 'released',
    'actor', jsonb_build_object('canManageAny', exists (
      select 1
      from jsonb_array_elements(vaults_result) item
      where coalesce((item ->> 'canManage')::boolean, false)
    )),
    'vaults', vaults_result,
    'employees', employees_result,
    'documents', documents_result,
    'pagination', jsonb_build_object(
      'page', safe_page,
      'pageSize', safe_page_size,
      'totalCount', total_count,
      'totalPages', total_pages
    )
  );
end
$$;

revoke all on function public.service_get_hr_document_workspace(uuid, text, uuid, text, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.service_get_hr_document_workspace(uuid, text, uuid, text, boolean, integer, integer)
  to service_role;

-- Keep the workspace dormant until the scanner and a named production access
-- plan are approved in a later release run.
update private.hr_document_release_gate
set enabled = false,
    enabled_at = null,
    enabled_by = null,
    evidence_reference = null,
    updated_at = clock_timestamp()
where singleton;

do $$
declare baseline record;
begin
  select * into baseline from hris_stage4_run3_preservation_baseline;
  if (select count(*) from public.employees) <> baseline.employee_count
    or (select count(*) from public.employee_access_roles) <> baseline.employee_role_count
    or (select count(*) from public.access_role_permissions) <> baseline.role_permission_count
    or (select count(*) from public.employee_permission_overrides) <> baseline.override_count
    or (select count(*) from private.employee_accounts) <> baseline.account_count then
    raise exception 'Stage 4 document workspace changed protected employee or access data.';
  end if;
  if exists (select 1 from private.hr_document_release_gate where singleton and enabled) then
    raise exception 'Stage 4 document workspace release gate must remain disabled.';
  end if;
end
$$;

commit;
