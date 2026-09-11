begin;

-- One post-login checkpoint is derived from existing authoritative records.
-- No action, schedule, document, signature, assignment, or permission record is copied.
create temporary table required_action_checkpoint_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.announcement_acknowledgments) as announcement_count,
  (select count(*) from public.training_assignments) as training_count,
  (select count(*) from public.schedule_acknowledgments) as schedule_count,
  (select count(*) from private.hr_workflow_tasks) as hr_task_count,
  (select count(*) from private.hr_document_assignments) as document_assignment_count,
  (select count(*) from private.signature_recipients) as signature_recipient_count,
  (select count(*) from public.employee_access_roles) as role_assignment_count,
  (select count(*) from public.employee_permission_overrides) as permission_override_count;

create table private.required_action_checkpoint_release (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  rollout_mode text not null default 'canary',
  reason text not null,
  enabled_by uuid references public.employees(id) on delete restrict,
  enabled_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint required_action_checkpoint_rollout_mode check (rollout_mode in ('canary', 'all')),
  constraint required_action_checkpoint_reason_present check (btrim(reason) <> '')
);

insert into private.required_action_checkpoint_release(singleton, enabled, rollout_mode, reason, enabled_by)
select true, true, 'canary', 'Controlled post-login checkpoint canary; expand only after employee and manager acceptance.', employee.id
from public.employees employee
where employee.username = 'jbrown'
limit 1;

insert into private.required_action_checkpoint_release(singleton, enabled, rollout_mode, reason)
values (true, true, 'canary', 'Controlled post-login checkpoint canary; expand only after employee and manager acceptance.')
on conflict (singleton) do nothing;

create table private.required_action_checkpoint_enrollments (
  employee_id uuid primary key references public.employees(id) on delete restrict,
  enabled boolean not null default true,
  reason text not null,
  enrolled_by uuid references public.employees(id) on delete restrict,
  enrolled_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint required_action_checkpoint_enrollment_reason_present check (btrim(reason) <> '')
);

insert into private.required_action_checkpoint_enrollments(employee_id, enabled, reason, enrolled_by)
select employee.id, true, 'Initial owner canary for the mandatory Required Actions Checkpoint.', employee.id
from public.employees employee
join private.employee_accounts account on account.employee_id = employee.id
where employee.username = 'jbrown'
  and employee.status = 'active'
  and account.activated_at is not null
  and account.disabled_at is null
on conflict (employee_id) do nothing;

alter table private.required_action_checkpoint_release enable row level security;
alter table private.required_action_checkpoint_enrollments enable row level security;
revoke all on table private.required_action_checkpoint_release, private.required_action_checkpoint_enrollments from public, anon, authenticated;
grant select, insert, update on private.required_action_checkpoint_release, private.required_action_checkpoint_enrollments to service_role;

create or replace function private.employee_required_action_checkpoint_enrolled(target_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select release.enabled and (
      release.rollout_mode = 'all'
      or exists (
        select 1
        from private.required_action_checkpoint_enrollments enrollment
        where enrollment.employee_id = target_employee_id
          and enrollment.enabled
      )
    )
    from private.required_action_checkpoint_release release
    where release.singleton
  ), false)
$$;

