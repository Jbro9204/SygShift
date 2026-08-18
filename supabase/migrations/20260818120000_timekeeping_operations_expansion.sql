begin;

-- Dedicated permissions keep the operations workflows independently assignable
-- through the existing Roles & Permissions workspace.
insert into public.permission_catalog (
  code,
  category,
  name,
  description,
  risk_level,
  requires_mfa,
  locked,
  active
)
values
  ('accountability.report_call_off', 'Accountability', 'Report Sick / Call-Off', 'Report a sick or other call-off for an employee and scheduled shift.', 'critical', true, false, true),
  ('time.manual_entry.create', 'Time & Attendance', 'Create Manual Time Entry', 'Create a complete audited clock-in and clock-out pair.', 'critical', true, false, true),
  ('time.manual_entry.edit', 'Time & Attendance', 'Edit Manual Time Entry', 'Correct an existing manual time entry without replacing its source punches.', 'critical', true, false, true),
  ('time.adjustments.review', 'Time & Attendance', 'Review Time Adjustments', 'Review and decide employee time-adjustment requests.', 'critical', true, false, true),
  ('time.reports.view', 'Time & Attendance', 'View Timekeeping Reports', 'View protected operational timekeeping and attendance reports.', 'sensitive', true, false, true)
on conflict (code) do update
set
  category = excluded.category,
  name = excluded.name,
  description = excluded.description,
  risk_level = excluded.risk_level,
  requires_mfa = excluded.requires_mfa,
  locked = excluded.locked,
  active = true,
  updated_at = clock_timestamp();

