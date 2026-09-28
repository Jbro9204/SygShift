begin;

-- A regular published vacancy can be covered with a bounded Patrol plan without
-- turning the vacancy into an employee absence or mutating the published shift.
create temporary table vacancy_patrol_preservation_baseline on commit drop as
select
  (select count(*) from public.shifts) as shift_count,
  (select count(*) from public.shift_assignments) as shift_assignment_count,
  (select count(*) from public.call_off_reports) as call_off_count,
  (select count(*) from public.attendance_accountability_events) as attendance_occurrence_count,
  (select count(*) from public.time_events) as time_event_count;

insert into public.permission_catalog (
  code, category, name, description, risk_level, requires_mfa, locked, active
)
values
  (
    'patrol.recovery.request', 'Patrol', 'Request patrol vacancy recovery',
    'Request a bounded Patrol service plan for an unassigned published shift without creating an absence.',
    'sensitive', true, true, true
  ),
  (
    'patrol.recovery.finance.view', 'Patrol', 'View patrol recovery billing',
    'View completed vacancy-recovery service and its Finance disposition.',
    'critical', true, true, true
  ),
  (
    'patrol.recovery.billing.review', 'Patrol', 'Review patrol recovery billing',
    'Record the reviewed billing disposition for completed Patrol vacancy recovery.',
    'critical', true, true, true
  ),
  (
    'patrol.recovery.finance.export', 'Patrol', 'Export patrol recovery billing',
    'Authorize an audited export of Patrol vacancy-recovery Finance reporting.',
    'critical', true, true, true
  )
on conflict (code) do update
set category = excluded.category,
    name = excluded.name,
    description = excluded.description,
    risk_level = excluded.risk_level,
    requires_mfa = excluded.requires_mfa,
    locked = excluded.locked,
    active = true,
    updated_at = clock_timestamp();

insert into public.access_role_permissions (role_id, permission_code, enabled)
select access_role.id, 'patrol.recovery.request', true
from public.access_roles access_role
where access_role.code in ('system_dispatcher', 'system_scheduler', 'system_admin')
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

with finance_roles as (
  select distinct role_permission.role_id
  from public.access_role_permissions role_permission
  where role_permission.enabled
    and role_permission.permission_code in (
      'time.export_payroll',
      'hr.payroll_integration.view',
      'hr.payroll_integration.manage',
      'hr.payroll_integration.approve',
      'hr.payroll_integration.reconcile'
    )
  union
  select access_role.id
  from public.access_roles access_role
  where access_role.code = 'system_admin'
), finance_permissions(permission_code) as (
  values
    ('patrol.recovery.finance.view'::text),
    ('patrol.recovery.billing.review'::text),
    ('patrol.recovery.finance.export'::text)
)
insert into public.access_role_permissions (role_id, permission_code, enabled)
select finance_role.role_id, finance_permission.permission_code, true
from finance_roles finance_role
cross join finance_permissions finance_permission
on conflict (role_id, permission_code) do update
set enabled = true,
    updated_at = clock_timestamp();

create sequence public.vacancy_patrol_recovery_request_number_seq;
revoke all on sequence public.vacancy_patrol_recovery_request_number_seq from public, anon, authenticated;

create table public.vacancy_patrol_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  request_number text not null unique default (
    'VPR-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
    lpad(nextval('public.vacancy_patrol_recovery_request_number_seq'::regclass)::text, 6, '0')
  ),
  source_shift_id uuid not null unique references public.shifts(id) on delete restrict,
  requested_route_id uuid not null references public.patrol_routes(id) on delete restrict,
  requested_route_version_id uuid not null references public.patrol_route_versions(id) on delete restrict,
  accepted_route_id uuid references public.patrol_routes(id) on delete restrict,
  accepted_route_version_id uuid references public.patrol_route_versions(id) on delete restrict,
  patrol_assignment_id uuid unique references public.patrol_assignments(id) on delete restrict,
  assigned_employee_id uuid references public.employees(id) on delete restrict,
  status text not null default 'requested',
  reason text not null,
  current_plan_version integer not null default 1,
  requested_by uuid not null references public.employees(id) on delete restrict,
  requested_at timestamptz not null default clock_timestamp(),
  accepted_by uuid references public.employees(id) on delete restrict,
  accepted_at timestamptz,
  acceptance_note text,
  completed_at timestamptz,
  closed_by uuid references public.employees(id) on delete restrict,
  closed_at timestamptz,
  closure_note text,
  billing_disposition text not null default 'pending_review',
  billing_reference text,
  billing_reason text,
  billing_reviewed_by uuid references public.employees(id) on delete restrict,
  billing_reviewed_at timestamptz,
  idempotency_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint vacancy_patrol_request_number_format
    check (request_number ~ '^VPR-[0-9]{8}-[0-9]{6,}$'),
  constraint vacancy_patrol_request_status_check
    check (status in ('requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled')),
  constraint vacancy_patrol_request_reason_check
    check (char_length(btrim(reason)) between 10 and 1000),
  constraint vacancy_patrol_request_plan_version_check
    check (current_plan_version > 0),
  constraint vacancy_patrol_request_route_pair_check
    check (num_nonnulls(accepted_route_id, accepted_route_version_id) in (0, 2)),
  constraint vacancy_patrol_request_acceptance_check
    check (
      status not in ('patrol_planned', 'in_progress', 'completed')
      or (
        accepted_route_id is not null
        and accepted_route_version_id is not null
        and patrol_assignment_id is not null
        and assigned_employee_id is not null
        and accepted_by is not null
        and accepted_at is not null
      )
    ),
  constraint vacancy_patrol_request_completion_check
    check ((status = 'completed') = (completed_at is not null)),
  constraint vacancy_patrol_request_closure_check
    check (
      status not in ('declined', 'canceled')
      or (closed_by is not null and closed_at is not null and char_length(btrim(coalesce(closure_note, ''))) >= 5)
    ),
  constraint vacancy_patrol_billing_disposition_check
    check (billing_disposition in (
      'pending_review', 'bill_separately', 'included_in_contract', 'non_billable', 'duplicate_suppressed'
    )),
  constraint vacancy_patrol_billing_review_check
    check (
      (billing_disposition = 'pending_review'
        and billing_reviewed_by is null
        and billing_reviewed_at is null
        and billing_reason is null)
      or
      (billing_disposition <> 'pending_review'
        and billing_reviewed_by is not null
        and billing_reviewed_at is not null
        and char_length(btrim(coalesce(billing_reason, ''))) >= 5)
    ),
  constraint vacancy_patrol_bill_separately_reference_check
    check (
      billing_disposition <> 'bill_separately'
      or char_length(btrim(coalesce(billing_reference, ''))) between 3 and 120
    ),
  constraint vacancy_patrol_request_idempotency_unique unique (requested_by, idempotency_key)
);

create unique index vacancy_patrol_billing_reference_unique
  on public.vacancy_patrol_recovery_requests (
    lower(regexp_replace(btrim(billing_reference), '\s+', '', 'g'))
  )
  where billing_disposition = 'bill_separately';
create index vacancy_patrol_requests_status_idx
  on public.vacancy_patrol_recovery_requests(status, requested_at desc);
create index vacancy_patrol_requests_billing_idx
  on public.vacancy_patrol_recovery_requests(billing_disposition, completed_at desc);

create table public.vacancy_patrol_recovery_hit_windows (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.vacancy_patrol_recovery_requests(id) on delete restrict,
  plan_version integer not null,
  sequence_number integer not null,
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  planned_hits integer not null,
  superseded_at timestamptz,
  superseded_by uuid references public.employees(id) on delete restrict,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  constraint vacancy_patrol_window_plan_version_check check (plan_version > 0),
  constraint vacancy_patrol_window_sequence_check check (sequence_number > 0),
  constraint vacancy_patrol_window_time_order_check check (window_end_at > window_start_at),
  constraint vacancy_patrol_window_hits_check check (planned_hits between 1 and 25),
  constraint vacancy_patrol_window_superseded_pair_check
    check (num_nonnulls(superseded_at, superseded_by) in (0, 2)),
  constraint vacancy_patrol_window_unique unique (request_id, plan_version, sequence_number)
);

create index vacancy_patrol_windows_request_idx
  on public.vacancy_patrol_recovery_hit_windows(request_id, plan_version, sequence_number);
create index vacancy_patrol_windows_active_idx
  on public.vacancy_patrol_recovery_hit_windows(request_id, window_start_at)
  where superseded_at is null;