create or replace function private.employee_required_action_checkpoint_rows(target_employee_id uuid)
returns table (
  source_id uuid,
  action_type text,
  title text,
  description text,
  status text,
  priority text,
  priority_rank integer,
  response_kind text,
  action_label text,
  route text,
  assigned_at timestamptz,
  due_at timestamptz,
  viewed_at timestamptz,
  authoritative_version text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  with checkpoint_rows as (
    select
      acknowledgment.id as source_id,
      'announcement'::text as action_type,
      acknowledgment.title_snapshot as title,
      acknowledgment.body_snapshot as description,
      acknowledgment.status,
      case
        when acknowledgment.due_at is not null and acknowledgment.due_at <= clock_timestamp() + interval '24 hours' then 'critical'
        when concat_ws(' ', acknowledgment.title_snapshot, acknowledgment.body_snapshot) ~* '(safety|emergency|hazard|critical)' then 'critical'
        else 'normal'
      end as priority,
      case
        when acknowledgment.due_at is not null and acknowledgment.due_at <= clock_timestamp() + interval '24 hours' then 1
        when concat_ws(' ', acknowledgment.title_snapshot, acknowledgment.body_snapshot) ~* '(safety|emergency|hazard|critical)' then 1
        else 3
      end as priority_rank,
      'acknowledgment'::text as response_kind,
      'Acknowledge receipt'::text as action_label,
      '/actions?checkpoint=required'::text as route,
      acknowledgment.assigned_at,
      acknowledgment.due_at,
      acknowledgment.viewed_at,
      concat('Announcement version ', acknowledgment.announcement_version) as authoritative_version,
      jsonb_build_object(
        'announcementId', acknowledgment.announcement_id,
        'contentDigest', acknowledgment.content_digest,
        'wording', 'Acknowledgment confirms receipt and review; it does not waive an employee response.'
      ) as metadata
    from public.announcement_acknowledgments acknowledgment
    where acknowledgment.employee_id = target_employee_id
      and acknowledgment.status in ('pending', 'viewed')

    union all

    select
      assignment.id,
      'training',
      version.title,
      coalesce(version.description, version.instructions, 'Complete the assigned training and record your attestation.'),
      case when assignment.due_at is not null and assignment.due_at < clock_timestamp() then 'overdue' else assignment.status end,
      case when assignment.due_at is not null and assignment.due_at < clock_timestamp() then 'high' else 'normal' end,
      case when assignment.due_at is not null and assignment.due_at < clock_timestamp() then 2 else 3 end,
      'attestation',
      'Complete training',
      '/actions?checkpoint=required',
      assignment.assigned_at,
      assignment.due_at,
      assignment.viewed_at,
      concat('Training version ', version.version_number),
      jsonb_build_object(
        'courseId', assignment.course_id,
        'versionId', assignment.version_id,
        'contentDigest', version.content_digest,
        'completionRule', version.completion_rule,
        'wording', 'Your attestation records that you completed and reviewed the assigned training.'
      )
    from public.training_assignments assignment
    join public.training_course_versions version on version.id = assignment.version_id
    where assignment.employee_id = target_employee_id
      and assignment.status in ('assigned', 'in_progress')

    union all

    select
      acknowledgment.id,
      'schedule',
      concat('Schedule for week of ', to_char(acknowledgment.week_starts_on, 'MM/DD/YYYY')),
      concat('Review revision ', acknowledgment.schedule_revision, ' and confirm the ', jsonb_array_length(acknowledgment.shifts_snapshot), ' assigned shift', case when jsonb_array_length(acknowledgment.shifts_snapshot) = 1 then '' else 's' end, '.'),
      acknowledgment.status,
      case when acknowledgment.week_starts_on <= (clock_timestamp() at time zone 'America/Denver')::date + 7 then 'critical' else 'high' end,
      case when acknowledgment.week_starts_on <= (clock_timestamp() at time zone 'America/Denver')::date + 7 then 1 else 2 end,
      'confirmation',
      'Confirm schedule',
      '/actions?checkpoint=required',
      acknowledgment.assigned_at,
      null::timestamptz,
      acknowledgment.viewed_at,
      concat('Schedule revision ', acknowledgment.schedule_revision),
      jsonb_build_object(
        'scheduleId', acknowledgment.schedule_id,
        'weekStartsOn', acknowledgment.week_starts_on,
        'shiftsDigest', acknowledgment.shifts_digest,
        'shifts', acknowledgment.shifts_snapshot,
        'wording', 'Confirmation records that you reviewed this exact published schedule revision.'
      )
    from public.schedule_acknowledgments acknowledgment
    where acknowledgment.employee_id = target_employee_id
      and acknowledgment.status in ('pending', 'viewed')
      -- Old schedule revisions remain permanent evidence, but they must not
      -- strand an employee at login after their review window has passed.
      and acknowledgment.week_starts_on >= ((clock_timestamp() at time zone 'America/Denver')::date - 7)

    union all

    select
      task.id,
      'hr_task',
      task.title,
      coalesce(task.instructions, 'Complete the assigned HR action and record what was completed.'),
      case when task.due_at is not null and task.due_at < clock_timestamp() then 'overdue' else task.status end,
      case when task.due_at is not null and task.due_at < clock_timestamp() then 'high' else 'normal' end,
      case when task.due_at is not null and task.due_at < clock_timestamp() then 2 else 3 end,
      'completion',
      'Complete action',
      '/actions?checkpoint=required',
      task.created_at,
      task.due_at,
      task.viewed_at,
      concat('HR workflow ', task.instance_id),
      jsonb_build_object(
        'instanceId', task.instance_id,
        'requiredPermission', task.required_permission,
        'wording', 'Completion records the note you provide and the responsible employee account.'
      )
    from private.hr_workflow_tasks task
    where task.action_center_visible
      and task.assigned_employee_id = target_employee_id
      and task.status in ('open', 'viewed')

    union all

    select
      assignment.id,
      'document',
      document.title,
      assignment.statement_snapshot,
      case when assignment.due_date is not null and assignment.due_date < (clock_timestamp() at time zone 'America/Denver')::date then 'overdue' else assignment.status end,
      case when assignment.due_date is not null and assignment.due_date <= (clock_timestamp() at time zone 'America/Denver')::date then 'high' else 'normal' end,
      case when assignment.due_date is not null and assignment.due_date <= (clock_timestamp() at time zone 'America/Denver')::date then 2 else 3 end,
      case when assignment.requirement_type = 'electronic_signature' then 'signature' else 'acknowledgment' end,
      case when assignment.requirement_type = 'electronic_signature' then 'Review and sign' else 'Review and acknowledge' end,
      '/my-documents?checkpoint=required',
      assignment.created_at,
      case when assignment.due_date is null then null else assignment.due_date::timestamp at time zone 'America/Denver' end,
      null::timestamptz,
      concat('Document version ', version.version_number),
      jsonb_build_object(
        'documentId', assignment.document_id,
        'versionId', assignment.version_id,
        'sourceChecksum', version.sha256_checksum,
        'requirementType', assignment.requirement_type,
        'wording', case when assignment.requirement_type = 'electronic_signature' then 'A legal electronic signature is recorded separately from an acknowledgment.' else 'Acknowledgment confirms receipt and review; it does not mean agreement.' end
      )
    from private.hr_document_assignments assignment
    join private.hr_documents document on document.id = assignment.document_id and document.archived_at is null
    join private.hr_document_versions version on version.id = assignment.version_id
    where assignment.employee_id = target_employee_id
      and assignment.status = 'pending'

    union all

    select
      recipient.id,
      'signature',
      envelope.title,
      coalesce(envelope.message, concat('Review ', document.title, ' and record the requested ', replace(recipient.required_action, '_', ' '), '.')),
      recipient.status,
      case when envelope.expires_at is not null and envelope.expires_at <= clock_timestamp() + interval '24 hours' then 'high' else 'normal' end,
      case when envelope.expires_at is not null and envelope.expires_at <= clock_timestamp() + interval '24 hours' then 2 else 3 end,
      case when recipient.required_action in ('sign', 'initial', 'countersign', 'witness') then 'signature' when recipient.required_action = 'acknowledge' then 'acknowledgment' when recipient.required_action = 'certify' then 'attestation' else 'confirmation' end,
      case recipient.required_action when 'sign' then 'Review and sign' when 'initial' then 'Review and initial' when 'acknowledge' then 'Acknowledge receipt' when 'certify' then 'Review and certify' when 'approve' then 'Review and approve' when 'fill' then 'Complete document' when 'review' then 'Review document' else 'Complete document action' end,
      '/my-documents?checkpoint=required',
      recipient.assigned_at,
      envelope.expires_at,
      recipient.viewed_at,
      concat('Document version ', version.version_number),
      jsonb_build_object(
        'envelopeId', envelope.id,
        'documentId', envelope.document_id,
        'documentVersionId', envelope.document_version_id,
        'sourceChecksum', version.sha256_checksum,
        'requiredAction', recipient.required_action,
        'allowsDecline', policy.allows_decline,
        'allowsCorrectionRequest', policy.allows_correction_request,
        'wording', case when recipient.required_action in ('sign', 'initial', 'countersign', 'witness') then 'This action uses the separately validated legal electronic-signature workflow.' else 'The recorded response applies only to this exact document version.' end
      )
    from private.signature_recipients recipient
    join private.signature_envelopes envelope on envelope.id = recipient.envelope_id
    join private.hr_documents document on document.id = envelope.document_id and document.archived_at is null
    join private.hr_document_versions version on version.id = envelope.document_version_id
    join private.document_policies policy on policy.id = envelope.policy_id
    where recipient.employee_id = target_employee_id
      and recipient.status in ('pending', 'delivered', 'viewed', 'in_progress')
      and envelope.status in ('sent', 'delivered', 'viewed', 'in_progress', 'waiting')
      and (envelope.expires_at is null or envelope.expires_at > clock_timestamp())
      and (
        envelope.routing_mode = 'parallel'
        or not exists (
          select 1
          from private.signature_recipients prior
          where prior.envelope_id = envelope.id
            and prior.routing_order < recipient.routing_order
            and prior.status <> 'completed'
        )
      )
  )
  select * from checkpoint_rows
  where private.employee_required_action_checkpoint_enrolled(target_employee_id)
$$;

create or replace function private.employee_has_blocking_required_actions(target_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.employee_required_action_checkpoint_rows(target_employee_id)
  )
$$;

-- Limit effective permissions while a checkpoint is active. This makes the
-- same boundary apply to permission-checked database calls, not only routing.
create or replace function private.employee_effective_permissions(target_employee_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  with employee_record as (
    select employee.id, employee.role
    from public.employees employee
    where employee.id = target_employee_id
      and employee.status = 'active'
    limit 1
  ),
  base_roles as (
    select access_role.id
    from public.access_roles access_role
    join employee_record employee on access_role.base_app_role = employee.role
    where access_role.system_role and access_role.active
  ),
  assigned_roles as (
    select access_role.id
    from public.employee_access_roles assignment
    join public.access_roles access_role on access_role.id = assignment.role_id
    join employee_record employee on employee.id = assignment.employee_id
    where access_role.active
  ),
  role_grants as (
    select permission.permission_code
    from public.access_role_permissions permission
    join (select id from base_roles union select id from assigned_roles) role_scope on role_scope.id = permission.role_id
    join public.permission_catalog catalog on catalog.code = permission.permission_code
    where permission.enabled and catalog.active
  ),
  direct_grants as (
    select override.permission_code
    from public.employee_permission_overrides override
    join public.permission_catalog catalog on catalog.code = override.permission_code
    where override.employee_id = target_employee_id
      and override.active and override.effect = 'grant' and catalog.active
  ),
  direct_denies as (
    select override.permission_code
    from public.employee_permission_overrides override
    where override.employee_id = target_employee_id
      and override.active and override.effect = 'deny'
  ),
  granted_permissions as (
    select permission_code from role_grants
    union
    select permission_code from direct_grants
  ),
  allowed_during_checkpoint(permission_code) as (
    values
      ('actions.self.view'::text),
      ('time.punch'::text),
      ('time.self.view'::text),
      ('accountability.report_call_off'::text),
      ('documents.signatures.sign_own'::text)
  )
  select coalesce(array_agg(distinct granted.permission_code order by granted.permission_code), array[]::text[])
  from granted_permissions granted
  where not exists (
    select 1 from direct_denies denied where denied.permission_code = granted.permission_code
  )
    and (
      not private.employee_has_blocking_required_actions(target_employee_id)
      or exists (
        select 1 from allowed_during_checkpoint allowed where allowed.permission_code = granted.permission_code
      )
    )
$$;

create or replace function public.get_required_action_checkpoint()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  result jsonb;
begin
  if actor_id is null
     or not exists (
       select 1
       from public.employees employee
       join private.employee_accounts account on account.employee_id = employee.id
       where employee.id = actor_id
         and employee.status = 'active'
         and account.activated_at is not null
         and account.disabled_at is null
     ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;

  with ordered as (
    select row_number() over (order by item.priority_rank, item.due_at nulls last, item.assigned_at, item.source_id) as position, item.*
    from private.employee_required_action_checkpoint_rows(actor_id) item
  )
  select jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'rollout', jsonb_build_object(
      'enabled', coalesce((select release.enabled from private.required_action_checkpoint_release release where release.singleton), false),
      'mode', coalesce((select release.rollout_mode from private.required_action_checkpoint_release release where release.singleton), 'canary'),
      'enrolled', private.employee_required_action_checkpoint_enrolled(actor_id)
    ),
    'blocking', exists(select 1 from ordered),
    'total', (select count(*) from ordered),
    'summary', jsonb_build_object(
      'critical', (select count(*) from ordered where priority = 'critical'),
      'overdue', (select count(*) from ordered where status = 'overdue'),
      'announcements', (select count(*) from ordered where action_type = 'announcement'),
      'training', (select count(*) from ordered where action_type = 'training'),
      'schedules', (select count(*) from ordered where action_type = 'schedule'),
      'hrTasks', (select count(*) from ordered where action_type = 'hr_task'),
      'documents', (select count(*) from ordered where action_type = 'document'),
      'signatures', (select count(*) from ordered where action_type = 'signature')
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.source_id,
        'position', item.position,
        'actionType', item.action_type,
        'title', item.title,
        'description', item.description,
        'status', item.status,
        'priority', item.priority,
        'responseKind', item.response_kind,
        'actionLabel', item.action_label,
        'route', item.route,
        'assignedAt', item.assigned_at,
        'dueAt', item.due_at,
        'viewedAt', item.viewed_at,
        'authoritativeVersion', item.authoritative_version,
        'metadata', item.metadata
      ) order by item.position)
      from ordered item
    ), '[]'::jsonb),
    'urgentAccess', jsonb_build_array(
      jsonb_build_object('id', 'time-clock', 'label', 'Clock in or out', 'route', '/'),
      jsonb_build_object('id', 'call-off', 'label', 'Report sick / call-off', 'route', '/time/my-time?report=call-off'),
      jsonb_build_object('id', 'emergency', 'label', 'Emergency information', 'route', null)
    )
  ) into result;

  return result;