with defaults(role_code, permission_code) as (
  values
    ('system_dispatcher', 'accountability.report_call_off'),
    ('system_scheduler', 'accountability.report_call_off'),
    ('system_supervisor', 'accountability.report_call_off'),
    ('system_admin', 'accountability.report_call_off'),
    ('system_supervisor', 'time.manual_entry.create'),
    ('system_admin', 'time.manual_entry.create'),
    ('system_supervisor', 'time.manual_entry.edit'),
    ('system_admin', 'time.manual_entry.edit'),
    ('system_supervisor', 'time.adjustments.review'),
    ('system_admin', 'time.adjustments.review'),
    ('system_dispatcher', 'time.reports.view'),
    ('system_scheduler', 'time.reports.view'),
    ('system_supervisor', 'time.reports.view'),
    ('system_admin', 'time.reports.view'),
    ('system_scheduler', 'schedule.publish')
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select role.id, defaults.permission_code, true
from defaults
join public.access_roles role on role.code = defaults.role_code
join public.permission_catalog permission on permission.code = defaults.permission_code
on conflict (role_id, permission_code) do update
set enabled = true, updated_at = clock_timestamp();

create table private.system_settings (
  setting_key text primary key,
  setting_value jsonb not null,
  description text not null,
  updated_by uuid references public.employees(id) on delete restrict,
  updated_at timestamptz not null default clock_timestamp(),
  constraint system_settings_key_format check (setting_key ~ '^[a-z][a-z0-9_.-]+$')
);

insert into private.system_settings (setting_key, setting_value, description)
values
  ('timekeeping.automatic_clock_out_grace_minutes', '3'::jsonb, 'Minutes after scheduled shift end before the automatic clock-out job acts.'),
  ('timekeeping.missing_clock_in_grace_minutes', '15'::jsonb, 'Minutes after scheduled shift start before a missing clock-in exception is created.'),
  ('timekeeping.long_shift_warning_minutes', '840'::jsonb, 'Manual-entry duration that requires an explicit long-shift confirmation.'),
  ('email.blocked_recipient_domains', '["guardianshipsecurity.net"]'::jsonb, 'Recipient domains that must be suppressed before the email provider is contacted.')
on conflict (setting_key) do nothing;

create table private.timekeeping_job_runs (
  id uuid primary key,
  job_name text not null,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  status text not null default 'running',
  automatic_clock_out_count integer not null default 0,
  missing_clock_in_count integer not null default 0,
  alert_count integer not null default 0,
  error_text text,
  constraint timekeeping_job_run_status check (status in ('running', 'completed', 'failed', 'skipped')),
  constraint timekeeping_job_run_counts check (automatic_clock_out_count >= 0 and missing_clock_in_count >= 0 and alert_count >= 0)
);

create table public.timekeeping_operational_exceptions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid not null references public.shifts(id) on delete restrict,
  exception_code text not null,
  status text not null default 'unresolved',
  severity text not null default 'blocking',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  detected_at timestamptz not null default clock_timestamp(),
  source_time_event_id uuid references public.time_events(id) on delete restrict,
  job_run_id uuid references private.timekeeping_job_runs(id) on delete restrict,
  resolution_method text,
  resolution_note text,
  resolved_by uuid references public.employees(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint timekeeping_operational_exception_code check (exception_code in ('missing_clock_in', 'automatic_clock_out')),
  constraint timekeeping_operational_exception_status check (status in ('unresolved', 'resolved', 'dismissed')),
  constraint timekeeping_operational_exception_severity check (severity in ('warning', 'blocking')),
  constraint timekeeping_operational_exception_resolution check (
    (status = 'unresolved' and resolved_at is null and resolved_by is null)
    or (status <> 'unresolved' and resolved_at is not null and btrim(coalesce(resolution_method, '')) <> '' and btrim(coalesce(resolution_note, '')) <> '')
  ),
  constraint timekeeping_operational_exception_unique unique (employee_id, shift_id, exception_code)
);

create index timekeeping_operational_exceptions_status_idx
  on public.timekeeping_operational_exceptions(status, detected_at desc);
create index timekeeping_operational_exceptions_employee_idx
  on public.timekeeping_operational_exceptions(employee_id, detected_at desc);

create table public.timekeeping_operational_exception_actions (
  id uuid primary key default gen_random_uuid(),
  exception_id uuid not null references public.timekeeping_operational_exceptions(id) on delete restrict,
  action text not null,
  reason text not null,
  actor_id uuid references public.employees(id) on delete restrict,
  action_at timestamptz not null default clock_timestamp(),
  snapshot jsonb not null,
  constraint timekeeping_operational_exception_action check (action in ('created', 'resolved_manual_entry', 'resolved_adjustment', 'resolved_call_off', 'resolved_shift_canceled', 'dismissed', 'reopened')),
  constraint timekeeping_operational_exception_action_reason check (btrim(reason) <> ''),
  constraint timekeeping_operational_exception_snapshot_object check (jsonb_typeof(snapshot) = 'object')
);

create table public.operational_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  priority text not null default 'high',
  title text not null,
  summary text not null,
  employee_id uuid references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  related_record_type text not null,
  related_record_id uuid not null,
  audience_roles public.app_role[] not null,
  direct_path text,
  deduplication_key text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  cleared_at timestamptz,
  cleared_by uuid references public.employees(id) on delete restrict,
  constraint operational_alert_priority check (priority in ('standard', 'high', 'urgent')),
  constraint operational_alert_title_present check (btrim(title) <> ''),
  constraint operational_alert_summary_present check (btrim(summary) <> ''),
  constraint operational_alert_roles_present check (cardinality(audience_roles) > 0)
);

create table public.operational_alert_acknowledgments (
  alert_id uuid not null references public.operational_alerts(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  acknowledged_at timestamptz not null default clock_timestamp(),
  primary key (alert_id, employee_id)
);

create index operational_alerts_active_idx on public.operational_alerts(active, created_at desc);

create table public.manual_time_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  post_id uuid references public.posts(id) on delete restrict,
  clock_in_event_id uuid not null references public.time_events(id) on delete restrict,
  clock_out_event_id uuid not null references public.time_events(id) on delete restrict,
  work_date date not null,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz not null,
  reason text not null,
  notes text,
  approval_status text not null default 'approved',
  warning_codes text[] not null default '{}'::text[],
  warning_confirmation text,
  entry_source text not null default 'operations',
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  last_edited_by uuid references public.employees(id) on delete restrict,
  last_edited_at timestamptz,
  constraint manual_time_entry_order check (clock_out_at > clock_in_at),
  constraint manual_time_entry_reason check (btrim(reason) <> ''),
  constraint manual_time_entry_status check (approval_status in ('approved', 'pending', 'rejected')),
  constraint manual_time_entry_source check (entry_source in ('operations', 'adjustment_request', 'system'))
);