create table public.vacancy_patrol_recovery_status_history (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.vacancy_patrol_recovery_requests(id) on delete restrict,
  action text not null,
  from_status text,
  to_status text not null,
  note text,
  actor_employee_id uuid references public.employees(id) on delete restrict,
  idempotency_key uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint vacancy_patrol_history_action_check
    check (action in (
      'requested', 'plan_updated', 'accepted', 'patrol_progress', 'completed',
      'declined', 'canceled', 'reconciled', 'billing_reviewed'
    )),
  constraint vacancy_patrol_history_from_status_check
    check (from_status is null or from_status in (
      'requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled'
    )),
  constraint vacancy_patrol_history_to_status_check
    check (to_status in (
      'requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled'
    )),
  constraint vacancy_patrol_history_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create unique index vacancy_patrol_history_idempotency_unique
  on public.vacancy_patrol_recovery_status_history(actor_employee_id, idempotency_key)
  where actor_employee_id is not null and idempotency_key is not null;
create index vacancy_patrol_history_request_idx
  on public.vacancy_patrol_recovery_status_history(request_id, created_at, id);

create trigger vacancy_patrol_recovery_status_history_append_only
before update or delete on public.vacancy_patrol_recovery_status_history
for each row execute function private.prevent_append_only_change();

alter table public.patrol_hit_obligations
  add column source text not null default 'route_plan',
  add column recovery_hit_window_id uuid references public.vacancy_patrol_recovery_hit_windows(id) on delete restrict,
  add constraint patrol_hit_obligations_source_check
    check (source in ('route_plan', 'vacancy_recovery')),
  add constraint patrol_hit_obligations_recovery_source_check
    check ((source = 'vacancy_recovery') = (recovery_hit_window_id is not null));

create index patrol_obligations_recovery_window_idx
  on public.patrol_hit_obligations(recovery_hit_window_id, status)
  where recovery_hit_window_id is not null;

alter table public.vacancy_patrol_recovery_requests enable row level security;
alter table public.vacancy_patrol_recovery_requests force row level security;
alter table public.vacancy_patrol_recovery_hit_windows enable row level security;
alter table public.vacancy_patrol_recovery_hit_windows force row level security;
alter table public.vacancy_patrol_recovery_status_history enable row level security;
alter table public.vacancy_patrol_recovery_status_history force row level security;

revoke all on table public.vacancy_patrol_recovery_requests from public, anon, authenticated;
revoke all on table public.vacancy_patrol_recovery_hit_windows from public, anon, authenticated;
revoke all on table public.vacancy_patrol_recovery_status_history from public, anon, authenticated;

create or replace function private.vacancy_patrol_can_request()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('patrol.recovery.request')
$$;

create or replace function private.vacancy_patrol_can_manage()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('patrol.assignments.manage')
$$;

create or replace function private.vacancy_patrol_can_view_finance()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('patrol.recovery.finance.view')
$$;

create or replace function private.vacancy_patrol_can_review_billing()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('patrol.recovery.billing.review')
$$;

create or replace function private.vacancy_patrol_can_export_finance()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_effective_permission('patrol.recovery.finance.export')
$$;

create or replace function private.vacancy_patrol_display_stage(
  target_status text,
  target_billing_disposition text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when target_status = 'declined' then 'declined'
    when target_status = 'canceled' then 'canceled'
    when target_status = 'completed' and target_billing_disposition <> 'pending_review' then 'finance_reviewed'
    when target_status = 'completed' then 'completed'
    when target_status = 'in_progress' then 'partial'
    when target_status = 'patrol_planned' then 'patrol_planned'
    else 'requested'
  end
$$;

create or replace function private.normalize_vacancy_patrol_hit_windows(
  target_hit_windows jsonb,
  target_shift_starts_at timestamptz,
  target_shift_ends_at timestamptz
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  item jsonb;
  normalized jsonb := '[]'::jsonb;
  window_start_at timestamptz;
  window_end_at timestamptz;
  prior_window_end_at timestamptz;
  planned_hits integer;
  total_hits integer := 0;
  item_count integer;
begin
  if target_shift_starts_at is null
     or target_shift_ends_at is null
     or target_shift_ends_at <= target_shift_starts_at then
    raise check_violation using message = 'The vacancy shift has an invalid service window.';
  end if;
  if jsonb_typeof(target_hit_windows) is distinct from 'array' then
    raise check_violation using message = 'Patrol hit windows must be a JSON array.';
  end if;

  item_count := jsonb_array_length(target_hit_windows);
  if item_count < 1 or item_count > 24 then
    raise check_violation using message = 'Choose between 1 and 24 Patrol hit windows.';
  end if;

  begin
    for item in
      select window_item.value
      from jsonb_array_elements(target_hit_windows) window_item(value)
      order by (window_item.value ->> 'windowStartAt')::timestamptz,
               (window_item.value ->> 'windowEndAt')::timestamptz
    loop
      window_start_at := nullif(item ->> 'windowStartAt', '')::timestamptz;
      window_end_at := nullif(item ->> 'windowEndAt', '')::timestamptz;
      planned_hits := nullif(item ->> 'plannedHits', '')::integer;

      if window_start_at is null or window_end_at is null or planned_hits is null then
        raise check_violation using message = 'Every Patrol hit window needs a start, end, and planned hit count.';
      end if;
      if window_end_at <= window_start_at then
        raise check_violation using message = 'Every Patrol hit window must end after it starts.';
      end if;
      if window_start_at < target_shift_starts_at or window_end_at > target_shift_ends_at then
        raise check_violation using message = 'Patrol hit windows must stay within the original shift.';
      end if;
      if planned_hits < 1 or planned_hits > 25 then
        raise check_violation using message = 'Each Patrol hit window must plan between 1 and 25 hits.';
      end if;
      if prior_window_end_at is not null and window_start_at < prior_window_end_at then
        raise check_violation using message = 'Patrol hit windows cannot overlap.';
      end if;

      total_hits := total_hits + planned_hits;
      if total_hits > 50 then
        raise check_violation using message = 'A vacancy-recovery request is limited to 50 planned hits.';
      end if;

      normalized := normalized || jsonb_build_array(jsonb_build_object(
        'windowStartAt', window_start_at,
        'windowEndAt', window_end_at,
        'plannedHits', planned_hits
      ));
      prior_window_end_at := window_end_at;
    end loop;
  exception
    when invalid_text_representation or datetime_field_overflow then
      raise check_violation using message = 'Patrol hit-window dates or hit counts are invalid.';
  end;

  return normalized;
end
$$;

create or replace function public.get_vacancy_patrol_finance_report(
  target_from date,
  target_through date,
  target_billing_disposition text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_review boolean;
  can_export boolean;
  normalized_disposition text := nullif(lower(btrim(coalesce(target_billing_disposition, ''))), '');
  payload jsonb;
begin
  if actor_id is null or not private.vacancy_patrol_can_view_finance() then
    raise insufficient_privilege using message = 'Patrol recovery Finance access with current MFA is required.';
  end if;
  if target_from is null or target_through is null or target_through < target_from or target_through - target_from > 366 then
    raise check_violation using message = 'Choose a Finance report range of 366 days or fewer.';
  end if;
  if normalized_disposition is not null and normalized_disposition not in (
    'pending_review', 'bill_separately', 'included_in_contract', 'non_billable', 'duplicate_suppressed'
  ) then
    raise check_violation using message = 'Choose a valid billing disposition filter.';
  end if;

  can_review := private.vacancy_patrol_can_review_billing();
  can_export := private.vacancy_patrol_can_export_finance();
  perform private.reconcile_patrol_obligations();

  with range_rows as (
    select
      recovery.*,
      shift.starts_at,
      shift.ends_at,
      shift.time_zone,
      shift.post_id,
      shift.event_id,
      post.site_id as post_site_id,
      post.name as post_name,
      post_site.name as post_site_name,
      event.site_id as event_site_id,
      event.location_name as event_location_name,
      event_site.name as event_site_name,
      client.id as client_id,
      client.display_name as client_name,
      requested_route.name as requested_route_name,
      accepted_route.name as accepted_route_name,
      assigned_employee.employee_number as assigned_employee_number,
      case when assigned_employee.id is null then null else concat_ws(' ', assigned_employee.first_name, assigned_employee.last_name) end as assigned_employee_name,
      concat_ws(' ', requester.first_name, requester.last_name) as requested_by_name,
      case when accepter.id is null then null else concat_ws(' ', accepter.first_name, accepter.last_name) end as accepted_by_name,
      case when reviewer.id is null then null else concat_ws(' ', reviewer.first_name, reviewer.last_name) end as reviewed_by_name,
      coalesce((
        select sum(hit_window.planned_hits)::integer
        from public.vacancy_patrol_recovery_hit_windows hit_window
        where hit_window.request_id = recovery.id
          and hit_window.plan_version = recovery.current_plan_version
          and hit_window.superseded_at is null
      ), 0) as planned_hits,
      (
        select count(*)::integer
        from public.patrol_hit_obligations obligation
        join public.vacancy_patrol_recovery_hit_windows hit_window
          on hit_window.id = obligation.recovery_hit_window_id
        where hit_window.request_id = recovery.id
          and hit_window.plan_version = recovery.current_plan_version
          and hit_window.superseded_at is null
          and obligation.status = 'completed'
      ) as completed_hits,
      (
        select count(*)::integer
        from public.patrol_hit_obligations obligation
        join public.vacancy_patrol_recovery_hit_windows hit_window
          on hit_window.id = obligation.recovery_hit_window_id
        where hit_window.request_id = recovery.id
          and hit_window.plan_version = recovery.current_plan_version
          and hit_window.superseded_at is null
          and obligation.status = 'missed'
      ) as missed_hits
    from public.vacancy_patrol_recovery_requests recovery
    join public.shifts shift on shift.id = recovery.source_shift_id
    left join public.posts post on post.id = shift.post_id
    left join public.sites post_site on post_site.id = post.site_id
    left join public.events event on event.id = shift.event_id
    left join public.sites event_site on event_site.id = event.site_id
    left join public.clients client on client.id = coalesce(post_site.client_id, event_site.client_id)
    join public.patrol_routes requested_route on requested_route.id = recovery.requested_route_id
    left join public.patrol_routes accepted_route on accepted_route.id = recovery.accepted_route_id
    left join public.employees assigned_employee on assigned_employee.id = recovery.assigned_employee_id
    join public.employees requester on requester.id = recovery.requested_by
    left join public.employees accepter on accepter.id = recovery.accepted_by
    left join public.employees reviewer on reviewer.id = recovery.billing_reviewed_by
    where (shift.starts_at at time zone shift.time_zone)::date between target_from and target_through
  )
  select jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'from', target_from,
    'through', target_through,
    'permissions', jsonb_build_object(
      'canView', true,
      'canReview', can_review,
      'canExport', can_export
    ),
    'summary', jsonb_build_object(
      'totalRequests', count(*)::integer,
      'awaitingCompletion', count(*) filter (
        where range_row.status in ('requested', 'patrol_planned', 'in_progress')
      )::integer,
      'pendingReview', count(*) filter (
        where range_row.status = 'completed' and range_row.billing_disposition = 'pending_review'
      )::integer,
      'reviewed', count(*) filter (
        where range_row.status = 'completed' and range_row.billing_disposition <> 'pending_review'
      )::integer,
      'billSeparately', count(*) filter (where range_row.billing_disposition = 'bill_separately')::integer,
      'includedInContract', count(*) filter (where range_row.billing_disposition = 'included_in_contract')::integer,
      'nonBillable', count(*) filter (where range_row.billing_disposition = 'non_billable')::integer,
      'duplicateSuppressed', count(*) filter (where range_row.billing_disposition = 'duplicate_suppressed')::integer
    ),
    'rows', coalesce(jsonb_agg(jsonb_build_object(
      'requestId', range_row.id,
      'requestNumber', range_row.request_number,
      'status', range_row.status,
      'serviceDate', (range_row.starts_at at time zone range_row.time_zone)::date,
      'clientId', range_row.client_id,
      'clientName', range_row.client_name,
      'siteId', coalesce(range_row.post_site_id, range_row.event_site_id),
      'siteName', coalesce(range_row.post_site_name, range_row.event_site_name, range_row.event_location_name),
      'postId', range_row.post_id,
      'postName', range_row.post_name,
      'shiftId', range_row.source_shift_id,
      'startsAt', range_row.starts_at,
      'endsAt', range_row.ends_at,
      'timeZone', range_row.time_zone,
      'originalShiftHours', round((extract(epoch from (range_row.ends_at - range_row.starts_at)) / 3600)::numeric, 2),
      'requestedRouteId', range_row.requested_route_id,
      'requestedRouteName', range_row.requested_route_name,
      'acceptedRouteId', range_row.accepted_route_id,
      'acceptedRouteName', range_row.accepted_route_name,
      'patrolAssignmentId', range_row.patrol_assignment_id,
      'assignedEmployeeId', range_row.assigned_employee_id,
      'assignedEmployeeNumber', range_row.assigned_employee_number,
      'assignedEmployeeName', range_row.assigned_employee_name,
      'plannedHits', range_row.planned_hits,
      'completedHits', range_row.completed_hits,
      'missedHits', range_row.missed_hits,
      'remainingHits', greatest(range_row.planned_hits - range_row.completed_hits - range_row.missed_hits, 0),
      'completedAt', range_row.completed_at,
      'billingDisposition', range_row.billing_disposition,
      'billingReference', range_row.billing_reference,
      'billingReason', range_row.billing_reason,
      'requestedById', range_row.requested_by,
      'requestedByName', range_row.requested_by_name,
      'requestedAt', range_row.requested_at,
      'acceptedById', range_row.accepted_by,
      'acceptedByName', range_row.accepted_by_name,
      'acceptedAt', range_row.accepted_at,
      'reviewedById', range_row.billing_reviewed_by,
      'reviewedByName', range_row.reviewed_by_name,
      'reviewedAt', range_row.billing_reviewed_at,
      'canReview', can_review and range_row.status = 'completed'
    ) order by range_row.starts_at desc, range_row.request_number desc)
      filter (where normalized_disposition is null or range_row.billing_disposition = normalized_disposition),
      '[]'::jsonb)
  )
  into payload
  from range_rows range_row;

  return payload;
end
$$;

create or replace function public.review_vacancy_patrol_billing(
  target_request_id uuid,
  target_disposition text,
  target_reason text,
  target_reference text,
  target_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  disposition text := lower(btrim(coalesce(target_disposition, '')));
  reason_value text := btrim(coalesce(target_reason, ''));
  reference_value text := nullif(btrim(coalesce(target_reference, '')), '');
  input_fingerprint text;
  replay_history public.vacancy_patrol_recovery_status_history%rowtype;
  recovery public.vacancy_patrol_recovery_requests%rowtype;
  reviewer_name text;
  reviewed_at_value timestamptz := clock_timestamp();
  audit_id bigint;
  receipt jsonb;
begin
  if actor_id is null or not private.vacancy_patrol_can_review_billing() then
    raise insufficient_privilege using message = 'Patrol recovery billing-review permission with current MFA is required.';
  end if;
  if target_idempotency_key is null then
    raise check_violation using message = 'An idempotency key is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor_id::text || ':' || target_idempotency_key::text,
    0
  ));
  if disposition not in ('bill_separately', 'included_in_contract', 'non_billable', 'duplicate_suppressed') then
    raise check_violation using message = 'Choose an approved Patrol recovery billing disposition.';
  end if;
  if char_length(reason_value) not between 5 and 1000 then
    raise check_violation using message = 'Add a Finance review reason between 5 and 1,000 characters.';
  end if;
  if disposition = 'bill_separately' and char_length(coalesce(reference_value, '')) not between 3 and 120 then
    raise check_violation using message = 'A separate billing reference between 3 and 120 characters is required.';
  end if;
  if reference_value is not null and char_length(reference_value) > 120 then
    raise check_violation using message = 'The billing reference is limited to 120 characters.';
  end if;

  input_fingerprint := md5(jsonb_build_object(
    'requestId', target_request_id,
    'disposition', disposition,
    'reason', reason_value,
    'reference', reference_value
  )::text);

  select history.*
  into replay_history
  from public.vacancy_patrol_recovery_status_history history
  where history.actor_employee_id = actor_id
    and history.idempotency_key = target_idempotency_key;

  if found then
    if replay_history.action <> 'billing_reviewed'
       or replay_history.request_id <> target_request_id
       or replay_history.metadata ->> 'inputFingerprint' is distinct from input_fingerprint then
      raise unique_violation using message = 'This idempotency key was already used for a different billing decision.';
    end if;
    return (replay_history.metadata -> 'receipt') || jsonb_build_object('idempotentReplay', true);
  end if;

  select request.*
  into recovery
  from public.vacancy_patrol_recovery_requests request
  where request.id = target_request_id
  for update;

  if not found then
    raise no_data_found using message = 'The Patrol vacancy-recovery request was not found.';
  end if;
  if recovery.status <> 'completed' then
    raise object_not_in_prerequisite_state using message = 'Finance can review billing only after every planned obligation is reconciled as completed or missed.';
  end if;

  if disposition = 'bill_separately' and exists (
    select 1
    from public.vacancy_patrol_recovery_requests other_request
    where other_request.id <> recovery.id
      and other_request.billing_disposition = 'bill_separately'
      and lower(regexp_replace(btrim(other_request.billing_reference), '\s+', '', 'g')) =
          lower(regexp_replace(reference_value, '\s+', '', 'g'))
  ) then
    raise unique_violation using message = 'This billing reference is already attached to another Patrol recovery.';
  end if;

  select concat_ws(' ', employee.first_name, employee.last_name)
  into reviewer_name
  from public.employees employee
  where employee.id = actor_id;

  update public.vacancy_patrol_recovery_requests request
  set billing_disposition = disposition,
      billing_reference = reference_value,
      billing_reason = reason_value,
      billing_reviewed_by = actor_id,
      billing_reviewed_at = reviewed_at_value,
      updated_at = reviewed_at_value
  where request.id = recovery.id;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'vacancy_patrol_recovery_requests',
    'billing_review', recovery.id::text,
    jsonb_build_object(
      'billingDisposition', recovery.billing_disposition,
      'billingReference', recovery.billing_reference,
      'billingReason', recovery.billing_reason,
      'reviewedBy', recovery.billing_reviewed_by,
      'reviewedAt', recovery.billing_reviewed_at
    ),
    jsonb_build_object(
      'billingDisposition', disposition,
      'billingReference', reference_value,
      'billingReason', reason_value,
      'reviewedBy', actor_id,
      'reviewedAt', reviewed_at_value,
      'invoiceCreated', false,
      'automaticChargeCreated', false
    )
  ) returning id into audit_id;

  receipt := jsonb_build_object(
    'requestId', recovery.id,
    'requestNumber', recovery.request_number,
    'billingDisposition', disposition,
    'billingReference', reference_value,
    'billingReason', reason_value,
    'reviewedBy', jsonb_build_object('employeeId', actor_id, 'name', reviewer_name),
    'reviewedAt', reviewed_at_value,
    'auditId', audit_id,
    'idempotentReplay', false
  );

  insert into public.vacancy_patrol_recovery_status_history (
    request_id, action, from_status, to_status, note, actor_employee_id, idempotency_key, metadata
  ) values (
    recovery.id, 'billing_reviewed', recovery.status, recovery.status, reason_value,
    actor_id, target_idempotency_key,
    jsonb_build_object(
      'inputFingerprint', input_fingerprint,
      'priorDisposition', recovery.billing_disposition,
      'billingDisposition', disposition,
      'billingReference', reference_value,
      'auditId', audit_id,
      'receipt', receipt
    )
  );

  perform private.create_employee_notification(
    recovery.requested_by,
    'vacancy_patrol_recovery',
    recovery.id,
    concat('vacancy-patrol-billing:', audit_id, ':requester:', recovery.requested_by),
    'Patrol recovery Finance review completed',
    concat(recovery.request_number, ' received the billing disposition ', replace(disposition, '_', ' '), '.'),
    'routine', false, '/schedule', 'Review recovery', actor_id, null, null
  );
  if recovery.accepted_by is not null and recovery.accepted_by <> recovery.requested_by then
    perform private.create_employee_notification(
      recovery.accepted_by,
      'vacancy_patrol_recovery',
      recovery.id,
      concat('vacancy-patrol-billing:', audit_id, ':manager:', recovery.accepted_by),
      'Patrol recovery Finance review completed',
      concat(recovery.request_number, ' received the billing disposition ', replace(disposition, '_', ' '), '.'),
      'routine', false, '/patrol/recovery', 'Review recovery', actor_id, null, null
    );
  end if;

  return receipt;
end
$$;

create or replace function public.authorize_vacancy_patrol_finance_export(
  target_from date,
  target_through date,
  target_format text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  format_value text := lower(btrim(coalesce(target_format, '')));
  audit_id bigint;
  authorized_at_value timestamptz := clock_timestamp();
begin
  if actor_id is null or not private.vacancy_patrol_can_export_finance() then
    raise insufficient_privilege using message = 'Patrol recovery Finance export permission with current MFA is required.';
  end if;
  if target_from is null or target_through is null or target_through < target_from or target_through - target_from > 366 then
    raise check_violation using message = 'Choose an export range of 366 days or fewer.';
  end if;
  if format_value not in ('csv', 'xlsx', 'pdf') then
    raise check_violation using message = 'Choose CSV, XLSX, or PDF for the Finance export.';
  end if;

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'vacancy_patrol_recovery_finance',
    'export', null,
    jsonb_build_object(
      'from', target_from,
      'through', target_through,
      'format', format_value,
      'authorizedAt', authorized_at_value
    )
  ) returning id into audit_id;

  return jsonb_build_object(
    'authorizedAt', authorized_at_value,
    'auditId', audit_id,
    'format', format_value,
    'from', target_from,
    'through', target_through
  );
end
$$;

create or replace function public.update_vacancy_patrol_recovery(
  target_request_id uuid,
  target_action text,
  target_note text,
  target_hit_windows jsonb,
  target_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  action_name text := lower(btrim(coalesce(target_action, '')));
  recovery public.vacancy_patrol_recovery_requests%rowtype;
  updated_recovery public.vacancy_patrol_recovery_requests%rowtype;
  replay_history public.vacancy_patrol_recovery_status_history%rowtype;
  shift_starts_at timestamptz;
  shift_ends_at timestamptz;
  normalized_windows jsonb;
  input_fingerprint text;
  next_plan_version integer;
  history_action text;
  from_status text;
  planned_hits integer := 0;
  completed_hits integer := 0;
  missed_hits integer := 0;
  receipt jsonb;
begin
  if actor_id is null or not private.vacancy_patrol_can_manage() then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission with current MFA is required.';
  end if;
  if target_idempotency_key is null then
    raise check_violation using message = 'An idempotency key is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor_id::text || ':' || target_idempotency_key::text,
    0
  ));
  if action_name not in ('update_plan', 'decline', 'cancel', 'reconcile') then
    raise check_violation using message = 'Choose update_plan, decline, cancel, or reconcile.';
  end if;
  if char_length(btrim(coalesce(target_note, ''))) not between 5 and 1000 then
    raise check_violation using message = 'Add an update note between 5 and 1,000 characters.';
  end if;

  select request.*
  into recovery
  from public.vacancy_patrol_recovery_requests request
  where request.id = target_request_id
  for update;

  if not found then
    raise no_data_found using message = 'The Patrol vacancy-recovery request was not found.';
  end if;

  select shift.starts_at, shift.ends_at
  into shift_starts_at, shift_ends_at
  from public.shifts shift
  where shift.id = recovery.source_shift_id;

  if action_name = 'update_plan' then
    normalized_windows := private.normalize_vacancy_patrol_hit_windows(
      target_hit_windows,
      shift_starts_at,
      shift_ends_at
    );
  else
    normalized_windows := null;
  end if;

  input_fingerprint := md5(jsonb_build_object(
    'requestId', target_request_id,
    'action', action_name,
    'note', btrim(target_note),
    'hitWindows', normalized_windows
  )::text);

  select history.*
  into replay_history
  from public.vacancy_patrol_recovery_status_history history
  where history.actor_employee_id = actor_id
    and history.idempotency_key = target_idempotency_key;

  if found then
    if replay_history.request_id <> target_request_id
       or replay_history.metadata ->> 'inputFingerprint' is distinct from input_fingerprint
       or replay_history.action not in ('plan_updated', 'declined', 'canceled', 'reconciled') then
      raise unique_violation using message = 'This idempotency key was already used for a different Patrol recovery action.';
    end if;
    return (replay_history.metadata -> 'receipt') || jsonb_build_object('idempotentReplay', true);
  end if;

  from_status := recovery.status;
  if action_name = 'update_plan' then
    if recovery.status <> 'requested' then
      raise object_not_in_prerequisite_state using message = 'The hit plan can only change before Patrol accepts the request.';
    end if;

    next_plan_version := recovery.current_plan_version + 1;
    update public.vacancy_patrol_recovery_hit_windows hit_window
    set superseded_at = clock_timestamp(),
        superseded_by = actor_id
    where hit_window.request_id = recovery.id
      and hit_window.plan_version = recovery.current_plan_version
      and hit_window.superseded_at is null;

    insert into public.vacancy_patrol_recovery_hit_windows (
      request_id, plan_version, sequence_number, window_start_at, window_end_at,
      planned_hits, created_by
    )
    select
      recovery.id,
      next_plan_version,
      window_item.ordinality::integer,
      (window_item.value ->> 'windowStartAt')::timestamptz,
      (window_item.value ->> 'windowEndAt')::timestamptz,
      (window_item.value ->> 'plannedHits')::integer,
      actor_id
    from jsonb_array_elements(normalized_windows) with ordinality as window_item(value, ordinality);

    update public.vacancy_patrol_recovery_requests request
    set current_plan_version = next_plan_version,
        updated_at = clock_timestamp()
    where request.id = recovery.id;
    history_action := 'plan_updated';
  elsif action_name = 'decline' then
    if recovery.status <> 'requested' then
      raise object_not_in_prerequisite_state using message = 'Only a requested Patrol recovery can be declined.';
    end if;
    update public.vacancy_patrol_recovery_requests request
    set status = 'declined',
        closed_by = actor_id,
        closed_at = clock_timestamp(),
        closure_note = btrim(target_note),
        updated_at = clock_timestamp()
    where request.id = recovery.id;
    history_action := 'declined';
  elsif action_name = 'cancel' then
    if recovery.status not in ('requested', 'patrol_planned', 'in_progress') then
      raise object_not_in_prerequisite_state using message = 'This Patrol recovery can no longer be canceled.';
    end if;

    update public.vacancy_patrol_recovery_requests request
    set status = 'canceled',
        completed_at = null,
        closed_by = actor_id,
        closed_at = clock_timestamp(),
        closure_note = btrim(target_note),
        updated_at = clock_timestamp()
    where request.id = recovery.id;

    if recovery.patrol_assignment_id is not null then
      update public.patrol_assignments assignment
      set status = 'canceled',
          canceled_at = clock_timestamp(),
          cancellation_reason = btrim(target_note)
      where assignment.id = recovery.patrol_assignment_id
        and assignment.status = 'active';

      update public.patrol_hit_obligations obligation
      set status = 'waived',
          reconciled_at = clock_timestamp()
      where obligation.assignment_id = recovery.patrol_assignment_id
        and obligation.source = 'vacancy_recovery'
        and obligation.status in ('scheduled', 'due', 'late');
    end if;
    history_action := 'canceled';
  else
    if recovery.status not in ('patrol_planned', 'in_progress', 'completed') then
      raise object_not_in_prerequisite_state using message = 'Only an accepted Patrol recovery can be reconciled.';
    end if;
    perform private.reconcile_patrol_obligations();
    perform private.sync_vacancy_patrol_recovery(recovery.id, actor_id, null);
    history_action := 'reconciled';
  end if;

  select request.*
  into strict updated_recovery
  from public.vacancy_patrol_recovery_requests request
  where request.id = recovery.id;

  select
    coalesce(sum(hit_window.planned_hits), 0)::integer,
    (
      select count(*)::integer
      from public.patrol_hit_obligations obligation
      join public.vacancy_patrol_recovery_hit_windows counted_window
        on counted_window.id = obligation.recovery_hit_window_id
      where counted_window.request_id = recovery.id
        and counted_window.plan_version = updated_recovery.current_plan_version
        and counted_window.superseded_at is null
        and obligation.status = 'completed'
    ),
    (
      select count(*)::integer
      from public.patrol_hit_obligations obligation
      join public.vacancy_patrol_recovery_hit_windows counted_window
        on counted_window.id = obligation.recovery_hit_window_id
      where counted_window.request_id = recovery.id
        and counted_window.plan_version = updated_recovery.current_plan_version
        and counted_window.superseded_at is null
        and obligation.status = 'missed'
    )
  into planned_hits, completed_hits, missed_hits
  from public.vacancy_patrol_recovery_hit_windows hit_window
  where hit_window.request_id = recovery.id
    and hit_window.plan_version = updated_recovery.current_plan_version
    and hit_window.superseded_at is null;

  receipt := jsonb_build_object(
    'requestId', updated_recovery.id,
    'requestNumber', updated_recovery.request_number,
    'status', updated_recovery.status,
    'displayStage', private.vacancy_patrol_display_stage(
      updated_recovery.status, updated_recovery.billing_disposition
    ),
    'plannedHits', planned_hits,
    'completedHits', completed_hits,
    'missedHits', missed_hits,
    'updatedAt', updated_recovery.updated_at,
    'idempotentReplay', false
  );

  insert into public.vacancy_patrol_recovery_status_history (
    request_id, action, from_status, to_status, note, actor_employee_id, idempotency_key, metadata
  ) values (
    recovery.id,
    history_action,
    from_status,
    updated_recovery.status,
    btrim(target_note),
    actor_id,
    target_idempotency_key,
    jsonb_build_object(
      'inputFingerprint', input_fingerprint,
      'planVersion', updated_recovery.current_plan_version,
      'receipt', receipt
    )
  );

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'vacancy_patrol_recovery_requests',
    history_action, recovery.id::text,
    jsonb_build_object(
      'status', from_status,
      'planVersion', recovery.current_plan_version
    ),
    jsonb_build_object(
      'status', updated_recovery.status,
      'planVersion', updated_recovery.current_plan_version,
      'plannedHits', planned_hits,
      'completedHits', completed_hits,
      'missedHits', missed_hits,
      'note', btrim(target_note)
    )
  );

  if action_name in ('decline', 'cancel') then
    perform private.create_employee_notification(
      recovery.requested_by,
      'vacancy_patrol_recovery',
      recovery.id,
      concat('vacancy-patrol-', action_name, ':', recovery.id, ':requester:', recovery.requested_by),
      case when action_name = 'decline'
        then 'Patrol vacancy recovery declined'
        else 'Patrol vacancy recovery canceled'
      end,
      concat(recovery.request_number, ' was ', case when action_name = 'decline' then 'declined' else 'canceled' end, '. Review the documented reason.'),
      'important', false, '/schedule', 'Review request', actor_id, null, shift_ends_at
    );
  end if;

  return receipt;
