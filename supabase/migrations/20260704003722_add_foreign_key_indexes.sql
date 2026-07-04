begin;

-- Foreign-key support indexes. These keep relational checks, joins, deletes,
-- and operational review queries predictable as workbook data grows.

create index if not exists employee_operational_profiles_source_mapping_decision_id_fk_idx
  on private.employee_operational_profiles (source_mapping_decision_id);

create index if not exists import_candidates_reviewed_by_fk_idx
  on private.import_candidates (reviewed_by);

create index if not exists import_entity_links_promotion_batch_id_fk_idx
  on private.import_entity_links (promotion_batch_id);

create index if not exists import_issues_candidate_id_fk_idx
  on private.import_issues (candidate_id);

create index if not exists import_issues_import_run_id_fk_idx
  on private.import_issues (import_run_id);

create index if not exists import_issues_resolved_by_fk_idx
  on private.import_issues (resolved_by);

create index if not exists import_issues_source_cell_id_fk_idx
  on private.import_issues (source_cell_id);

create index if not exists import_mapping_decisions_candidate_id_fk_idx
  on private.import_mapping_decisions (candidate_id);

create index if not exists import_mapping_decisions_decided_by_fk_idx
  on private.import_mapping_decisions (decided_by);

create index if not exists import_mapping_decisions_supersedes_id_fk_idx
  on private.import_mapping_decisions (supersedes_id);

create index if not exists import_promotion_batches_promoted_by_fk_idx
  on private.import_promotion_batches (promoted_by);

create index if not exists import_review_decisions_candidate_id_fk_idx
  on private.import_review_decisions (candidate_id);

create index if not exists import_review_decisions_decided_by_fk_idx
  on private.import_review_decisions (decided_by);

create index if not exists import_review_decisions_import_run_id_fk_idx
  on private.import_review_decisions (import_run_id);

create index if not exists import_review_decisions_issue_id_fk_idx
  on private.import_review_decisions (issue_id);

create index if not exists import_runs_promoted_by_fk_idx
  on private.import_runs (promoted_by);

create index if not exists import_runs_source_file_id_fk_idx
  on private.import_runs (source_file_id);

create index if not exists notification_outbox_recipient_employee_id_fk_idx
  on private.notification_outbox (recipient_employee_id);

create index if not exists site_secrets_updated_by_fk_idx
  on private.site_secrets (updated_by);

create index if not exists source_annotations_source_sheet_id_fk_idx
  on private.source_annotations (source_sheet_id);

create index if not exists source_files_received_by_fk_idx
  on private.source_files (received_by);

create index if not exists source_links_import_run_id_fk_idx
  on private.source_links (import_run_id);

create index if not exists source_links_source_cell_id_fk_idx
  on private.source_links (source_cell_id);

create index if not exists announcements_created_by_fk_idx
  on public.announcements (created_by);

create index if not exists announcements_event_id_fk_idx
  on public.announcements (event_id);

create index if not exists announcements_shift_id_fk_idx
  on public.announcements (shift_id);

create index if not exists call_off_reports_announcement_id_fk_idx
  on public.call_off_reports (announcement_id);

create index if not exists call_off_reports_acknowledged_by_fk_idx
  on public.call_off_reports (acknowledged_by);

create index if not exists call_off_reports_employee_id_fk_idx
  on public.call_off_reports (employee_id);

create index if not exists employee_credentials_verified_by_fk_idx
  on public.employee_credentials (verified_by);

create index if not exists events_created_by_fk_idx
  on public.events (created_by);

create index if not exists events_site_id_fk_idx
  on public.events (site_id);

create index if not exists schedules_created_by_fk_idx
  on public.schedules (created_by);

create index if not exists schedules_previous_revision_id_fk_idx
  on public.schedules (previous_revision_id);

create index if not exists schedules_published_by_fk_idx
  on public.schedules (published_by);

create index if not exists shift_assignments_assigned_by_fk_idx
  on public.shift_assignments (assigned_by);

create index if not exists shift_requests_decided_by_fk_idx
  on public.shift_requests (decided_by);

create index if not exists shift_requests_employee_id_fk_idx
  on public.shift_requests (employee_id);

create index if not exists shifts_created_by_fk_idx
  on public.shifts (created_by);

create index if not exists shifts_event_id_fk_idx
  on public.shifts (event_id);

create index if not exists shifts_post_id_fk_idx
  on public.shifts (post_id);

create index if not exists time_event_corrections_approved_by_fk_idx
  on public.time_event_corrections (approved_by);

create index if not exists time_event_corrections_requested_by_fk_idx
  on public.time_event_corrections (requested_by);

create index if not exists time_event_corrections_time_event_id_fk_idx
  on public.time_event_corrections (time_event_id);

create index if not exists time_events_created_by_fk_idx
  on public.time_events (created_by);

create index if not exists time_off_requests_decided_by_fk_idx
  on public.time_off_requests (decided_by);

commit;