create table public.manual_time_entry_history (
  id uuid primary key default gen_random_uuid(),
  manual_entry_id uuid not null references public.manual_time_entries(id) on delete restrict,
  action text not null,
  before_values jsonb,
  after_values jsonb not null,
  reason text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint manual_time_entry_history_action check (action in ('created', 'edited', 'approved', 'rejected')),
  constraint manual_time_entry_history_reason check (btrim(reason) <> ''),
  constraint manual_time_entry_history_after_object check (jsonb_typeof(after_values) = 'object')
);

create index manual_time_entries_employee_date_idx on public.manual_time_entries(employee_id, work_date desc);

create table public.time_adjustment_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  shift_id uuid references public.shifts(id) on delete restrict,
  work_date date not null,
  issue_type text not null,
  requested_clock_in_at timestamptz,
  requested_clock_out_at timestamptz,
  reason text not null,
  notes text,
  status text not null default 'submitted',
  submitted_by uuid not null references public.employees(id) on delete restrict,
  submitted_at timestamptz not null default clock_timestamp(),
  reviewer_id uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  decision_note text,
  related_manual_entry_id uuid references public.manual_time_entries(id) on delete restrict,
  canceled_at timestamptz,
  constraint time_adjustment_issue_type check (issue_type in ('clock_in', 'clock_out', 'both_punches', 'missing_shift', 'other')),
  constraint time_adjustment_status check (status in ('submitted', 'under_review', 'approved', 'partially_approved', 'rejected', 'canceled')),
  constraint time_adjustment_reason check (btrim(reason) <> ''),
  constraint time_adjustment_time_order check (requested_clock_in_at is null or requested_clock_out_at is null or requested_clock_out_at > requested_clock_in_at)
);

create table public.time_adjustment_request_actions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.time_adjustment_requests(id) on delete restrict,
  action text not null,
  note text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  snapshot jsonb not null,
  constraint time_adjustment_request_action check (action in ('submitted', 'under_review', 'approved', 'partially_approved', 'rejected', 'canceled')),
  constraint time_adjustment_request_action_note check (btrim(note) <> ''),
  constraint time_adjustment_request_action_snapshot check (jsonb_typeof(snapshot) = 'object')
);

create index time_adjustment_requests_employee_idx on public.time_adjustment_requests(employee_id, submitted_at desc);
create index time_adjustment_requests_status_idx on public.time_adjustment_requests(status, submitted_at);

create table private.email_delivery_audit (
  id uuid primary key default gen_random_uuid(),
  notification_type text not null,
  related_record_type text,
  related_record_id uuid,
  intended_recipient text not null,
  delivery_status text not null,
  provider_reference text,
  failure_detail text,
  attempted_at timestamptz not null default clock_timestamp(),
  constraint email_delivery_audit_status check (delivery_status in ('sent', 'failed', 'suppressed_blocked_domain')),
  constraint email_delivery_audit_recipient check (btrim(intended_recipient) <> '')
);

create index email_delivery_audit_record_idx
  on private.email_delivery_audit(related_record_type, related_record_id, attempted_at desc);

alter table public.call_off_reports
  add column if not exists call_received_at timestamptz,
  add column if not exists received_by uuid references public.employees(id) on delete restrict,
  add column if not exists reported_by uuid references public.employees(id) on delete restrict,
  add column if not exists call_off_type text,
  add column if not exists replacement_needed boolean not null default true,
  add column if not exists operational_details text,
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by uuid references public.employees(id) on delete restrict,
  add column if not exists cancellation_note text;

create table public.call_off_report_actions (
  id uuid primary key default gen_random_uuid(),
  call_off_report_id uuid not null references public.call_off_reports(id) on delete restrict,
  action text not null,
  reason text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint call_off_report_action check (action in ('created', 'updated', 'canceled', 'acknowledged', 'resolved')),
  constraint call_off_report_action_reason check (btrim(reason) <> ''),
  constraint call_off_report_action_snapshot check (jsonb_typeof(snapshot) = 'object')
);