end
$$;

create or replace function public.accept_vacancy_patrol_recovery(
  target_request_id uuid,
  target_route_id uuid,
  target_employee_id uuid,
  target_note text,
  target_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  recovery public.vacancy_patrol_recovery_requests%rowtype;
  shift_record record;
  route_record public.patrol_routes%rowtype;
  assigned_employee public.employees%rowtype;
  replay_history public.vacancy_patrol_recovery_status_history%rowtype;
  hit_window record;
  selected_requirement record;
  requirement_count integer;
  hit_slot integer;
  global_slot integer := 0;
  next_hit_number integer;
  planned_hits integer;
  created_assignment_id uuid;
  accepted_at_value timestamptz := clock_timestamp();
  request_local_date date;
  request_local_day smallint;
begin
  if actor_id is null or not private.vacancy_patrol_can_manage() then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission with current MFA is required.';
  end if;
  if target_idempotency_key is null then
    raise check_violation using message = 'An idempotency key is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor_id::text || ':' || target_idempotency_key::text,
    0
  ));
  if char_length(btrim(coalesce(target_note, ''))) not between 5 and 1000 then
    raise check_violation using message = 'Add an acceptance note between 5 and 1,000 characters.';
  end if;

  select history.*
  into replay_history
  from public.vacancy_patrol_recovery_status_history history
  where history.actor_employee_id = actor_id
    and history.idempotency_key = target_idempotency_key;

  if found then
    if replay_history.action <> 'accepted'
       or replay_history.request_id <> target_request_id
       or (replay_history.metadata ->> 'acceptedRouteId')::uuid is distinct from target_route_id
       or (replay_history.metadata ->> 'assignedEmployeeId')::uuid is distinct from target_employee_id
       or replay_history.metadata ->> 'note' is distinct from btrim(target_note) then
      raise unique_violation using message = 'This idempotency key was already used for a different Patrol recovery action.';
    end if;
    return jsonb_build_object(
      'requestId', replay_history.request_id,
      'requestNumber', replay_history.metadata ->> 'requestNumber',
      'status', 'patrol_planned',
      'patrolAssignmentId', replay_history.metadata ->> 'patrolAssignmentId',
      'acceptedRouteId', replay_history.metadata ->> 'acceptedRouteId',
      'assignedEmployeeId', replay_history.metadata ->> 'assignedEmployeeId',
      'plannedHits', (replay_history.metadata ->> 'plannedHits')::integer,
      'completedHits', 0,
      'acceptedAt', replay_history.created_at,
      'idempotentReplay', true
    );
  end if;

  select request.*
  into recovery
  from public.vacancy_patrol_recovery_requests request
  where request.id = target_request_id
  for update;

  if not found then
    raise no_data_found using message = 'The Patrol vacancy-recovery request was not found.';
  end if;
  if recovery.status <> 'requested' then
    raise object_not_in_prerequisite_state using message = 'Only a requested Patrol recovery can be accepted.';
  end if;

  select
    shift.id,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    shift.requires_armed,
    shift.is_open,
    shift.post_id,
    coalesce(post.site_id, event.site_id) as source_site_id,
    shift.work_type,
    private.shift_assignment_type(shift.id) as assignment_type,
    shift.canceled_at,
    schedule.status as schedule_status
  into shift_record
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  left join public.posts post on post.id = shift.post_id
  left join public.events event on event.id = shift.event_id
  where shift.id = recovery.source_shift_id
  for update of shift;

  if not found or shift_record.canceled_at is not null or shift_record.schedule_status <> 'published' then
    raise object_not_in_prerequisite_state using message = 'The source vacancy is no longer an active published shift.';
  end if;
  if shift_record.ends_at <= clock_timestamp() then
    raise object_not_in_prerequisite_state using message = 'The source vacancy has already ended.';
  end if;
  if not shift_record.is_open then
    raise object_not_in_prerequisite_state using message = 'Patrol recovery is limited to open regular post vacancies.';
  end if;
  if shift_record.work_type <> 'post' or shift_record.assignment_type <> 'standard' then
    raise object_not_in_prerequisite_state using message = 'Patrol recovery is limited to regular post vacancies.';
  end if;
  if exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = shift_record.id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) then
    raise object_not_in_prerequisite_state using message = 'The source vacancy has already received regular coverage.';
  end if;
  if exists (select 1 from public.call_off_reports report where report.shift_id = shift_record.id)
     or exists (
       select 1 from public.attendance_accountability_events occurrence
       where occurrence.shift_id = shift_record.id
         and occurrence.status <> 'voided'
     ) then
    raise object_not_in_prerequisite_state using message = 'The source shift now belongs to the established absence workflow.';
  end if;

  select route.*
  into route_record
  from public.patrol_routes route
  where route.id = target_route_id
    and route.status = 'active'
    and route.current_version_id is not null
  for share;

  if not found then
    raise check_violation using message = 'Choose an active Patrol route.';
  end if;
  if shift_record.requires_armed and not route_record.requires_armed then
    raise check_violation using message = 'An armed vacancy requires an armed Patrol route.';
  end if;

  select employee.*
  into assigned_employee
  from public.employees employee
  where employee.id = target_employee_id
    and employee.status = 'active';

  if not found
     or not ('patrol.hits.complete' = any(coalesce(
       private.employee_effective_permissions(target_employee_id), array[]::text[]
     )))
     or not ('patrol.self.view' = any(coalesce(
       private.employee_effective_permissions(target_employee_id), array[]::text[]
     ))) then
    raise check_violation using message = 'Choose an active employee authorized to view and complete assigned Patrol hits.';
  end if;

  request_local_date := (shift_record.starts_at at time zone route_record.time_zone)::date;
  request_local_day := extract(dow from shift_record.starts_at at time zone route_record.time_zone)::smallint;
  if (shift_record.requires_armed or route_record.requires_armed)
     and not public.has_valid_credential(target_employee_id, 'armed_guard', request_local_date) then
    raise check_violation using message = 'The assigned employee needs an active armed qualification for this recovery.';
  end if;

  select count(*)::integer
  into requirement_count
  from public.patrol_route_stops route_stop
  join public.patrol_stop_requirements requirement on requirement.stop_id = route_stop.id
  left join public.posts route_stop_post on route_stop_post.id = route_stop.post_id
  where route_stop.route_version_id = route_record.current_version_id
    and requirement.status = 'active'
    and requirement.day_of_week = request_local_day
    and (
      (shift_record.post_id is not null and route_stop.post_id = shift_record.post_id)
      or (
        shift_record.post_id is null
        and shift_record.source_site_id is not null
        and coalesce(route_stop.site_id, route_stop_post.site_id) = shift_record.source_site_id
      )
    );

  if requirement_count = 0 then
    raise check_violation using message = 'The accepted Patrol route has no active source-location hit requirements for this service day. Add the vacant post or site to an active route first.';
  end if;

  select coalesce(sum(planned_window.planned_hits), 0)::integer
  into planned_hits
  from public.vacancy_patrol_recovery_hit_windows planned_window
  where planned_window.request_id = recovery.id
    and planned_window.plan_version = recovery.current_plan_version
    and planned_window.superseded_at is null;

  if planned_hits < 1 then
    raise object_not_in_prerequisite_state using message = 'The recovery request has no active hit plan.';
  end if;

  insert into public.patrol_assignments (
    route_id, route_version_id, shift_id, employee_id, service_date, assigned_by
  ) values (
    route_record.id, route_record.current_version_id, shift_record.id,
    target_employee_id, request_local_date, actor_id
  )
  returning id into created_assignment_id;

  for hit_window in
    select window_record.*
    from public.vacancy_patrol_recovery_hit_windows window_record
    where window_record.request_id = recovery.id
      and window_record.plan_version = recovery.current_plan_version
      and window_record.superseded_at is null
    order by window_record.sequence_number
  loop
    for hit_slot in 1..hit_window.planned_hits loop
      global_slot := global_slot + 1;

      with ranked_requirement as (
        select
          requirement.id as requirement_id,
          requirement.stop_id,
          row_number() over (
            order by route_stop.sequence_number, requirement.requirement_label, requirement.id
          ) as requirement_rank
        from public.patrol_route_stops route_stop
        join public.patrol_stop_requirements requirement on requirement.stop_id = route_stop.id
        left join public.posts route_stop_post on route_stop_post.id = route_stop.post_id
        where route_stop.route_version_id = route_record.current_version_id
          and requirement.status = 'active'
          and requirement.day_of_week = request_local_day
          and (
            (shift_record.post_id is not null and route_stop.post_id = shift_record.post_id)
            or (
              shift_record.post_id is null
              and shift_record.source_site_id is not null
              and coalesce(route_stop.site_id, route_stop_post.site_id) = shift_record.source_site_id
            )
          )
      )
      select ranked_requirement.requirement_id, ranked_requirement.stop_id
      into selected_requirement
      from ranked_requirement
      where ranked_requirement.requirement_rank = ((global_slot - 1) % requirement_count) + 1;

      select coalesce(max(obligation.hit_number), 0) + 1
      into next_hit_number
      from public.patrol_hit_obligations obligation
      where obligation.assignment_id = created_assignment_id
        and obligation.requirement_id = selected_requirement.requirement_id;

      insert into public.patrol_hit_obligations (
        assignment_id, stop_id, requirement_id, hit_number,
        due_start_at, due_end_at, source, recovery_hit_window_id
      ) values (
        created_assignment_id,
        selected_requirement.stop_id,
        selected_requirement.requirement_id,
        next_hit_number,
        hit_window.window_start_at,
        hit_window.window_end_at,
        'vacancy_recovery',
        hit_window.id
      );
    end loop;
  end loop;

  update public.vacancy_patrol_recovery_requests request
  set accepted_route_id = route_record.id,
      accepted_route_version_id = route_record.current_version_id,
      patrol_assignment_id = created_assignment_id,
      assigned_employee_id = target_employee_id,
      status = 'patrol_planned',
      accepted_by = actor_id,
      accepted_at = accepted_at_value,
      acceptance_note = btrim(target_note),
      updated_at = accepted_at_value
  where request.id = recovery.id;

  insert into public.vacancy_patrol_recovery_status_history (
    request_id, action, from_status, to_status, note, actor_employee_id, idempotency_key, metadata
  ) values (
    recovery.id, 'accepted', recovery.status, 'patrol_planned', btrim(target_note), actor_id,
    target_idempotency_key,
    jsonb_build_object(
      'requestNumber', recovery.request_number,
      'acceptedRouteId', route_record.id,
      'acceptedRouteVersionId', route_record.current_version_id,
      'assignedEmployeeId', target_employee_id,
      'patrolAssignmentId', created_assignment_id,
      'plannedHits', planned_hits,
      'note', btrim(target_note),
      'originalShiftRemainsUnassigned', true
    )
  );

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'vacancy_patrol_recovery_requests',
    'accept', recovery.id::text,
    jsonb_build_object('status', recovery.status, 'requestedRouteId', recovery.requested_route_id),
    jsonb_build_object(
      'status', 'patrol_planned',
      'acceptedRouteId', route_record.id,
      'acceptedRouteVersionId', route_record.current_version_id,
      'assignedEmployeeId', target_employee_id,
      'patrolAssignmentId', created_assignment_id,
      'plannedHits', planned_hits,
      'shiftAssignmentCreated', false
    )
  );

  perform private.create_employee_notification(
    recovery.requested_by,
    'vacancy_patrol_recovery',
    recovery.id,
    concat('vacancy-patrol-accepted:', recovery.id, ':requester:', recovery.requested_by),
    'Patrol vacancy recovery planned',
    concat(recovery.request_number, ' was accepted with ', planned_hits, ' planned Patrol hits.'),
    'important', false, '/schedule', 'Review plan', actor_id, null, shift_record.ends_at
  );
  perform private.create_employee_notification(
    target_employee_id,
    'vacancy_patrol_recovery',
    recovery.id,
    concat('vacancy-patrol-assigned:', recovery.id, ':employee:', target_employee_id),
    'Patrol recovery hits assigned',
    concat('You have ', planned_hits, ' planned Patrol recovery hits for ', recovery.request_number, '.'),
    'urgent', true, '/patrol/my-patrol', 'Open My Patrol', actor_id, null, shift_record.ends_at
  );

  return jsonb_build_object(
    'requestId', recovery.id,
    'requestNumber', recovery.request_number,
    'status', 'patrol_planned',
    'patrolAssignmentId', created_assignment_id,
    'acceptedRouteId', route_record.id,
    'assignedEmployeeId', target_employee_id,
    'plannedHits', planned_hits,
    'completedHits', 0,
    'acceptedAt', accepted_at_value,
    'idempotentReplay', false
  );
