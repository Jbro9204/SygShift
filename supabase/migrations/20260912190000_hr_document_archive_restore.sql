begin;

-- Recoverable document removal for the Document Center. The binary, versions,
-- history, and immutable completion evidence are never deleted.
create or replace function public.service_set_hr_document_archived(
  target_actor_id uuid,
  target_document_id uuid,
  target_archived boolean,
  target_request_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  document_record private.hr_documents%rowtype;
  restore_state text;
  event_reason text;
begin
  if target_actor_id is null or target_document_id is null or target_archived is null then
    raise check_violation using message = 'A valid document lifecycle request is required.';
  end if;

  select * into document_record
  from private.hr_documents document
  where document.id = target_document_id
  for update;

  if document_record.id is null then
    raise no_data_found using message = 'The document could not be found.';
  end if;

  perform private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'manage');

  if target_archived and document_record.archived_at is not null then
    return jsonb_build_object('documentId', document_record.id, 'status', 'archived', 'archivedAt', document_record.archived_at);
  end if;
  if not target_archived and document_record.archived_at is null then
    return jsonb_build_object('documentId', document_record.id, 'status', 'active', 'archivedAt', null);
  end if;

  if target_archived then
    restore_state := document_record.lifecycle_state;
    if exists (
      select 1 from private.hr_document_legal_holds hold
      where hold.document_id = document_record.id and hold.released_at is null
    ) then
      raise check_violation using message = 'This document has an active legal hold. Release the hold before removing it from the active file.';
    end if;
    if exists (
      select 1 from private.hr_document_assignments assignment
      where assignment.document_id = document_record.id and assignment.status = 'pending'
    ) then
      raise check_violation using message = 'This document has an active employee assignment. Complete or cancel the assignment before removing it.';
    end if;
    if exists (
      select 1 from private.hr_document_completion_evidence evidence
      where evidence.document_id = document_record.id
    ) then
      raise check_violation using message = 'This document is completion evidence for an HR action and must remain in the active record.';
    end if;
    if exists (
      select 1 from private.signature_envelopes envelope
      where envelope.document_id = document_record.id
        and envelope.status not in ('completed','declined','expired','voided','superseded','archived')
    ) then
      raise check_violation using message = 'This document has an active signature request. Finish or void the request before removing it.';
    end if;
    if exists (
      select 1 from private.document_processing_jobs job
      where job.document_id = document_record.id and job.status in ('queued','processing')
    ) then
      raise check_violation using message = 'This document is still being processed. Wait for processing to finish before removing it.';
    end if;
    if exists (
      select 1
      from private.document_template_versions template_version
      join private.document_templates template on template.id = template_version.template_id
      where template_version.source_document_id = document_record.id
        and template.status = 'published'
        and template.current_version_id = template_version.id
    ) then
      raise check_violation using message = 'This document is the source for a published company form. Replace or deactivate the form before removing it.';
    end if;

    event_reason := case when document_record.employee_id is null
      then 'Archived from company documents.'
      else 'Removed from the active employee file.'
    end;
    update private.hr_documents
    set archived_at = clock_timestamp(), archived_by = target_actor_id, archive_reason = event_reason,
        restored_at = null, restored_by = null, lifecycle_state = 'archived', updated_at = clock_timestamp()
    where id = document_record.id
    returning * into document_record;

    insert into private.hr_document_access_events(document_id, version_id, action, actor_employee_id, request_id, reason, metadata)
    values (document_record.id, document_record.current_version_id, 'archive', target_actor_id, target_request_id, event_reason,
      jsonb_build_object('employeeId', document_record.employee_id, 'previousLifecycleState', coalesce(restore_state, 'uploaded')));
    insert into private.document_lifecycle_events(document_id, version_id, actor_employee_id, from_state, to_state, reason, request_id, metadata)
    values (document_record.id, document_record.current_version_id, target_actor_id, coalesce(restore_state, 'uploaded'), 'archived', event_reason, target_request_id, jsonb_build_object('employeeId', document_record.employee_id));
  else
    select lifecycle.from_state into restore_state
    from private.document_lifecycle_events lifecycle
    where lifecycle.document_id = document_record.id and lifecycle.to_state = 'archived'
    order by lifecycle.occurred_at desc, lifecycle.id desc
    limit 1;
    if restore_state is null or restore_state in ('archived','deactivated','on_legal_hold') then restore_state := 'uploaded'; end if;
    event_reason := case when document_record.employee_id is null
      then 'Restored to company documents.'
      else 'Restored to the active employee file.'
    end;
    update private.hr_documents
    set archived_at = null, archived_by = null, archive_reason = null,
        restored_at = clock_timestamp(), restored_by = target_actor_id, lifecycle_state = restore_state, updated_at = clock_timestamp()
    where id = document_record.id
    returning * into document_record;
    insert into private.hr_document_access_events(document_id, version_id, action, actor_employee_id, request_id, reason, metadata)
    values (document_record.id, document_record.current_version_id, 'restore', target_actor_id, target_request_id, event_reason,
      jsonb_build_object('employeeId', document_record.employee_id, 'restoredLifecycleState', restore_state));
    insert into private.document_lifecycle_events(document_id, version_id, actor_employee_id, from_state, to_state, reason, request_id, metadata)
    values (document_record.id, document_record.current_version_id, target_actor_id, 'archived', restore_state, event_reason, target_request_id,
      jsonb_build_object('employeeId', document_record.employee_id));
  end if;

  return jsonb_build_object(
    'documentId', document_record.id,
    'status', case when document_record.archived_at is null then 'active' else 'archived' end,
    'archivedAt', document_record.archived_at
  );
end
$$;

revoke all on function public.service_set_hr_document_archived(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.service_set_hr_document_archived(uuid, uuid, boolean, text) to service_role;

commit;