alter table public.time_event_maintenance_notes drop constraint if exists time_event_maintenance_notes_action;
alter table public.time_event_maintenance_notes alter column created_by drop not null;
alter table public.time_event_maintenance_notes
  add constraint time_event_maintenance_notes_action
  check (action in ('manual_add', 'time_adjust', 'void', 'location_update', 'site_post_update', 'automatic_clock_out'));

-- Protected data is exposed only through permission-aware RPCs.
alter table public.timekeeping_operational_exceptions enable row level security;
alter table public.timekeeping_operational_exception_actions enable row level security;
alter table public.operational_alerts enable row level security;
alter table public.operational_alert_acknowledgments enable row level security;
alter table public.manual_time_entries enable row level security;
alter table public.manual_time_entry_history enable row level security;
alter table public.time_adjustment_requests enable row level security;
alter table public.time_adjustment_request_actions enable row level security;
alter table public.call_off_report_actions enable row level security;

revoke all on table public.timekeeping_operational_exceptions from public, anon, authenticated;
revoke all on table public.timekeeping_operational_exception_actions from public, anon, authenticated;
revoke all on table public.operational_alerts from public, anon, authenticated;
revoke all on table public.operational_alert_acknowledgments from public, anon, authenticated;
revoke all on table public.manual_time_entries from public, anon, authenticated;
revoke all on table public.manual_time_entry_history from public, anon, authenticated;
revoke all on table public.time_adjustment_requests from public, anon, authenticated;
revoke all on table public.time_adjustment_request_actions from public, anon, authenticated;
revoke all on table public.call_off_report_actions from public, anon, authenticated;
revoke all on table private.system_settings from public, anon, authenticated;
revoke all on table private.timekeeping_job_runs from public, anon, authenticated;
revoke all on table private.email_delivery_audit from public, anon, authenticated;

create trigger timekeeping_operational_exception_actions_append_only
before update or delete on public.timekeeping_operational_exception_actions
for each row execute function private.prevent_append_only_change();
create trigger manual_time_entry_history_append_only
before update or delete on public.manual_time_entry_history
for each row execute function private.prevent_append_only_change();
create trigger time_adjustment_request_actions_append_only
before update or delete on public.time_adjustment_request_actions
for each row execute function private.prevent_append_only_change();
create trigger call_off_report_actions_append_only
before update or delete on public.call_off_report_actions
for each row execute function private.prevent_append_only_change();

create trigger timekeeping_operational_exceptions_audit
after insert or update on public.timekeeping_operational_exceptions
for each row execute function private.write_audit_event();
create trigger operational_alerts_audit
after insert or update on public.operational_alerts
for each row execute function private.write_audit_event();
create trigger operational_alert_acknowledgments_audit
after insert on public.operational_alert_acknowledgments
for each row execute function private.write_audit_event();
create trigger manual_time_entries_audit
after insert or update on public.manual_time_entries
for each row execute function private.write_audit_event();
create trigger time_adjustment_requests_audit
after insert or update on public.time_adjustment_requests
for each row execute function private.write_audit_event();
create trigger call_off_reports_operations_audit
after insert or update on public.call_off_report_actions
for each row execute function private.write_audit_event();

