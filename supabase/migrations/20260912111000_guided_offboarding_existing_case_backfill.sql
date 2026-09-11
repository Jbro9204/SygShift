begin;

-- Existing Stage 9 cases predate the guided checklist. Add only the missing
-- handoffs and library references so no approved legacy case can bypass the
-- same controls required of a newly created case.
with workstreams(workstream) as (
  values
    ('timecard'), ('payroll_final_pay'), ('benefits'), ('licensing'),
    ('training'), ('documents'), ('assets'), ('schedule'),
    ('client_site_notifications'), ('communications'),
    ('records_retention'), ('account_access')
)
insert into private.hr_lifecycle_tasks(
  lifecycle_case_id,
  workstream,
  status,
  assigned_to,
  due_on
)
select
  lifecycle.id,
  workstreams.workstream,
  case
    when lifecycle.status in ('approved','approved_scheduled','due','in_progress') then 'ready'
    else 'pending'
  end,
  lifecycle.requested_by,
  lifecycle.effective_on
from private.hr_lifecycle_cases lifecycle
cross join workstreams
where lifecycle.status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress')
on conflict(lifecycle_case_id, workstream) do nothing;

insert into private.hr_lifecycle_document_links(
  lifecycle_case_id,
  form_code,
  source_document_id,
  linked_by
)
select
  lifecycle.id,
  recommended_form.form_code,
  library.source_document_id,
  lifecycle.requested_by
from private.hr_lifecycle_cases lifecycle
cross join lateral unnest(private.hr_lifecycle_default_forms(lifecycle.lifecycle_type)) as recommended_form(form_code)
join private.hr_template_library_items library on library.form_code = recommended_form.form_code
where lifecycle.status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress')
on conflict(lifecycle_case_id, form_code) do nothing;

insert into private.hr_lifecycle_events(lifecycle_case_id, action, actor_id, reason, details)
select
  lifecycle.id,
  'guided_workflow_backfilled',
  lifecycle.requested_by,
  'Required guided checklist and approved document references were added to this pre-existing lifecycle case.',
  jsonb_build_object('systemGenerated', true, 'requiredHandoffs', 12)
from private.hr_lifecycle_cases lifecycle
where lifecycle.status in ('draft','pending_approval','approved','approved_scheduled','due','in_progress')
  and not exists (
    select 1
    from private.hr_lifecycle_events lifecycle_event
    where lifecycle_event.lifecycle_case_id = lifecycle.id
      and lifecycle_event.action = 'guided_workflow_backfilled'
  );

commit;