end
$$;

create or replace function public.get_vacancy_patrol_recovery_map(target_week_starts_on date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  can_initiate boolean;
  payload jsonb;
begin
  can_initiate := private.vacancy_patrol_can_request();
  if actor_id is null or not (
    can_initiate
    or private.vacancy_patrol_can_manage()
    or private.vacancy_patrol_can_view_finance()
  ) then
    raise insufficient_privilege using message = 'Vacancy Patrol recovery access with current MFA is required.';
  end if;
  if target_week_starts_on is null or extract(dow from target_week_starts_on)::integer <> 0 then
    raise check_violation using message = 'The schedule week must begin on Sunday.';
  end if;

  -- Schedule refreshes must surface overdue recovery work even when neither a
  -- guard nor a Patrol manager has opened the Patrol workspace recently.
  perform private.reconcile_patrol_obligations();

  select jsonb_build_object(
    'weekStartsOn', target_week_starts_on,
    'weekEndsOn', target_week_starts_on + 6,
    'permissions', jsonb_build_object('canInitiate', can_initiate),
    'recoveries', coalesce(jsonb_agg(jsonb_build_object(
      'shiftId', shift.id,
      'requestId', recovery.id,
      'requestNumber', recovery.request_number,
      'status', recovery.status,
      'displayStage', private.vacancy_patrol_display_stage(recovery.status, recovery.billing_disposition),
      'requestedRouteId', recovery.requested_route_id,
      'acceptedRouteId', recovery.accepted_route_id,
      'patrolAssignmentId', recovery.patrol_assignment_id,
      'plannedHits', recovery_counts.planned_hits,
      'completedHits', recovery_counts.completed_hits,
      'billingDisposition', case when recovery.status = 'completed' then recovery.billing_disposition else null end,
      'updatedAt', recovery.updated_at
    ) order by shift.starts_at, recovery.request_number), '[]'::jsonb)
  )
  into payload
  from public.vacancy_patrol_recovery_requests recovery
  join public.shifts shift on shift.id = recovery.source_shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  cross join lateral (
    select
      coalesce(sum(hit_window.planned_hits), 0)::integer as planned_hits,
      (
        select count(*)::integer
        from public.patrol_hit_obligations obligation
        join public.vacancy_patrol_recovery_hit_windows counted_window
          on counted_window.id = obligation.recovery_hit_window_id
        where counted_window.request_id = recovery.id
          and counted_window.plan_version = recovery.current_plan_version
          and counted_window.superseded_at is null
          and obligation.status = 'completed'
      ) as completed_hits
    from public.vacancy_patrol_recovery_hit_windows hit_window
    where hit_window.request_id = recovery.id
      and hit_window.plan_version = recovery.current_plan_version
      and hit_window.superseded_at is null
  ) recovery_counts
  where schedule.week_starts_on = target_week_starts_on;

  return payload;
end
$$;

create or replace function public.get_vacancy_patrol_recovery(target_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  assigned_employee_id uuid;
begin
  select recovery.assigned_employee_id
  into assigned_employee_id
  from public.vacancy_patrol_recovery_requests recovery
  where recovery.id = target_request_id;

  if actor_id is null or not (
    private.vacancy_patrol_can_request()
    or private.vacancy_patrol_can_manage()
    or private.vacancy_patrol_can_view_finance()
    or (
      actor_id = assigned_employee_id
      and public.has_effective_permission('patrol.self.view')
    )
  ) then
    raise insufficient_privilege using message = 'This Patrol vacancy-recovery request is not available to you.';
  end if;

  return private.get_vacancy_patrol_recovery_payload(
    target_request_id,
    private.vacancy_patrol_can_manage()
  );
end
$$;

create or replace function public.get_vacancy_patrol_recovery_worklist(
  target_from date,
  target_through date,
  target_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  normalized_status text := nullif(btrim(coalesce(target_status, '')), '');
  payload jsonb;
begin
  if actor_id is null or not private.vacancy_patrol_can_manage() then
    raise insufficient_privilege using message = 'Patrol Assignment Management permission with current MFA is required.';
  end if;
  if target_from is null or target_through is null or target_through < target_from or target_through - target_from > 93 then
    raise check_violation using message = 'Choose a Patrol recovery worklist range of 93 days or fewer.';
  end if;
  if normalized_status is not null and normalized_status not in (
    'requested', 'patrol_planned', 'in_progress', 'completed', 'declined', 'canceled'
  ) then
    raise check_violation using message = 'Choose a valid Patrol recovery status filter.';
  end if;

  perform private.reconcile_patrol_obligations();

  with range_requests as (
    select recovery.id, recovery.status, recovery.requested_at
    from public.vacancy_patrol_recovery_requests recovery
    join public.shifts shift on shift.id = recovery.source_shift_id
    where (shift.starts_at at time zone shift.time_zone)::date between target_from and target_through
  )
  select jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'permissions', jsonb_build_object('canAccept', true, 'canUpdate', true),
    'counts', jsonb_build_object(
      'total', count(*)::integer,
      'requested', count(*) filter (where range_request.status = 'requested')::integer,
      'patrolPlanned', count(*) filter (where range_request.status = 'patrol_planned')::integer,
      'inProgress', count(*) filter (where range_request.status = 'in_progress')::integer,
      'completed', count(*) filter (where range_request.status = 'completed')::integer,
      'declined', count(*) filter (where range_request.status = 'declined')::integer,
      'canceled', count(*) filter (where range_request.status = 'canceled')::integer
    ),
    'requests', coalesce(jsonb_agg(
      private.get_vacancy_patrol_recovery_payload(range_request.id, true)
      order by range_request.requested_at desc, range_request.id
    ) filter (where normalized_status is null or range_request.status = normalized_status), '[]'::jsonb)
  )
  into payload
  from range_requests range_request;

  return payload;
end
$$;

create or replace function public.get_vacancy_patrol_recovery_bootstrap(target_shift_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  payload jsonb;
begin
  if actor_id is null or not private.vacancy_patrol_can_request() then
    raise insufficient_privilege using message = 'Schedule authority with current MFA is required to request Patrol recovery.';
  end if;

  select jsonb_build_object(
    'shift', jsonb_build_object(
      'shiftId', shift.id,
      'scheduleId', schedule.id,
      'scheduleName', null,
      'startsAt', shift.starts_at,
      'endsAt', shift.ends_at,
      'timeZone', shift.time_zone,
      'requiresArmed', shift.requires_armed,
      'siteId', coalesce(post_site.id, event_site.id),
      'siteName', coalesce(post_site.name, event_site.name, event.location_name),
      'postId', post.id,
      'postName', post.name,
      'isPublished', schedule.status = 'published',
      'isUnassigned', not exists (
        select 1
        from public.shift_assignments assignment
        where assignment.shift_id = shift.id
          and assignment.status in ('assigned', 'confirmed', 'completed')
      )
    ),
    'existingRequest', (
      select jsonb_build_object(
        'requestId', recovery.id,
        'requestNumber', recovery.request_number,
        'status', recovery.status,
        'requestedRouteId', recovery.requested_route_id,
        'reason', recovery.reason,
        'hitWindows', coalesce((
          select jsonb_agg(jsonb_build_object(
            'windowStartAt', hit_window.window_start_at,
            'windowEndAt', hit_window.window_end_at,
            'plannedHits', hit_window.planned_hits
          ) order by hit_window.sequence_number)
          from public.vacancy_patrol_recovery_hit_windows hit_window
          where hit_window.request_id = recovery.id
            and hit_window.plan_version = recovery.current_plan_version
            and hit_window.superseded_at is null
        ), '[]'::jsonb),
        'createdAt', recovery.created_at
      )
      from public.vacancy_patrol_recovery_requests recovery
      where recovery.source_shift_id = shift.id
    ),
    'routeChoices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'routeId', route.id,
        'routeVersionId', route.current_version_id,
        'code', route.code,
        'name', route.name,
        'requiresArmed', route.requires_armed,
        'timeZone', route.time_zone
      ) order by route.name)
      from public.patrol_routes route
      where route.status = 'active'
        and route.current_version_id is not null
        and (not shift.requires_armed or route.requires_armed)
        and exists (
          select 1
          from public.patrol_route_stops route_stop
          join public.patrol_stop_requirements requirement on requirement.stop_id = route_stop.id
          left join public.posts route_stop_post on route_stop_post.id = route_stop.post_id
          where route_stop.route_version_id = route.current_version_id
            and requirement.status = 'active'
            and requirement.day_of_week = extract(dow from shift.starts_at at time zone route.time_zone)::smallint
            and (
              (shift.post_id is not null and route_stop.post_id = shift.post_id)
              or (
                shift.post_id is null
                and coalesce(post_site.id, event_site.id) is not null
                and coalesce(route_stop.site_id, route_stop_post.site_id) = coalesce(post_site.id, event_site.id)
              )
            )
        )
    ), '[]'::jsonb),
    'defaults', jsonb_build_object(
      'reasonMinLength', 10,
      'maxHitWindows', 24,
      'hitWindows', jsonb_build_array(jsonb_build_object(
        'windowStartAt', shift.starts_at,
        'windowEndAt', shift.ends_at,
        'plannedHits', 1
      ))
    ),
    'permissions', jsonb_build_object('canInitiate', true)
  )
  into payload
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  where shift.id = target_shift_id
    and shift.canceled_at is null
    and shift.ends_at > statement_timestamp()
    and shift.is_open
    and schedule.status = 'published'
    and shift.work_type = 'post'
    and private.shift_assignment_type(shift.id) = 'standard'
    and not exists (
      select 1
      from public.shift_assignments assignment
      where assignment.shift_id = shift.id
        and assignment.status in ('assigned', 'confirmed', 'completed')
    )
    and not exists (
      select 1
      from public.call_off_reports report
      where report.shift_id = shift.id
    )
    and not exists (
      select 1
      from public.attendance_accountability_events occurrence
      where occurrence.shift_id = shift.id
        and occurrence.status <> 'voided'
    );

  if payload is null then
    raise no_data_found using message = 'The schedule shift was not found.';
  end if;
  return payload;