end
$$;

create or replace function public.get_required_action_checkpoint_report(
  target_page integer default 1,
  target_page_size integer default 10,
  target_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := private.current_employee_id();
  page_number integer := greatest(coalesce(target_page, 1), 1);
  page_size integer := case when target_page_size in (5, 10, 20) then target_page_size else 10 end;
  clean_search text := nullif(btrim(coalesce(target_search, '')), '');
  result jsonb;
begin
  if actor_id is null or not public.has_mfa() or not (
    public.has_effective_permission('announcements.acknowledgments.manage')
    or public.has_effective_permission('training.manage')
    or public.has_effective_permission('schedule.acknowledgments.manage')
    or public.has_effective_permission('hr.automation.manage')
    or public.has_effective_permission('hr.documents.manage')
    or public.has_effective_permission('documents.signatures.manage')
  ) then
    raise insufficient_privilege using message = 'MFA-verified required-action reporting permission is required.';
  end if;

  with active_rows as (
    select
      employee.id as employee_id,
      btrim(concat_ws(' ', employee.first_name, employee.last_name)) as employee_name,
      employee.employee_number,
      case when account.employee_id is null or account.activated_at is null or account.disabled_at is not null then 'unreachable' else 'available' end as contact_state,
      item.*
    from public.employees employee
    left join private.employee_accounts account on account.employee_id = employee.id
    cross join lateral private.employee_required_action_checkpoint_rows(employee.id) item
    where employee.status = 'active'
  ),
  filtered as (
    select * from active_rows
    where clean_search is null
      or employee_name ilike '%' || clean_search || '%'
      or coalesce(employee_number, '') ilike '%' || clean_search || '%'
      or title ilike '%' || clean_search || '%'
      or action_type ilike '%' || clean_search || '%'
  ),
  paged as (
    select * from filtered
    order by priority_rank, due_at nulls last, employee_name, assigned_at
    limit page_size offset (page_number - 1) * page_size
  )
  select jsonb_build_object(
    'serverTimestamp', clock_timestamp(),
    'summary', jsonb_build_object(
      'pending', (select count(*) from filtered),
      'overdue', (select count(*) from filtered where status = 'overdue'),
      'critical', (select count(*) from filtered where priority = 'critical'),
      'unreachable', (select count(*) from filtered where contact_state = 'unreachable')
    ),
    'page', jsonb_build_object(
      'number', page_number,
      'size', page_size,
      'total', (select count(*) from filtered),
      'totalPages', case when (select count(*) from filtered) = 0 then 0 else ceil((select count(*) from filtered)::numeric / page_size)::integer end
    ),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', item.source_id,
      'employeeId', item.employee_id,
      'employeeName', item.employee_name,
      'employeeNumber', item.employee_number,
      'contactState', item.contact_state,
      'actionType', item.action_type,
      'title', item.title,
      'status', item.status,
      'priority', item.priority,
      'responseKind', item.response_kind,
      'assignedAt', item.assigned_at,
      'dueAt', item.due_at,
      'authoritativeVersion', item.authoritative_version
    ) order by item.priority_rank, item.due_at nulls last, item.employee_name, item.assigned_at) from paged item), '[]'::jsonb)
  ) into result;

  return result;