create or replace function private.current_effective_time_event(target_event_id uuid)
returns table(effective_at timestamptz, voided boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(correction.replacement_time, event.recorded_at) as effective_at,
    coalesce(correction.voided, false) as voided
  from public.time_events event
  left join lateral (
    select item.replacement_time, item.voided
    from public.time_event_corrections item
    where item.time_event_id = event.id
      and item.approved_at is not null
    order by item.approved_at desc, item.created_at desc, item.id desc
    limit 1
  ) correction on true
  where event.id = target_event_id
$$;

create or replace function private.timekeeping_setting_integer(target_key text, fallback_value integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, coalesce(
    (select case when jsonb_typeof(setting.setting_value) = 'number' then (setting.setting_value #>> '{}')::integer end
     from private.system_settings setting
     where setting.setting_key = target_key),
    fallback_value
  ))
$$;

create or replace function public.service_run_timekeeping_automation(target_job_run_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  automatic_grace integer := private.timekeeping_setting_integer('timekeeping.automatic_clock_out_grace_minutes', 3);
  clock_in_grace integer := private.timekeeping_setting_integer('timekeeping.missing_clock_in_grace_minutes', 15);
  automatic_count integer := 0;
  missing_count integer := 0;
  created_alert_count integer := 0;
  locked boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  if target_job_run_id is null then
    raise check_violation using message = 'A job run identifier is required.';
  end if;

  insert into private.timekeeping_job_runs (id, job_name)
  values (target_job_run_id, 'timekeeping_operations')
  on conflict (id) do nothing;

  if not found then
    return jsonb_build_object('jobRunId', target_job_run_id, 'status', 'duplicate', 'automaticClockOutCount', 0, 'missingClockInCount', 0, 'alertCount', 0);
  end if;

  select pg_try_advisory_xact_lock(hashtext('sygshift.timekeeping.operations')) into locked;
  if not locked then
    update private.timekeeping_job_runs set status = 'skipped', completed_at = clock_timestamp() where id = target_job_run_id;
    return jsonb_build_object('jobRunId', target_job_run_id, 'status', 'skipped', 'automaticClockOutCount', 0, 'missingClockInCount', 0, 'alertCount', 0);
  end if;

  with candidates as (
    select
      assignment.id as assignment_id,
      assignment.employee_id,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at,
      coalesce(shift.time_zone, 'America/Denver') as time_zone,
      site.name as site_name,
      post.name as post_name,
      schedule_event.name as event_name,
      latest.id as latest_event_id,
      latest.kind as latest_kind,
      latest.effective_at as latest_effective_at
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
    join public.employees employee on employee.id = assignment.employee_id and employee.status = 'active'
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    left join lateral (
      select event.id, event.kind, effective.effective_at
      from public.time_events event
      cross join lateral private.current_effective_time_event(event.id) effective
      where event.employee_id = assignment.employee_id
        and event.shift_id = shift.id
        and not effective.voided
      order by effective.effective_at desc, event.recorded_at desc, event.id desc
      limit 1
    ) latest on true
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.ends_at + make_interval(mins => automatic_grace) <= clock_timestamp()
      and shift.ends_at >= clock_timestamp() - interval '7 days'
      and latest.kind in ('clock_in', 'break_start', 'break_end')
      and latest.effective_at <= shift.ends_at
  ), inserted_events as (
    insert into public.time_events (
      employee_id,
      shift_id,
      kind,
      recorded_at,
      client_recorded_at,
      source,
      idempotency_key,
      created_by
    )
    select
      candidate.employee_id,
      candidate.shift_id,
      'clock_out'::public.time_event_kind,
      candidate.ends_at,
      null,
      'system'::public.time_event_source,
      concat('automatic-clock-out:', candidate.assignment_id, ':', extract(epoch from candidate.ends_at)::bigint),
      null
    from candidates candidate
    where not exists (
      select 1
      from public.time_events existing
      cross join lateral private.current_effective_time_event(existing.id) effective
      where existing.employee_id = candidate.employee_id
        and existing.shift_id = candidate.shift_id
        and existing.kind = 'clock_out'
        and not effective.voided
        and effective.effective_at >= candidate.latest_effective_at
    )
    on conflict (idempotency_key) do nothing
    returning *
  ), inserted_notes as (
    insert into public.time_event_maintenance_notes (time_event_id, action, note, created_by)
    select event.id, 'automatic_clock_out', 'Automatically clocked out at the scheduled shift end because SygShift did not receive a clock-out punch.', null
    from inserted_events event
    returning time_event_id
  ), inserted_exceptions as (
    insert into public.timekeeping_operational_exceptions (
      employee_id,
      shift_id,
      exception_code,
      status,
      severity,
      scheduled_start_at,
      scheduled_end_at,
      source_time_event_id,
      job_run_id
    )
    select event.employee_id, event.shift_id, 'automatic_clock_out', 'unresolved', 'warning', shift.starts_at, shift.ends_at, event.id, target_job_run_id
    from inserted_events event
    join public.shifts shift on shift.id = event.shift_id
    on conflict (employee_id, shift_id, exception_code) do nothing
    returning *
  ), inserted_actions as (
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select exception.id, 'created', 'The scheduled automation created an automatic clock-out review item.', null, to_jsonb(exception)
    from inserted_exceptions exception
    returning exception_id
  ), inserted_outbox as (
    insert into private.notification_outbox (
      message_type,
      aggregate_type,
      aggregate_id,
      recipient_employee_id,
      payload,
      idempotency_key
    )
    select
      'automatic_clock_out_employee',
      'timekeeping_operational_exception',
      exception.id,
      exception.employee_id,
      jsonb_build_object('scheduledEndAt', exception.scheduled_end_at, 'shiftId', exception.shift_id),
      concat('automatic-clock-out-employee:', exception.id)
    from inserted_exceptions exception
    on conflict (idempotency_key) do nothing
    returning id
  )
  select count(*) into automatic_count from inserted_events;

  with missing_candidates as (
    select
      assignment.employee_id,
      shift.id as shift_id,
      shift.starts_at,
      shift.ends_at
    from public.shift_assignments assignment
    join public.shifts shift on shift.id = assignment.shift_id
    join public.schedules schedule on schedule.id = shift.schedule_id and schedule.status = 'published'
    join public.employees employee on employee.id = assignment.employee_id and employee.status = 'active'
    where assignment.status in ('assigned', 'confirmed')
      and shift.canceled_at is null
      and shift.starts_at + make_interval(mins => clock_in_grace) <= clock_timestamp()
      and shift.starts_at >= clock_timestamp() - interval '7 days'
      and not exists (
        select 1
        from public.time_events event
        cross join lateral private.current_effective_time_event(event.id) effective
        where event.employee_id = assignment.employee_id
          and event.shift_id = shift.id
          and event.kind = 'clock_in'
          and not effective.voided
      )
      and not exists (
        select 1 from public.call_off_reports report
        where report.employee_id = assignment.employee_id
          and report.shift_id = shift.id
          and report.canceled_at is null
      )
  ), inserted_exceptions as (
    insert into public.timekeeping_operational_exceptions (
      employee_id,
      shift_id,
      exception_code,
      status,
      severity,
      scheduled_start_at,
      scheduled_end_at,
      job_run_id
    )
    select candidate.employee_id, candidate.shift_id, 'missing_clock_in', 'unresolved', 'blocking', candidate.starts_at, candidate.ends_at, target_job_run_id
    from missing_candidates candidate
    on conflict (employee_id, shift_id, exception_code) do nothing
    returning *
  ), inserted_actions as (
    insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
    select exception.id, 'created', 'No clock-in punch was received within the configured grace period.', null, to_jsonb(exception)
    from inserted_exceptions exception
    returning exception_id
  )
  select count(*) into missing_count from inserted_exceptions;

  with created_alerts as (
    insert into public.operational_alerts (
      alert_type,
      priority,
      title,
      summary,
      employee_id,
      shift_id,
      related_record_type,
      related_record_id,
      audience_roles,
      direct_path,
      deduplication_key
    )
    select
      exception.exception_code,
      case when exception.exception_code = 'missing_clock_in' then 'urgent' else 'high' end,
      case when exception.exception_code = 'missing_clock_in' then 'Missing clock-in' else 'Automatic clock-out recorded' end,
      concat(coalesce(employee.preferred_name, employee.first_name), ' ', employee.last_name, ' · ', coalesce(site.name, post.name, schedule_event.name, 'Scheduled shift')),
      exception.employee_id,
      exception.shift_id,
      'timekeeping_operational_exception',
      exception.id,
      array['dispatcher', 'scheduler', 'supervisor', 'admin']::public.app_role[],
      concat('/time/exceptions?operationalException=', exception.id),
      concat('timekeeping-exception:', exception.id)
    from public.timekeeping_operational_exceptions exception
    join public.employees employee on employee.id = exception.employee_id
    join public.shifts shift on shift.id = exception.shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites site on site.id = post.site_id
    left join public.events schedule_event on schedule_event.id = shift.event_id
    where exception.job_run_id = target_job_run_id
    on conflict (deduplication_key) do nothing
    returning id
  )
  select count(*) into created_alert_count from created_alerts;

  -- A valid punch, call-off, or canceled shift resolves the missing-clock-in
  -- occurrence without deleting the original exception or its action history.
  with resolved as (
    update public.timekeeping_operational_exceptions exception
    set
      status = 'resolved',
      resolution_method = case
        when shift.canceled_at is not null then 'shift_canceled'
        when exists (select 1 from public.call_off_reports report where report.shift_id = exception.shift_id and report.employee_id = exception.employee_id and report.canceled_at is null) then 'call_off'
        else 'clock_in_received'
      end,
      resolution_note = 'Resolved automatically from the authoritative schedule or attendance record.',
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from public.shifts shift
    where exception.shift_id = shift.id
      and exception.exception_code = 'missing_clock_in'
      and exception.status = 'unresolved'
      and (
        shift.canceled_at is not null
        or exists (select 1 from public.call_off_reports report where report.shift_id = exception.shift_id and report.employee_id = exception.employee_id and report.canceled_at is null)
        or exists (
          select 1 from public.time_events event
          cross join lateral private.current_effective_time_event(event.id) effective
          where event.shift_id = exception.shift_id
            and event.employee_id = exception.employee_id
            and event.kind = 'clock_in'
            and not effective.voided
        )
      )
    returning exception.*
  )
  insert into public.timekeeping_operational_exception_actions (exception_id, action, reason, actor_id, snapshot)
  select
    resolved.id,
    case resolved.resolution_method when 'call_off' then 'resolved_call_off' when 'shift_canceled' then 'resolved_shift_canceled' else 'resolved_manual_entry' end,
    resolved.resolution_note,
    null,
    to_jsonb(resolved)
  from resolved;

  update private.timekeeping_job_runs
  set
    completed_at = clock_timestamp(),
    status = 'completed',
    automatic_clock_out_count = automatic_count,
    missing_clock_in_count = missing_count,
    alert_count = created_alert_count
  where id = target_job_run_id;

  return jsonb_build_object(
    'jobRunId', target_job_run_id,
    'status', 'completed',
    'automaticClockOutCount', automatic_count,
    'missingClockInCount', missing_count,
    'alertCount', created_alert_count
  );
exception when others then
  update private.timekeeping_job_runs
  set completed_at = clock_timestamp(), status = 'failed', error_text = left(sqlerrm, 1000)
  where id = target_job_run_id;
  raise;
end
$$;

create or replace function public.service_log_email_delivery(
  target_notification_type text,
  target_related_record_type text,
  target_related_record_id uuid,
  target_intended_recipient text,
  target_delivery_status text,
  target_provider_reference text default null,
  target_failure_detail text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  inserted_id uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  insert into private.email_delivery_audit (
    notification_type,
    related_record_type,
    related_record_id,
    intended_recipient,
    delivery_status,
    provider_reference,
    failure_detail
  ) values (
    left(btrim(target_notification_type), 100),
    nullif(left(btrim(coalesce(target_related_record_type, '')), 100), ''),
    target_related_record_id,
    lower(btrim(target_intended_recipient)),
    target_delivery_status,
    nullif(left(btrim(coalesce(target_provider_reference, '')), 200), ''),
    nullif(left(btrim(coalesce(target_failure_detail, '')), 500), '')
  ) returning id into inserted_id;
  return inserted_id;
end
$$;

create or replace function public.service_mark_notification_suppressed(
  target_notification_id uuid,
  target_reason text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role is required.';
  end if;
  update private.notification_outbox
  set failed_at = clock_timestamp(), last_error = left(coalesce(nullif(btrim(target_reason), ''), 'Suppressed — Blocked Domain'), 1000)
  where id = target_notification_id and delivered_at is null;
end
$$;

revoke all on function private.current_effective_time_event(uuid) from public, anon, authenticated;
revoke all on function private.timekeeping_setting_integer(text, integer) from public, anon, authenticated;
revoke all on function public.service_run_timekeeping_automation(uuid) from public, anon, authenticated;
revoke all on function public.service_log_email_delivery(text, text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.service_mark_notification_suppressed(uuid, text) from public, anon, authenticated;
grant execute on function public.service_run_timekeeping_automation(uuid) to service_role;
grant execute on function public.service_log_email_delivery(text, text, uuid, text, text, text, text) to service_role;
grant execute on function public.service_mark_notification_suppressed(uuid, text) to service_role;

notify pgrst, 'reload schema';

commit;