end
$$;

create or replace function public.create_vacancy_patrol_recovery(
  target_shift_id uuid,
  target_requested_route_id uuid,
  target_reason text,
  target_hit_windows jsonb,
  target_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  shift_record record;
  route_record public.patrol_routes%rowtype;
  normalized_windows jsonb;
  request_fingerprint text;
  existing_request public.vacancy_patrol_recovery_requests%rowtype;
  created_request public.vacancy_patrol_recovery_requests%rowtype;
  patrol_manager record;
begin
  if actor_id is null or not private.vacancy_patrol_can_request() then
    raise insufficient_privilege using message = 'Schedule authority with current MFA is required to request Patrol recovery.';
  end if;
  if target_idempotency_key is null then
    raise check_violation using message = 'An idempotency key is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    actor_id::text || ':' || target_idempotency_key::text,
    0
  ));
  if char_length(btrim(coalesce(target_reason, ''))) not between 10 and 1000 then
    raise check_violation using message = 'Add a Patrol recovery reason between 10 and 1,000 characters.';
  end if;

  select
    shift.id,
    shift.starts_at,
    shift.ends_at,
    shift.time_zone,
    shift.requires_armed,
    shift.is_open,
    shift.post_id,
    coalesce(post.site_id, event.site_id) as source_site_id,
    shift.work_type,
    private.shift_assignment_type(shift.id) as assignment_type,
    shift.canceled_at,
    schedule.status as schedule_status
  into shift_record
  from public.shifts shift
  join public.schedules schedule on schedule.id = shift.schedule_id
  left join public.posts post on post.id = shift.post_id
  left join public.events event on event.id = shift.event_id
  where shift.id = target_shift_id
  for update of shift;

  if not found then
    raise check_violation using message = 'Choose an active shift from a published schedule.';
  end if;

  normalized_windows := private.normalize_vacancy_patrol_hit_windows(
    target_hit_windows,
    shift_record.starts_at,
    shift_record.ends_at
  );
  request_fingerprint := md5(jsonb_build_object(
    'shiftId', target_shift_id,
    'requestedRouteId', target_requested_route_id,
    'reason', btrim(target_reason),
    'hitWindows', normalized_windows
  )::text);

  select request.*
  into existing_request
  from public.vacancy_patrol_recovery_requests request
  where request.requested_by = actor_id
    and request.idempotency_key = target_idempotency_key;

  if found then
    if existing_request.request_fingerprint <> request_fingerprint then
      raise unique_violation using message = 'This idempotency key was already used for different Patrol recovery details.';
    end if;
    return jsonb_build_object(
      'requestId', existing_request.id,
      'requestNumber', existing_request.request_number,
      'status', 'requested',
      'idempotentReplay', true,
      'createdAt', existing_request.created_at
    );
  end if;

  if shift_record.canceled_at is not null or shift_record.schedule_status <> 'published' then
    raise check_violation using message = 'Choose an active shift from a published schedule.';
  end if;
  if shift_record.ends_at <= clock_timestamp() then
    raise check_violation using message = 'Patrol recovery can only be requested before the source shift ends.';
  end if;
  if not shift_record.is_open then
    raise check_violation using message = 'Patrol recovery is limited to open regular post vacancies.';
  end if;
  if shift_record.work_type <> 'post' or shift_record.assignment_type <> 'standard' then
    raise check_violation using message = 'Patrol recovery is limited to regular post vacancies.';
  end if;
  if exists (
    select 1
    from public.shift_assignments assignment
    where assignment.shift_id = target_shift_id
      and assignment.status in ('assigned', 'confirmed', 'completed')
  ) then
    raise check_violation using message = 'Patrol recovery is only available for a regular unassigned vacancy.';
  end if;
  if exists (select 1 from public.call_off_reports report where report.shift_id = target_shift_id)
     or exists (
       select 1
       from public.attendance_accountability_events occurrence
       where occurrence.shift_id = target_shift_id
         and occurrence.status <> 'voided'
     ) then
    raise check_violation using message = 'Use the established absence workflow for a shift with an attendance occurrence.';
  end if;

  select route.*
  into route_record
  from public.patrol_routes route
  where route.id = target_requested_route_id
    and route.status = 'active'
    and route.current_version_id is not null;

  if not found then
    raise check_violation using message = 'Choose an active Patrol route.';
  end if;
  if shift_record.requires_armed and not route_record.requires_armed then
    raise check_violation using message = 'An armed vacancy requires an armed Patrol route.';
  end if;
  if not exists (
    select 1
    from public.patrol_route_stops route_stop
    join public.patrol_stop_requirements requirement on requirement.stop_id = route_stop.id
    left join public.posts route_stop_post on route_stop_post.id = route_stop.post_id
    where route_stop.route_version_id = route_record.current_version_id
      and requirement.status = 'active'
      and requirement.day_of_week = extract(dow from shift_record.starts_at at time zone route_record.time_zone)::smallint
      and (
        (shift_record.post_id is not null and route_stop.post_id = shift_record.post_id)
        or (
          shift_record.post_id is null
          and shift_record.source_site_id is not null
          and coalesce(route_stop.site_id, route_stop_post.site_id) = shift_record.source_site_id
        )
      )
  ) then
    raise check_violation using message = 'The requested Patrol route has no active source-location hit requirements for this service day. Add the vacant post or site to an active route first.';
  end if;

  if exists (
    select 1
    from public.vacancy_patrol_recovery_requests request
    where request.source_shift_id = target_shift_id
  ) then
    raise unique_violation using message = 'This vacancy already has a Patrol recovery request.';
  end if;

  insert into public.vacancy_patrol_recovery_requests (
    source_shift_id, requested_route_id, requested_route_version_id, reason,
    requested_by, idempotency_key, request_fingerprint
  ) values (
    target_shift_id, route_record.id, route_record.current_version_id, btrim(target_reason),
    actor_id, target_idempotency_key, request_fingerprint
  )
  returning * into created_request;

  insert into public.vacancy_patrol_recovery_hit_windows (
    request_id, plan_version, sequence_number, window_start_at, window_end_at,
    planned_hits, created_by
  )
  select
    created_request.id,
    1,
    window_item.ordinality::integer,
    (window_item.value ->> 'windowStartAt')::timestamptz,
    (window_item.value ->> 'windowEndAt')::timestamptz,
    (window_item.value ->> 'plannedHits')::integer,
    actor_id
  from jsonb_array_elements(normalized_windows) with ordinality as window_item(value, ordinality);

  insert into public.vacancy_patrol_recovery_status_history (
    request_id, action, from_status, to_status, note, actor_employee_id, idempotency_key, metadata
  ) values (
    created_request.id, 'requested', null, 'requested', btrim(target_reason), actor_id,
    target_idempotency_key,
    jsonb_build_object(
      'sourceShiftId', target_shift_id,
      'requestedRouteId', route_record.id,
      'requestedRouteVersionId', route_record.current_version_id,
      'hitWindows', normalized_windows
    )
  );

  insert into private.audit_events (
    auth_user_id, employee_id, schema_name, table_name, operation, row_id, new_record
  ) values (
    (select auth.uid()), actor_id, 'public', 'vacancy_patrol_recovery_requests',
    'request', created_request.id::text,
    jsonb_build_object(
      'requestNumber', created_request.request_number,
      'sourceShiftId', target_shift_id,
      'requestedRouteId', route_record.id,
      'plannedHits', (
        select sum((item.value ->> 'plannedHits')::integer)
        from jsonb_array_elements(normalized_windows) item(value)
      ),
      'preservedUnassignedShift', true,
      'callOffCreated', false,
      'attendanceOccurrenceCreated', false
    )
  );

  for patrol_manager in
    select employee.id
    from public.employees employee
    where employee.status = 'active'
      and 'patrol.assignments.manage' = any(coalesce(
        private.employee_effective_permissions(employee.id), array[]::text[]
      ))
  loop
    perform private.create_employee_notification(
      patrol_manager.id,
      'vacancy_patrol_recovery',
      created_request.id,
      concat('vacancy-patrol-requested:', created_request.id, ':employee:', patrol_manager.id),
      'Patrol vacancy recovery requested',
      concat(created_request.request_number, ' needs Patrol route acceptance and an assigned employee.'),
      'urgent',
      true,
      '/patrol/recovery',
      'Review request',
      actor_id,
      null,
      shift_record.ends_at
    );
  end loop;

  return jsonb_build_object(
    'requestId', created_request.id,
    'requestNumber', created_request.request_number,
    'status', created_request.status,
    'idempotentReplay', false,
    'createdAt', created_request.created_at
  );