end
$$;

create or replace function public.service_has_required_action_checkpoint(target_actor_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  return private.employee_has_blocking_required_actions(target_actor_id);
end
$$;

revoke all on function private.employee_required_action_checkpoint_rows(uuid) from public, anon, authenticated;
revoke all on function private.employee_has_blocking_required_actions(uuid) from public, anon, authenticated;
revoke all on function private.employee_required_action_checkpoint_enrolled(uuid) from public, anon, authenticated;
revoke all on function public.get_required_action_checkpoint() from public, anon;
revoke all on function public.get_required_action_checkpoint_report(integer, integer, text) from public, anon;
revoke all on function public.service_has_required_action_checkpoint(uuid) from public, anon, authenticated;
grant execute on function private.employee_required_action_checkpoint_rows(uuid) to service_role;
grant execute on function private.employee_has_blocking_required_actions(uuid) to service_role;
grant execute on function private.employee_required_action_checkpoint_enrolled(uuid) to service_role;
grant execute on function public.get_required_action_checkpoint() to authenticated;
grant execute on function public.get_required_action_checkpoint_report(integer, integer, text) to authenticated;
grant execute on function public.service_has_required_action_checkpoint(uuid) to service_role;

comment on function public.get_required_action_checkpoint() is
  'Returns one ordered, version-aware post-login queue derived from authoritative action records. It never replaces legal signature evidence or source-specific history.';
comment on function private.employee_has_blocking_required_actions(uuid) is
  'Server-side checkpoint predicate used by effective-permission evaluation so direct permission-checked calls cannot bypass outstanding required actions.';
comment on table private.required_action_checkpoint_enrollments is
  'Controlled rollout membership only. Required actions remain authoritative in their original versioned source records.';

do $$
declare baseline required_action_checkpoint_preservation_baseline%rowtype;
begin
  select * into strict baseline from required_action_checkpoint_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.announcement_count <> (select count(*) from public.announcement_acknowledgments)
    or baseline.training_count <> (select count(*) from public.training_assignments)
    or baseline.schedule_count <> (select count(*) from public.schedule_acknowledgments)
    or baseline.hr_task_count <> (select count(*) from private.hr_workflow_tasks)
    or baseline.document_assignment_count <> (select count(*) from private.hr_document_assignments)
    or baseline.signature_recipient_count <> (select count(*) from private.signature_recipients)
    or baseline.role_assignment_count <> (select count(*) from public.employee_access_roles)
    or baseline.permission_override_count <> (select count(*) from public.employee_permission_overrides) then
    raise exception 'Required-action checkpoint migration changed protected business or access records.';
  end if;
end
$$;

commit;
