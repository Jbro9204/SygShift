begin;

create or replace function public.service_register_hr_system_item(
  target_actor_id uuid, target_document_id uuid, target_code text, target_title text,
  target_category text, target_section text, target_record_class text, target_purpose text,
  target_audience text, target_sensitivity text, target_source_filename text,
  target_document_kind text, target_lifecycle_status text, target_guide_code text,
  target_related_modules text[], target_source_sha256 text, target_page_count integer,
  target_full_text text, target_package_metadata jsonb, target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  effective_permissions text[];
  library_id uuid;
  registered_course_id uuid;
  registered_version_id uuid;
  latest_version integer;
  normalized_learning_code text := lower(replace(target_code, '-', '_'));
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  effective_permissions := private.document_studio_require_actor(target_actor_id);
  if not (effective_permissions && array['hr.documents.manage','hr.learning.manage','training.manage']::text[]) then raise insufficient_privilege using message = 'HR document or training management permission is required.'; end if;
  if target_code !~ '^[A-Z][A-Z0-9-]{1,79}$' then raise check_violation using message = 'The controlled item code is invalid.'; end if;
  if target_document_kind not in ('hr_source','training_admin','training_module','document_guide','training_form') then raise check_violation using message = 'The controlled item kind is invalid.'; end if;
  if target_audience <> 'hr_only' then raise check_violation using message = 'The protected master library is restricted to HR.'; end if;
  if target_sensitivity not in ('standard','restricted','highly_restricted') then raise check_violation using message = 'The item sensitivity is invalid.'; end if;
  if target_lifecycle_status not in ('draft_for_adoption','adopted','retired') then raise check_violation using message = 'The item lifecycle status is invalid.'; end if;
  if target_source_sha256 !~ '^[a-f0-9]{64}$' or target_page_count < 1 then raise check_violation using message = 'The PDF evidence is invalid.'; end if;
  if jsonb_typeof(coalesce(target_package_metadata, '{}'::jsonb)) <> 'object' then raise check_violation using message = 'Package metadata must be an object.'; end if;
  if not exists (select 1 from private.hr_documents document where document.id=target_document_id and document.archived_at is null and document.current_version_id is not null) then raise no_data_found using message = 'The protected source document is unavailable.'; end if;

  insert into private.hr_template_library_items(form_code,title,category,section,record_class,purpose,audience_scope,sensitivity,source_filename,display_order,source_document_id,active,document_kind,lifecycle_status,guide_code,related_modules,source_sha256,page_count,full_text,package_metadata)
  values(target_code,btrim(target_title),btrim(target_category),btrim(target_section),btrim(target_record_class),btrim(target_purpose),'hr_only',target_sensitivity,btrim(target_source_filename),coalesce((select max(item.display_order)+10 from private.hr_template_library_items item),10),target_document_id,target_lifecycle_status<>'retired',target_document_kind,target_lifecycle_status,nullif(btrim(target_guide_code),''),coalesce(target_related_modules,'{}'::text[]),target_source_sha256,target_page_count,coalesce(target_full_text,''),coalesce(target_package_metadata,'{}'::jsonb))
  on conflict(form_code) do update set title=excluded.title,category=excluded.category,section=excluded.section,record_class=excluded.record_class,purpose=excluded.purpose,audience_scope=excluded.audience_scope,sensitivity=excluded.sensitivity,source_filename=excluded.source_filename,source_document_id=excluded.source_document_id,active=excluded.active,document_kind=excluded.document_kind,lifecycle_status=excluded.lifecycle_status,guide_code=excluded.guide_code,related_modules=excluded.related_modules,source_sha256=excluded.source_sha256,page_count=excluded.page_count,full_text=excluded.full_text,package_metadata=excluded.package_metadata,updated_at=clock_timestamp()
  returning id into library_id;

  if target_document_kind='training_module' then
    insert into private.hr_learning_items(code,title,description,delivery_method,requirement_type,status,configuration,created_by,approved_by,approved_at)
    values(normalized_learning_code,btrim(target_title),btrim(target_purpose),'document','optional','active',jsonb_build_object('sourceDocumentId',target_document_id,'libraryItemId',library_id,'packageVersion','2.1'),target_actor_id,target_actor_id,clock_timestamp())
    on conflict(code) do update set title=excluded.title,description=excluded.description,delivery_method='document',status='active',configuration=excluded.configuration,updated_at=clock_timestamp();

    insert into public.training_courses(code,title,description,active,created_by)
    values(target_code,btrim(target_title),btrim(target_purpose),true,target_actor_id)
    on conflict(code) do update set title=excluded.title,description=excluded.description,active=true,updated_at=clock_timestamp()
    returning id into registered_course_id;

    select version.id into registered_version_id from public.training_course_versions version
    where version.course_id=registered_course_id and version.content_digest=target_source_sha256
    order by version.version_number desc limit 1;
    if registered_version_id is null then
      select coalesce(max(version.version_number),0) into latest_version from public.training_course_versions version where version.course_id=registered_course_id;
      insert into public.training_course_versions(course_id,version_number,title,description,content_type,content_url,instructions,effective_on,default_due_days,completion_rule,requires_acknowledgment,content_digest,published_by,source_document_id)
      values(registered_course_id,latest_version+1,btrim(target_title),btrim(target_purpose),'document','/api/v1/training/documents/'||target_document_id::text,'Open the assigned PDF, complete the material, and attest to completion in Action Center.',current_date,14,'employee_attestation',true,target_source_sha256,target_actor_id,target_document_id)
      returning id into registered_version_id;
    end if;
  end if;

  insert into private.hr_document_access_events(document_id,version_id,action,actor_employee_id,request_id,reason,metadata)
  select document.id,document.current_version_id,'share',target_actor_id,nullif(btrim(target_request_id),''),'Registered protected HR System v2.1 library item.',jsonb_build_object('libraryItemId',library_id,'code',target_code,'kind',target_document_kind)
  from private.hr_documents document where document.id=target_document_id;

  return jsonb_build_object('libraryItemId',library_id,'documentId',target_document_id,'trainingCourseId',registered_course_id,'trainingVersionId',registered_version_id);
end
$$;

commit;