end
$$;

create or replace function private.sync_vacancy_patrol_recovery(
  target_request_id uuid,
  target_actor_id uuid default null,
  target_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  recovery public.vacancy_patrol_recovery_requests%rowtype;
  planned_hits integer := 0;
  completed_hits integer := 0;
  missed_hits integer := 0;
  next_status text;
  history_action text;
  finance_employee record;
begin
  select request.*
  into recovery
  from public.vacancy_patrol_recovery_requests request
  where request.id = target_request_id
  for update;

  if not found then
    raise no_data_found using message = 'The Patrol vacancy-recovery request was not found.';
  end if;

  select
    count(*)::integer,
    count(*) filter (where obligation.status = 'completed')::integer,
    count(*) filter (where obligation.status = 'missed')::integer
  into planned_hits, completed_hits, missed_hits
  from public.patrol_hit_obligations obligation
  join public.vacancy_patrol_recovery_hit_windows hit_window
    on hit_window.id = obligation.recovery_hit_window_id
  where hit_window.request_id = recovery.id
    and hit_window.plan_version = recovery.current_plan_version
    and hit_window.superseded_at is null;

  if recovery.status not in ('patrol_planned', 'in_progress', 'completed') then
    return jsonb_build_object(
      'status', recovery.status,
      'plannedHits', planned_hits,
      'completedHits', completed_hits,
      'missedHits', missed_hits
    );
  end if;

  next_status := case
    when planned_hits > 0 and completed_hits + missed_hits = planned_hits then 'completed'
    when completed_hits > 0 or missed_hits > 0 then 'in_progress'
    else 'patrol_planned'
  end;

  if recovery.status = 'completed' then
    next_status := 'completed';
  end if;

  if next_status is distinct from recovery.status then
    history_action := case when next_status = 'completed' then 'completed' else 'patrol_progress' end;

    update public.vacancy_patrol_recovery_requests request
    set status = next_status,
        completed_at = case when next_status = 'completed' then coalesce(request.completed_at, clock_timestamp()) else null end,
        updated_at = clock_timestamp()
    where request.id = recovery.id;

    insert into public.vacancy_patrol_recovery_status_history (
      request_id, action, from_status, to_status, note, actor_employee_id, idempotency_key, metadata
    ) values (
      recovery.id,
      history_action,
      recovery.status,
      next_status,
      case when next_status = 'completed'
        then format(
          'Every planned Patrol recovery obligation reached a terminal outcome: %s completed and %s missed.',
          completed_hits,
          missed_hits
        )
        else 'Patrol recovery work started or a planned hit became overdue.'
      end,
      target_actor_id,
      target_idempotency_key,
      jsonb_build_object(
        'plannedHits', planned_hits,
        'completedHits', completed_hits,
        'missedHits', missed_hits
      )
    );

    insert into private.audit_events (
      auth_user_id, employee_id, schema_name, table_name, operation, row_id, old_record, new_record
    ) values (
      (select auth.uid()), target_actor_id, 'public', 'vacancy_patrol_recovery_requests',
      history_action, recovery.id::text,
      jsonb_build_object('status', recovery.status),
      jsonb_build_object(
        'status', next_status,
        'plannedHits', planned_hits,
        'completedHits', completed_hits,
        'missedHits', missed_hits
      )
    );

    if next_status = 'completed' then
      perform private.create_employee_notification(
        recovery.requested_by,
        'vacancy_patrol_recovery',
        recovery.id,
        concat('vacancy-patrol-completed:', recovery.id, ':requester:', recovery.requested_by),
        'Patrol vacancy recovery reconciled',
        concat(
          recovery.request_number, ' is reconciled: ', completed_hits, ' completed and ', missed_hits,
          ' missed of ', planned_hits, ' planned Patrol hits.'
        ),
        'important',
        false,
        '/schedule',
        'Review recovery',
        target_actor_id,
        null,
        null
      );

      for finance_employee in
        select employee.id
        from public.employees employee
        where employee.status = 'active'
          and 'patrol.recovery.finance.view' = any(coalesce(
            private.employee_effective_permissions(employee.id), array[]::text[]
          ))
      loop
        perform private.create_employee_notification(
          finance_employee.id,
          'vacancy_patrol_recovery',
          recovery.id,
          concat('vacancy-patrol-finance:', recovery.id, ':employee:', finance_employee.id),
          'Patrol recovery ready for Finance review',
          concat(
            recovery.request_number, ' is reconciled with ', completed_hits, ' completed and ', missed_hits,
            ' missed of ', planned_hits, ' planned Patrol hits and is ready for billing disposition.'
          ),
          'important',
          false,
          '/reports/vacancyPatrolFinance',
          'Review billing',
          target_actor_id,
          null,
          null
        );
      end loop;
    end if;
  end if;

  return jsonb_build_object(
    'status', next_status,
    'plannedHits', planned_hits,
    'completedHits', completed_hits,
    'missedHits', missed_hits
  );
end
$$;

create or replace function private.sync_vacancy_patrol_recovery_from_obligation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_request_id uuid;
  actor_id uuid;
begin
  if new.recovery_hit_window_id is null then
    return new;
  end if;

  select hit_window.request_id
  into target_request_id
  from public.vacancy_patrol_recovery_hit_windows hit_window
  where hit_window.id = new.recovery_hit_window_id;

  if new.completed_hit_id is not null then
    select hit.submitted_by
    into actor_id
    from public.patrol_hits hit
    where hit.id = new.completed_hit_id;
  end if;

  perform private.sync_vacancy_patrol_recovery(
    target_request_id,
    actor_id,
    coalesce(new.completed_hit_id, new.id)
  );
  return new;
end
$$;

create trigger sync_vacancy_patrol_recovery_obligation
after update of status, completed_hit_id on public.patrol_hit_obligations
for each row
when (
  new.recovery_hit_window_id is not null
  and (old.status is distinct from new.status or old.completed_hit_id is distinct from new.completed_hit_id)
)
execute function private.sync_vacancy_patrol_recovery_from_obligation();

-- An assignments-only Patrol manager must be able to open the existing Patrol
-- workspace, but that focused permission must not become general route authority.
do $patch_patrol_workspace$
declare
  prior_definition text;
  patched_definition text;
begin
  select pg_get_functiondef('public.get_patrol_workspace()'::regprocedure)
  into prior_definition;

  patched_definition := replace(
    prior_definition,
    $old$    or public.has_effective_permission('patrol.manage')
  ) then$old$,
    $new$    or public.has_effective_permission('patrol.manage')
    or public.has_effective_permission('patrol.assignments.manage')
  ) then$new$
  );
  patched_definition := replace(
    patched_definition,
    $old$  can_operate := can_manage or public.has_effective_permission('patrol.operations.view');$old$,
    $new$  can_operate := can_manage
    or public.has_effective_permission('patrol.operations.view')
    or public.has_effective_permission('patrol.assignments.manage');$new$
  );
  patched_definition := replace(
    patched_definition,
    $old$            'completedHitId', obligation.completed_hit_id,
            'allowPhotos', stop.allow_photos,$old$,
    $new$            'completedHitId', obligation.completed_hit_id,
            'source', obligation.source,
            'recoveryHitWindowId', obligation.recovery_hit_window_id,
            'allowPhotos', stop.allow_photos,$new$
  );

  if patched_definition = prior_definition
     or position($needle$public.has_effective_permission('patrol.assignments.manage')$needle$ in patched_definition) = 0
     or position($needle$'recoveryHitWindowId', obligation.recovery_hit_window_id$needle$ in patched_definition) = 0 then
    raise check_violation using message = 'The Patrol workspace assignment-manager admission guard could not be patched safely.';
  end if;

  execute patched_definition;
end
$patch_patrol_workspace$;

create or replace function private.get_vacancy_patrol_recovery_payload(
  target_request_id uuid,
  target_include_candidates boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  payload jsonb;
begin
  select jsonb_build_object(
    'requestId', recovery.id,
    'requestNumber', recovery.request_number,
    'status', recovery.status,
    'displayStage', private.vacancy_patrol_display_stage(recovery.status, recovery.billing_disposition),
    'shift', jsonb_build_object(
      'shiftId', shift.id,
      'scheduleId', schedule.id,
      'scheduleName', null,
      'weekStartsOn', schedule.week_starts_on,
      'startsAt', shift.starts_at,
      'endsAt', shift.ends_at,
      'timeZone', shift.time_zone,
      'requiresArmed', shift.requires_armed,
      'clientId', client.id,
      'clientName', client.display_name,
      'siteId', coalesce(post_site.id, event_site.id),
      'siteName', coalesce(post_site.name, event_site.name, event.location_name),
      'postId', post.id,
      'postName', post.name,
      'isPublished', schedule.status = 'published',
      'isUnassigned', not exists (
        select 1
        from public.shift_assignments shift_assignment
        where shift_assignment.shift_id = shift.id
          and shift_assignment.status in ('assigned', 'confirmed', 'completed')
      )
    ),
    'requestedRoute', jsonb_build_object(
      'routeId', requested_route.id,
      'routeVersionId', recovery.requested_route_version_id,
      'code', requested_route.code,
      'name', requested_route.name,
      'requiresArmed', requested_route.requires_armed,
      'timeZone', requested_route.time_zone
    ),
    'acceptedRoute', case when accepted_route.id is null then null else jsonb_build_object(
      'routeId', accepted_route.id,
      'routeVersionId', recovery.accepted_route_version_id,
      'code', accepted_route.code,
      'name', accepted_route.name,
      'requiresArmed', accepted_route.requires_armed,
      'timeZone', accepted_route.time_zone
    ) end,
    'assignedEmployee', case when assigned_employee.id is null then null else jsonb_build_object(
      'employeeId', assigned_employee.id,
      'employeeNumber', assigned_employee.employee_number,
      'name', concat_ws(' ', assigned_employee.first_name, assigned_employee.last_name)
    ) end,
    'reason', recovery.reason,
    'hitWindows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'hitWindowId', hit_window.id,
        'sequence', hit_window.sequence_number,
        'windowStartAt', hit_window.window_start_at,
        'windowEndAt', hit_window.window_end_at,
        'plannedHits', hit_window.planned_hits,
        'completedHits', hit_counts.completed_hits,
        'missedHits', hit_counts.missed_hits,
        'remainingHits', greatest(hit_window.planned_hits - hit_counts.completed_hits - hit_counts.missed_hits, 0),
        'status', case
          when hit_counts.completed_hits >= hit_window.planned_hits then 'completed'
          when hit_counts.missed_hits >= hit_window.planned_hits and hit_counts.completed_hits = 0 then 'missed'
          when hit_counts.completed_hits > 0 or hit_counts.missed_hits > 0 then 'partial'
          else 'planned'
        end
      ) order by hit_window.sequence_number)
      from public.vacancy_patrol_recovery_hit_windows hit_window
      cross join lateral (
        select
          count(*) filter (where obligation.status = 'completed')::integer as completed_hits,
          count(*) filter (where obligation.status = 'missed')::integer as missed_hits
        from public.patrol_hit_obligations obligation
        where obligation.recovery_hit_window_id = hit_window.id
      ) hit_counts
      where hit_window.request_id = recovery.id
        and hit_window.plan_version = recovery.current_plan_version
        and hit_window.superseded_at is null
    ), '[]'::jsonb),
    'patrolAssignmentId', recovery.patrol_assignment_id,
    'plannedHits', coalesce((
      select sum(hit_window.planned_hits)::integer
      from public.vacancy_patrol_recovery_hit_windows hit_window
      where hit_window.request_id = recovery.id
        and hit_window.plan_version = recovery.current_plan_version
        and hit_window.superseded_at is null
    ), 0),
    'completedHits', (
      select count(*)::integer
      from public.patrol_hit_obligations obligation
      join public.vacancy_patrol_recovery_hit_windows hit_window
        on hit_window.id = obligation.recovery_hit_window_id
      where hit_window.request_id = recovery.id
        and hit_window.plan_version = recovery.current_plan_version
        and hit_window.superseded_at is null
        and obligation.status = 'completed'
    ),
    'missedHits', (
      select count(*)::integer
      from public.patrol_hit_obligations obligation
      join public.vacancy_patrol_recovery_hit_windows hit_window
        on hit_window.id = obligation.recovery_hit_window_id
      where hit_window.request_id = recovery.id
        and hit_window.plan_version = recovery.current_plan_version
        and hit_window.superseded_at is null
        and obligation.status = 'missed'
    ),
    'billingDisposition', recovery.billing_disposition,
    'billingReference', recovery.billing_reference,
    'billingReason', recovery.billing_reason,
    'billingReviewedAt', recovery.billing_reviewed_at,
    'statusHistory', coalesce((
      select jsonb_agg(jsonb_build_object(
        'historyId', history.id,
        'action', history.action,
        'fromStatus', history.from_status,
        'toStatus', history.to_status,
        'note', history.note,
        'actorEmployeeId', history.actor_employee_id,
        'actorName', case when history_actor.id is null then null else concat_ws(' ', history_actor.first_name, history_actor.last_name) end,
        'createdAt', history.created_at,
        'metadata', history.metadata
      ) order by history.created_at, history.id)
      from public.vacancy_patrol_recovery_status_history history
      left join public.employees history_actor on history_actor.id = history.actor_employee_id
      where history.request_id = recovery.id
    ), '[]'::jsonb),
    'routeChoices', case when target_include_candidates then coalesce((
      select jsonb_agg(jsonb_build_object(
        'routeId', route.id,
        'routeVersionId', route.current_version_id,
        'code', route.code,
        'name', route.name,
        'requiresArmed', route.requires_armed,
        'timeZone', route.time_zone,
        'isRequestedRoute', route.id = recovery.requested_route_id
      ) order by (route.id = recovery.requested_route_id) desc, route.name)
      from public.patrol_routes route
      where route.status = 'active'
        and route.current_version_id is not null
        and (not shift.requires_armed or route.requires_armed)
        and exists (
          select 1
          from public.patrol_route_stops route_stop
          join public.patrol_stop_requirements requirement on requirement.stop_id = route_stop.id
          left join public.posts route_stop_post on route_stop_post.id = route_stop.post_id
          where route_stop.route_version_id = route.current_version_id
            and requirement.status = 'active'
            and requirement.day_of_week = extract(dow from shift.starts_at at time zone route.time_zone)::smallint
            and (
              (shift.post_id is not null and route_stop.post_id = shift.post_id)
              or (
                shift.post_id is null
                and coalesce(post_site.id, event_site.id) is not null
                and coalesce(route_stop.site_id, route_stop_post.site_id) = coalesce(post_site.id, event_site.id)
              )
            )
        )
    ), '[]'::jsonb) else '[]'::jsonb end,
    'employeeChoices', case when target_include_candidates then coalesce((
      select jsonb_agg(jsonb_build_object(
        'employeeId', employee.id,
        'employeeNumber', employee.employee_number,
        'name', concat_ws(' ', employee.first_name, employee.last_name),
        'armedQualified', public.has_valid_credential(
          employee.id,
          'armed_guard',
          (shift.starts_at at time zone shift.time_zone)::date
        )
      ) order by employee.last_name, employee.first_name, employee.id)
      from public.employees employee
      where employee.status = 'active'
        and 'patrol.hits.complete' = any(coalesce(
          private.employee_effective_permissions(employee.id), array[]::text[]
        ))
        and 'patrol.self.view' = any(coalesce(
          private.employee_effective_permissions(employee.id), array[]::text[]
        ))
    ), '[]'::jsonb) else '[]'::jsonb end,
    'permissions', jsonb_build_object(
      'canAccept', private.vacancy_patrol_can_manage(),
      'canUpdate', private.vacancy_patrol_can_manage(),
      'canReviewBilling', private.vacancy_patrol_can_review_billing()
    ),
    'requestedAt', recovery.requested_at,
    'acceptedAt', recovery.accepted_at,
    'completedAt', recovery.completed_at,
    'createdAt', recovery.created_at,
    'updatedAt', recovery.updated_at
  )
  into payload
  from public.vacancy_patrol_recovery_requests recovery
  join public.shifts shift on shift.id = recovery.source_shift_id
  join public.schedules schedule on schedule.id = shift.schedule_id
  left join public.posts post on post.id = shift.post_id
  left join public.sites post_site on post_site.id = post.site_id
  left join public.events event on event.id = shift.event_id
  left join public.sites event_site on event_site.id = event.site_id
  left join public.clients client on client.id = coalesce(post_site.client_id, event_site.client_id)
  join public.patrol_routes requested_route on requested_route.id = recovery.requested_route_id
  left join public.patrol_routes accepted_route on accepted_route.id = recovery.accepted_route_id
  left join public.employees assigned_employee on assigned_employee.id = recovery.assigned_employee_id
  where recovery.id = target_request_id;

  if payload is null then
    raise no_data_found using message = 'The Patrol vacancy-recovery request was not found.';
  end if;
  return payload;
end
$$;

revoke all on function private.vacancy_patrol_can_request() from public, anon, authenticated;
revoke all on function private.vacancy_patrol_can_manage() from public, anon, authenticated;
revoke all on function private.vacancy_patrol_can_view_finance() from public, anon, authenticated;
revoke all on function private.vacancy_patrol_can_review_billing() from public, anon, authenticated;
revoke all on function private.vacancy_patrol_can_export_finance() from public, anon, authenticated;
revoke all on function private.vacancy_patrol_display_stage(text, text) from public, anon, authenticated;
revoke all on function private.normalize_vacancy_patrol_hit_windows(jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.sync_vacancy_patrol_recovery(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.sync_vacancy_patrol_recovery_from_obligation() from public, anon, authenticated;
revoke all on function private.get_vacancy_patrol_recovery_payload(uuid, boolean) from public, anon, authenticated;

revoke all on function public.get_vacancy_patrol_recovery_bootstrap(uuid) from public, anon, authenticated;
revoke all on function public.create_vacancy_patrol_recovery(uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.get_vacancy_patrol_recovery_map(date) from public, anon, authenticated;
revoke all on function public.get_vacancy_patrol_recovery(uuid) from public, anon, authenticated;
revoke all on function public.get_vacancy_patrol_recovery_worklist(date, date, text) from public, anon, authenticated;
revoke all on function public.accept_vacancy_patrol_recovery(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.update_vacancy_patrol_recovery(uuid, text, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.get_vacancy_patrol_finance_report(date, date, text) from public, anon, authenticated;
revoke all on function public.review_vacancy_patrol_billing(uuid, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.authorize_vacancy_patrol_finance_export(date, date, text) from public, anon, authenticated;

grant execute on function public.get_vacancy_patrol_recovery_bootstrap(uuid) to authenticated;
grant execute on function public.create_vacancy_patrol_recovery(uuid, uuid, text, jsonb, uuid) to authenticated;
grant execute on function public.get_vacancy_patrol_recovery_map(date) to authenticated;
grant execute on function public.get_vacancy_patrol_recovery(uuid) to authenticated;
grant execute on function public.get_vacancy_patrol_recovery_worklist(date, date, text) to authenticated;
grant execute on function public.accept_vacancy_patrol_recovery(uuid, uuid, uuid, text, uuid) to authenticated;
grant execute on function public.update_vacancy_patrol_recovery(uuid, text, text, jsonb, uuid) to authenticated;
grant execute on function public.get_vacancy_patrol_finance_report(date, date, text) to authenticated;
grant execute on function public.review_vacancy_patrol_billing(uuid, text, text, text, uuid) to authenticated;
grant execute on function public.authorize_vacancy_patrol_finance_export(date, date, text) to authenticated;

comment on table public.vacancy_patrol_recovery_requests is
  'Durable regular-vacancy to Patrol service-recovery requests. Source shifts remain published and unassigned; Finance review never creates a charge automatically.';
comment on table public.vacancy_patrol_recovery_hit_windows is
  'Versioned, non-overlapping Patrol recovery hit windows retained across pre-acceptance plan updates.';
comment on table public.vacancy_patrol_recovery_status_history is
  'Append-only operational and Finance status history for Patrol vacancy recovery.';
comment on column public.patrol_hit_obligations.source is
  'Identifies ordinary route-plan obligations versus vacancy-recovery obligations.';
comment on column public.patrol_hit_obligations.recovery_hit_window_id is
  'Links a genuine My Patrol obligation to its durable vacancy-recovery hit window.';
comment on function public.get_vacancy_patrol_recovery_bootstrap(uuid) is
  'Returns one published shift, an existing recovery if present, eligible active routes, defaults, and initiation authority.';
comment on function public.create_vacancy_patrol_recovery(uuid, uuid, text, jsonb, uuid) is
  'Atomically requests idempotent Patrol recovery for a regular unassigned published shift without creating attendance or call-off data.';
comment on function public.get_vacancy_patrol_recovery_map(date) is
  'Returns permission-scoped persistent Schedule card stages for one Sunday-through-Saturday week.';
comment on function public.get_vacancy_patrol_recovery_worklist(date, date, text) is
  'Returns the bounded Patrol management queue, detailed history, route choices, and eligible employees.';
comment on function public.accept_vacancy_patrol_recovery(uuid, uuid, uuid, text, uuid) is
  'Accepts a requested recovery and creates an idempotent Patrol assignment plus genuine required-hit obligations while preserving the source vacancy.';
comment on function public.update_vacancy_patrol_recovery(uuid, text, text, jsonb, uuid) is
  'Applies an idempotent pre-acceptance plan update, decline, cancellation, or completion reconciliation.';
comment on function public.get_vacancy_patrol_finance_report(date, date, text) is
  'Returns bounded Patrol recovery service and billing-disposition reporting to Finance-authorized MFA sessions.';
comment on function public.review_vacancy_patrol_billing(uuid, text, text, text, uuid) is
  'Records an idempotent Finance disposition with audit history; it does not create an invoice or charge.';
comment on function public.authorize_vacancy_patrol_finance_export(date, date, text) is
  'Creates an audit receipt before an authorized Patrol recovery Finance export.';

-- The legacy My Patrol submit function used an unqualified evidence column
-- that PostgreSQL resolves ambiguously against its local hit_id variable.
-- Patch only that predicate so recovery obligations can use the existing,
-- audited Patrol completion path without changing any of its behavior.
do $patch_patrol_evidence_predicate$
declare
  original_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,uuid,boolean)'::regprocedure
  ) into original_definition;

  patched_definition := regexp_replace(
    original_definition,
    $pattern$hit_id\s+uuid;$pattern$,
    'saved_hit_id uuid;',
    'i'
  );
  patched_definition := regexp_replace(
    patched_definition,
    $pattern$from\s+public\.patrol_hit_evidence\s+where\s+hit_id\s*=\s*save_patrol_hit\.hit_id\s+and\s+status\s*=\s*'stored'$pattern$,
    $replacement$from public.patrol_hit_evidence evidence where evidence.hit_id = saved_hit_id and evidence.status = 'stored'$replacement$,
    'i'
  );
  patched_definition := regexp_replace(patched_definition, $pattern$into\s+hit_id$pattern$, 'into saved_hit_id', 'gi');
  patched_definition := regexp_replace(patched_definition, $pattern$if\s+hit_id\s+is\s+null$pattern$, 'if saved_hit_id is null', 'gi');
  patched_definition := regexp_replace(patched_definition, $pattern$where\s+id\s*=\s*hit_id$pattern$, 'where id = saved_hit_id', 'gi');
  patched_definition := regexp_replace(patched_definition, $pattern$completed_hit_id\s*=\s*hit_id$pattern$, 'completed_hit_id = saved_hit_id', 'gi');
  patched_definition := regexp_replace(patched_definition, $pattern$'submit',\s*hit_id::text$pattern$, $replacement$'submit', saved_hit_id::text$replacement$, 'gi');
  patched_definition := regexp_replace(patched_definition, $pattern$return\s+hit_id;$pattern$, 'return saved_hit_id;', 'gi');

  if patched_definition = original_definition then
    if position(
      'evidence.hit_id = saved_hit_id' in original_definition
    ) = 0 then
      raise check_violation using message = 'The My Patrol evidence predicate did not match its reviewed source.';
    end if;
  else
    execute patched_definition;
  end if;
end
$patch_patrol_evidence_predicate$;

do $vacancy_patrol_release_checks$
declare
  baseline vacancy_patrol_preservation_baseline%rowtype;
  workspace_definition text;
  save_hit_definition text;
begin
  select * into strict baseline from vacancy_patrol_preservation_baseline;

  if baseline.shift_count <> (select count(*) from public.shifts)
     or baseline.shift_assignment_count <> (select count(*) from public.shift_assignments)
     or baseline.call_off_count <> (select count(*) from public.call_off_reports)
     or baseline.attendance_occurrence_count <> (select count(*) from public.attendance_accountability_events)
     or baseline.time_event_count <> (select count(*) from public.time_events) then
    raise check_violation using message = 'The Patrol recovery migration changed existing schedule, attendance, call-off, or timekeeping rows.';
  end if;

  select pg_get_functiondef('public.get_patrol_workspace()'::regprocedure)
  into workspace_definition;
  if position($needle$public.has_effective_permission('patrol.assignments.manage')$needle$ in workspace_definition) = 0 then
    raise check_violation using message = 'The Patrol workspace does not admit an effective assignment manager.';
  end if;
  if position($needle$'recoveryHitWindowId', obligation.recovery_hit_window_id$needle$ in workspace_definition) = 0 then
    raise check_violation using message = 'The My Patrol workspace does not expose recovery obligation metadata.';
  end if;

  select pg_get_functiondef(
    'public.save_patrol_hit(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,timestamp with time zone,uuid,boolean)'::regprocedure
  ) into save_hit_definition;
  if position('evidence.hit_id = saved_hit_id' in save_hit_definition) = 0
     or position('saved_hit_id uuid' in save_hit_definition) = 0 then
    raise check_violation using message = 'The My Patrol evidence predicate remains ambiguous.';
  end if;

  if has_table_privilege('authenticated', 'public.vacancy_patrol_recovery_requests', 'select')
     or has_table_privilege('authenticated', 'public.vacancy_patrol_recovery_hit_windows', 'select')
     or has_table_privilege('authenticated', 'public.vacancy_patrol_recovery_status_history', 'select') then
    raise check_violation using message = 'A Patrol recovery table was exposed directly to authenticated clients.';
  end if;
end
$vacancy_patrol_release_checks$;

commit;
