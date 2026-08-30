begin;

-- Stage 4, run 4 completes the dormant document workflow without releasing it.
-- Existing employees, accounts, roles, permissions, and documents are preserved.
create temporary table hris_stage4_run4_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) as employee_count,
  (select count(*) from public.employee_access_roles) as employee_role_count,
  (select count(*) from public.access_role_permissions) as role_permission_count,
  (select count(*) from public.employee_permission_overrides) as override_count,
  (select count(*) from private.employee_accounts) as account_count,
  (select count(*) from private.hr_documents) as document_count,
  (select count(*) from private.hr_document_versions) as version_count;

create table private.hr_document_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  requested_by uuid not null references public.employees(id) on delete restrict,
  vault_code text not null references private.hr_document_vaults(code) on delete restrict,
  title text not null,
  category text not null,
  instructions text not null,
  due_date date,
  status text not null default 'requested',
  linked_document_id uuid references private.hr_documents(id) on delete restrict,
  reviewed_by uuid references public.employees(id) on delete restrict,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_request_title_present check (btrim(title) <> '' and char_length(title) <= 180),
  constraint hr_document_request_category_present check (btrim(category) <> '' and char_length(category) <= 100),
  constraint hr_document_request_instructions_present check (btrim(instructions) <> '' and char_length(instructions) <= 2000),
  constraint hr_document_request_status check (status in ('requested','submitted','accepted','rejected','cancelled')),
  constraint hr_document_request_submission_consistent check (
    (status = 'submitted' and linked_document_id is not null)
    or status <> 'submitted'
  ),
  constraint hr_document_request_review_consistent check (
    (status in ('accepted','rejected') and reviewed_by is not null and reviewed_at is not null and btrim(coalesce(review_note, '')) <> '')
    or status not in ('accepted','rejected')
  )
);

create index hr_document_requests_employee_status_index
  on private.hr_document_requests(employee_id, status, due_date, created_at desc);

create table private.hr_document_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references private.hr_document_requests(id) on delete restrict,
  action text not null,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint hr_document_request_event_action check (action in ('requested','submitted','accepted','rejected','cancelled')),
  constraint hr_document_request_event_reason check (btrim(reason) <> '')
);

create index hr_document_request_events_request_index
  on private.hr_document_request_events(request_id, occurred_at desc);

create table private.hr_document_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete restrict,
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  requirement_type text not null,
  statement_snapshot text not null,
  due_date date,
  status text not null default 'pending',
  assigned_by uuid not null references public.employees(id) on delete restrict,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.employees(id) on delete restrict,
  cancellation_reason text,
  completion_evidence_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_document_assignment_requirement check (requirement_type in ('acknowledgment','electronic_signature')),
  constraint hr_document_assignment_statement_present check (btrim(statement_snapshot) <> '' and char_length(statement_snapshot) <= 2000),
  constraint hr_document_assignment_status check (status in ('pending','completed','cancelled','declined')),
  constraint hr_document_assignment_completion_consistent check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint hr_document_assignment_cancellation_consistent check (
    (status = 'cancelled' and cancelled_at is not null and cancelled_by is not null and btrim(coalesce(cancellation_reason, '')) <> '')
    or (status <> 'cancelled' and cancelled_at is null and cancelled_by is null and cancellation_reason is null)
  ),
  unique (employee_id, document_id, version_id, requirement_type)
);

create index hr_document_assignments_employee_status_index
  on private.hr_document_assignments(employee_id, status, due_date, created_at desc);

create table private.hr_document_completion_evidence (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null unique references private.hr_document_assignments(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete restrict,
  document_id uuid not null references private.hr_documents(id) on delete restrict,
  version_id uuid not null references private.hr_document_versions(id) on delete restrict,
  completion_action text not null,
  legal_name_snapshot text not null,
  statement_snapshot text not null,
  version_checksum_snapshot text not null,
  authentication_method text not null,
  authentication_verified_at timestamptz not null,
  request_id text,
  completed_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint hr_document_evidence_action check (completion_action in ('acknowledge','sign')),
  constraint hr_document_evidence_legal_name check (btrim(legal_name_snapshot) <> ''),
  constraint hr_document_evidence_statement check (btrim(statement_snapshot) <> ''),
  constraint hr_document_evidence_checksum check (version_checksum_snapshot ~ '^[a-f0-9]{64}$'),
  constraint hr_document_evidence_authentication check (authentication_method in ('authenticator','security_key'))
);

alter table private.hr_document_assignments
  add constraint hr_document_assignments_completion_evidence_fk
  foreign key (completion_evidence_id) references private.hr_document_completion_evidence(id) on delete restrict;

create table private.hr_document_assignment_events (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references private.hr_document_assignments(id) on delete restrict,
  action text not null,
  actor_employee_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint hr_document_assignment_event_action check (action in ('assigned','acknowledged','signed','declined','cancelled')),
  constraint hr_document_assignment_event_reason check (btrim(reason) <> '')
);

create index hr_document_assignment_events_assignment_index
  on private.hr_document_assignment_events(assignment_id, occurred_at desc);

create trigger hr_document_request_events_append_only
before update or delete on private.hr_document_request_events
for each row execute function private.hr_document_prevent_append_only_change();

create trigger hr_document_assignment_events_append_only
before update or delete on private.hr_document_assignment_events
for each row execute function private.hr_document_prevent_append_only_change();

create trigger hr_document_completion_evidence_append_only
before update or delete on private.hr_document_completion_evidence
for each row execute function private.hr_document_prevent_append_only_change();

alter table private.hr_document_access_grants
  add column authorization_source text not null default 'permission',
  add column assignment_id uuid references private.hr_document_assignments(id) on delete restrict,
  add constraint hr_document_access_grant_authorization_source check (authorization_source in ('permission','assignment')),
  add constraint hr_document_access_grant_assignment_consistent check (
    (authorization_source = 'permission' and assignment_id is null)
    or (authorization_source = 'assignment' and assignment_id is not null)
  );

create or replace function private.hr_document_access_grant_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'Document access grants cannot be deleted.';
  end if;
  if old.consumed_at is not null or new.consumed_at is null
    or row(new.token_hash, new.actor_employee_id, new.document_id, new.version_id, new.action,
           new.mfa_method, new.mfa_verified_at, new.reason, new.request_id, new.created_at, new.expires_at,
           new.authorization_source, new.assignment_id)
       is distinct from
       row(old.token_hash, old.actor_employee_id, old.document_id, old.version_id, old.action,
           old.mfa_method, old.mfa_verified_at, old.reason, old.request_id, old.created_at, old.expires_at,
           old.authorization_source, old.assignment_id) then
    raise check_violation using message = 'Document access grants are immutable except for first use.';
  end if;
  return new;
end
$$;

create function private.service_require_active_hr_document_employee(target_employee_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.role()) <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required.';
  end if;
  if not exists (
    select 1
    from public.employees employee
    join private.employee_accounts account on account.employee_id = employee.id
    where employee.id = target_employee_id
      and employee.status in ('active','leave')
      and account.disabled_at is null
  ) then
    raise insufficient_privilege using message = 'An active employee account is required.';
  end if;
end
$$;

create function public.service_get_hr_document_workflow_workspace(
  target_actor_id uuid,
  target_status text default null,
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
  safe_page integer := greatest(coalesce(target_page, 1), 1);
  safe_page_size integer := case when target_page_size in (5,10,20) then target_page_size else 10 end;
  request_total integer;
  assignment_total integer;
  request_rows jsonb;
  assignment_rows jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  perform private.service_require_hr_document_permission(target_actor_id, 'hr-general', 'manage');
  if target_status is not null and target_status not in ('requested','submitted','accepted','rejected','cancelled','pending','completed','declined') then
    raise check_violation using message = 'The workflow status filter is invalid.';
  end if;

  select count(*) into request_total
  from private.hr_document_requests request
  where target_status is null or request.status = target_status;
  select count(*) into assignment_total
  from private.hr_document_assignments assignment
  where target_status is null or assignment.status = target_status;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id, 'employeeId', item.employee_id, 'employeeLegalName', item.employee_legal_name,
    'vaultCode', item.vault_code, 'title', item.title, 'category', item.category,
    'instructions', item.instructions, 'dueDate', item.due_date, 'status', item.status,
    'linkedDocumentId', item.linked_document_id, 'createdAt', item.created_at,
    'reviewedAt', item.reviewed_at, 'reviewNote', item.review_note
  ) order by item.created_at desc), '[]'::jsonb) into request_rows
  from (
    select request.*, concat_ws(' ', employee.first_name, nullif(btrim(employee.middle_name), ''), employee.last_name) employee_legal_name
    from private.hr_document_requests request
    join public.employees employee on employee.id = request.employee_id
    where target_status is null or request.status = target_status
    order by request.created_at desc
    limit safe_page_size offset (safe_page - 1) * safe_page_size
  ) item;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', item.id, 'employeeId', item.employee_id, 'employeeLegalName', item.employee_legal_name,
    'documentId', item.document_id, 'versionId', item.version_id, 'documentTitle', item.document_title,
    'requirementType', item.requirement_type, 'statement', item.statement_snapshot,
    'dueDate', item.due_date, 'status', item.status, 'createdAt', item.created_at,
    'completedAt', item.completed_at
  ) order by item.created_at desc), '[]'::jsonb) into assignment_rows
  from (
    select assignment.*, document.title document_title,
      concat_ws(' ', employee.first_name, nullif(btrim(employee.middle_name), ''), employee.last_name) employee_legal_name
    from private.hr_document_assignments assignment
    join private.hr_documents document on document.id = assignment.document_id
    join public.employees employee on employee.id = assignment.employee_id
    where target_status is null or assignment.status = target_status
    order by assignment.created_at desc
    limit safe_page_size offset (safe_page - 1) * safe_page_size
  ) item;

  return jsonb_build_object(
    'releaseState', 'released', 'requests', request_rows, 'assignments', assignment_rows,
    'pagination', jsonb_build_object('page', safe_page, 'pageSize', safe_page_size,
      'requestTotal', request_total, 'assignmentTotal', assignment_total)
  );
end
$$;

create function public.service_get_my_hr_document_workspace(target_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare assignment_rows jsonb; request_rows jsonb;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then
    raise insufficient_privilege using message = 'The HR document workspace has not been released.';
  end if;
  perform private.service_require_active_hr_document_employee(target_actor_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', assignment.id, 'documentId', assignment.document_id, 'versionId', assignment.version_id,
    'documentTitle', document.title, 'category', document.category, 'requirementType', assignment.requirement_type,
    'statement', assignment.statement_snapshot, 'dueDate', assignment.due_date, 'status', assignment.status,
    'createdAt', assignment.created_at, 'completedAt', assignment.completed_at,
    'scanState', private.hr_document_latest_scan_state(assignment.version_id)
  ) order by (assignment.status = 'pending') desc, assignment.due_date nulls last, assignment.created_at desc), '[]'::jsonb)
  into assignment_rows
  from private.hr_document_assignments assignment
  join private.hr_documents document on document.id = assignment.document_id
  where assignment.employee_id = target_actor_id
    and assignment.status in ('pending','completed','declined')
    and document.archived_at is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', request.id, 'title', request.title, 'category', request.category,
    'instructions', request.instructions, 'dueDate', request.due_date, 'status', request.status,
    'createdAt', request.created_at, 'reviewedAt', request.reviewed_at, 'reviewNote', request.review_note
  ) order by request.created_at desc), '[]'::jsonb)
  into request_rows
  from private.hr_document_requests request
  where request.employee_id = target_actor_id and request.status <> 'cancelled';

  return jsonb_build_object('releaseState', 'released', 'assignments', assignment_rows, 'requests', request_rows);
end
$$;

create function public.service_create_hr_document_request(
  target_actor_id uuid,
  target_employee_id uuid,
  target_vault_code text,
  target_title text,
  target_category text,
  target_instructions text,
  target_due_date date,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare request_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  perform private.service_require_hr_document_permission(target_actor_id, target_vault_code, 'manage');
  perform private.service_require_active_hr_document_employee(target_employee_id);
  if btrim(coalesce(target_title, '')) = '' or btrim(coalesce(target_category, '')) = '' or btrim(coalesce(target_instructions, '')) = '' then
    raise check_violation using message = 'Title, category, and employee instructions are required.';
  end if;
  insert into private.hr_document_requests(employee_id, requested_by, vault_code, title, category, instructions, due_date)
  values (target_employee_id, target_actor_id, target_vault_code, btrim(target_title), btrim(target_category), btrim(target_instructions), target_due_date)
  returning id into request_id;
  insert into private.hr_document_request_events(request_id, action, actor_employee_id, reason, metadata)
  values (request_id, 'requested', target_actor_id, 'Document requested from employee.', jsonb_build_object('requestId', target_request_id));
  return jsonb_build_object('id', request_id, 'status', 'requested');
end
$$;

create function public.service_review_hr_document_request(
  target_actor_id uuid,
  target_request_id uuid,
  target_action text,
  target_note text,
  target_correlation_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare request_record private.hr_document_requests%rowtype; next_status text;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  select * into request_record from private.hr_document_requests where id = target_request_id for update;
  if request_record.id is null then raise no_data_found using message = 'The document request was not found.'; end if;
  perform private.service_require_hr_document_permission(target_actor_id, request_record.vault_code, 'manage');
  if target_action not in ('accepted','rejected','cancelled') then raise check_violation using message = 'Choose accept, reject, or cancel.'; end if;
  if btrim(coalesce(target_note, '')) = '' then raise check_violation using message = 'An audit note is required.'; end if;
  if request_record.status in ('accepted','rejected','cancelled') then raise check_violation using message = 'This document request is already closed.'; end if;
  next_status := target_action;
  update private.hr_document_requests set status = next_status,
    reviewed_by = case when next_status in ('accepted','rejected') then target_actor_id else reviewed_by end,
    reviewed_at = case when next_status in ('accepted','rejected') then clock_timestamp() else reviewed_at end,
    review_note = case when next_status in ('accepted','rejected') then btrim(target_note) else review_note end,
    updated_at = clock_timestamp() where id = request_record.id;
  insert into private.hr_document_request_events(request_id, action, actor_employee_id, reason, metadata)
  values (request_record.id, next_status, target_actor_id, btrim(target_note), jsonb_build_object('requestId', target_correlation_id));
  return jsonb_build_object('id', request_record.id, 'status', next_status);
end
$$;

create function public.service_create_hr_document_assignment(
  target_actor_id uuid,
  target_employee_id uuid,
  target_document_id uuid,
  target_requirement_type text,
  target_statement text,
  target_due_date date,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare document_record private.hr_documents%rowtype; assignment_id uuid;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  select * into document_record from private.hr_documents where id = target_document_id and archived_at is null;
  if document_record.id is null or document_record.current_version_id is null then raise no_data_found using message = 'The document is unavailable.'; end if;
  perform private.service_require_hr_document_permission(target_actor_id, document_record.vault_code, 'manage');
  perform private.service_require_active_hr_document_employee(target_employee_id);
  if target_requirement_type not in ('acknowledgment','electronic_signature') then raise check_violation using message = 'Choose acknowledgment or electronic signature.'; end if;
  if btrim(coalesce(target_statement, '')) = '' then raise check_violation using message = 'A completion statement is required.'; end if;
  if private.hr_document_latest_scan_state(document_record.current_version_id) <> 'clean' then raise insufficient_privilege using message = 'Only a clean document version can be assigned.'; end if;
  insert into private.hr_document_assignments(employee_id, document_id, version_id, requirement_type, statement_snapshot, due_date, assigned_by)
  values (target_employee_id, document_record.id, document_record.current_version_id, target_requirement_type, btrim(target_statement), target_due_date, target_actor_id)
  returning id into assignment_id;
  insert into private.hr_document_assignment_events(assignment_id, action, actor_employee_id, reason, metadata)
  values (assignment_id, 'assigned', target_actor_id, 'Document assigned for employee completion.', jsonb_build_object('requestId', target_request_id));
  return jsonb_build_object('id', assignment_id, 'status', 'pending');
exception when unique_violation then
  raise check_violation using message = 'This exact document version is already assigned to the employee.';
end
$$;

create function public.service_cancel_hr_document_assignment(
  target_actor_id uuid,
  target_assignment_id uuid,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare assignment_record private.hr_document_assignments%rowtype; document_vault text;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  select * into assignment_record from private.hr_document_assignments where id = target_assignment_id for update;
  if assignment_record.id is null then raise no_data_found using message = 'The document assignment was not found.'; end if;
  select vault_code into document_vault from private.hr_documents where id = assignment_record.document_id;
  perform private.service_require_hr_document_permission(target_actor_id, document_vault, 'manage');
  if assignment_record.status <> 'pending' then raise check_violation using message = 'Only a pending assignment can be cancelled.'; end if;
  if btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'A cancellation reason is required.'; end if;
  update private.hr_document_assignments set status = 'cancelled', cancelled_at = clock_timestamp(),
    cancelled_by = target_actor_id, cancellation_reason = btrim(target_reason), updated_at = clock_timestamp()
  where id = assignment_record.id;
  insert into private.hr_document_assignment_events(assignment_id, action, actor_employee_id, reason, metadata)
  values (assignment_record.id, 'cancelled', target_actor_id, btrim(target_reason), jsonb_build_object('requestId', target_request_id));
  return jsonb_build_object('id', assignment_record.id, 'status', 'cancelled');
end
$$;

create function public.service_issue_my_hr_document_access_grant(
  target_actor_id uuid,
  target_assignment_id uuid,
  target_action text,
  target_token_hash text,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_reason text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare assignment_record private.hr_document_assignments%rowtype; grant_id uuid; grant_expires_at timestamptz := clock_timestamp() + interval '60 seconds';
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  perform private.service_require_active_hr_document_employee(target_actor_id);
  select * into assignment_record from private.hr_document_assignments
  where id = target_assignment_id and employee_id = target_actor_id and status in ('pending','completed');
  if assignment_record.id is null then raise insufficient_privilege using message = 'The assigned document is unavailable.'; end if;
  if target_action not in ('preview','view','download') then raise check_violation using message = 'Unsupported document action.'; end if;
  if target_mfa_method not in ('authenticator','security_key') or target_mfa_verified_at < clock_timestamp() - interval '15 minutes' or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then raise insufficient_privilege using message = 'A recent MFA verification is required.'; end if;
  if target_token_hash !~ '^[a-f0-9]{64}$' or btrim(coalesce(target_reason, '')) = '' then raise check_violation using message = 'The protected access request is incomplete.'; end if;
  if private.hr_document_latest_scan_state(assignment_record.version_id) <> 'clean' then raise insufficient_privilege using message = 'The document is unavailable.'; end if;
  insert into private.hr_document_access_grants(token_hash, actor_employee_id, document_id, version_id, action, mfa_method,
    mfa_verified_at, reason, request_id, expires_at, authorization_source, assignment_id)
  values (target_token_hash, target_actor_id, assignment_record.document_id, assignment_record.version_id, target_action,
    target_mfa_method, target_mfa_verified_at, target_reason, nullif(btrim(target_request_id), ''), grant_expires_at,
    'assignment', assignment_record.id)
  returning id into grant_id;
  return jsonb_build_object('grantId', grant_id, 'expiresAt', grant_expires_at);
end
$$;

create or replace function public.service_consume_hr_document_access_grant(
  target_actor_id uuid,
  target_token_hash text,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare grant_record private.hr_document_access_grants%rowtype; version_record private.hr_document_versions%rowtype; document_record private.hr_documents%rowtype;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  update private.hr_document_access_grants access_grant set consumed_at = clock_timestamp()
  where access_grant.actor_employee_id = target_actor_id and access_grant.token_hash = target_token_hash
    and access_grant.consumed_at is null and access_grant.expires_at > clock_timestamp()
  returning * into grant_record;
  if grant_record.id is null then raise insufficient_privilege using message = 'The document access link is invalid or expired.'; end if;
  select * into document_record from private.hr_documents where id = grant_record.document_id and archived_at is null and current_version_id = grant_record.version_id;
  if document_record.id is null then raise insufficient_privilege using message = 'The document access link is no longer current.'; end if;
  if grant_record.authorization_source = 'permission' then
    perform private.service_require_hr_document_permission(grant_record.actor_employee_id, document_record.vault_code, 'view');
  elsif not exists (
    select 1 from private.hr_document_assignments assignment
    where assignment.id = grant_record.assignment_id and assignment.employee_id = grant_record.actor_employee_id
      and assignment.document_id = grant_record.document_id and assignment.version_id = grant_record.version_id
      and assignment.status in ('pending','completed')
  ) then
    raise insufficient_privilege using message = 'The assigned document is no longer available.';
  end if;
  select * into version_record from private.hr_document_versions where id = grant_record.version_id;
  if private.hr_document_latest_scan_state(grant_record.version_id) <> 'clean' then raise insufficient_privilege using message = 'The document is no longer available.'; end if;
  insert into private.hr_document_access_events(document_id, version_id, action, actor_employee_id, request_id, reason, metadata)
  values (grant_record.document_id, grant_record.version_id, grant_record.action, grant_record.actor_employee_id,
    coalesce(nullif(btrim(target_request_id), ''), grant_record.request_id), grant_record.reason,
    jsonb_build_object('grantId', grant_record.id, 'mfaMethod', grant_record.mfa_method,
      'authorizationSource', grant_record.authorization_source, 'assignmentId', grant_record.assignment_id));
  return jsonb_build_object('documentId', grant_record.document_id, 'versionId', grant_record.version_id,
    'action', grant_record.action, 'bucket', version_record.storage_bucket, 'objectKey', version_record.object_key,
    'filename', version_record.sanitized_filename, 'mimeType', version_record.detected_mime_type);
end
$$;

create function public.service_complete_hr_document_assignment(
  target_actor_id uuid,
  target_assignment_id uuid,
  target_action text,
  target_legal_name text,
  target_confirmed boolean,
  target_mfa_method text,
  target_mfa_verified_at timestamptz,
  target_request_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare assignment_record private.hr_document_assignments%rowtype; version_record private.hr_document_versions%rowtype;
  legal_name text; evidence_id uuid; expected_action text;
begin
  if (select auth.role()) <> 'service_role' then raise insufficient_privilege using message = 'Service role required.'; end if;
  if not exists (select 1 from private.hr_document_release_gate gate where gate.singleton and gate.enabled) then raise insufficient_privilege using message = 'The HR document workspace has not been released.'; end if;
  perform private.service_require_active_hr_document_employee(target_actor_id);
  select * into assignment_record from private.hr_document_assignments where id = target_assignment_id and employee_id = target_actor_id for update;
  if assignment_record.id is null or assignment_record.status <> 'pending' then raise check_violation using message = 'This document assignment is not pending.'; end if;
  expected_action := case assignment_record.requirement_type when 'acknowledgment' then 'acknowledge' else 'sign' end;
  if target_action <> expected_action or not coalesce(target_confirmed, false) then raise check_violation using message = 'Confirm the exact required document action.'; end if;
  select concat_ws(' ', employee.first_name, nullif(btrim(employee.middle_name), ''), employee.last_name)
    into legal_name from public.employees employee where employee.id = target_actor_id;
  if lower(regexp_replace(btrim(coalesce(target_legal_name, '')), '\s+', ' ', 'g')) <> lower(regexp_replace(btrim(legal_name), '\s+', ' ', 'g')) then
    raise check_violation using message = 'Enter your complete legal name exactly as shown in My Account.';
  end if;
  if target_mfa_method not in ('authenticator','security_key') or target_mfa_verified_at < clock_timestamp() - interval '15 minutes' or target_mfa_verified_at > clock_timestamp() + interval '1 minute' then
    raise insufficient_privilege using message = 'A recent MFA verification is required.';
  end if;
  select * into version_record from private.hr_document_versions where id = assignment_record.version_id;
  if version_record.id is null or private.hr_document_latest_scan_state(version_record.id) <> 'clean' then raise insufficient_privilege using message = 'The assigned document version is unavailable.'; end if;
  if not exists (select 1 from private.hr_documents document where document.id = assignment_record.document_id and document.archived_at is null and document.current_version_id = assignment_record.version_id) then
    raise check_violation using message = 'The document has changed. Ask HR to issue a new assignment.';
  end if;
  insert into private.hr_document_completion_evidence(assignment_id, employee_id, document_id, version_id, completion_action,
    legal_name_snapshot, statement_snapshot, version_checksum_snapshot, authentication_method, authentication_verified_at,
    request_id, metadata)
  values (assignment_record.id, target_actor_id, assignment_record.document_id, assignment_record.version_id, expected_action,
    legal_name, assignment_record.statement_snapshot, version_record.sha256_checksum, target_mfa_method,
    target_mfa_verified_at, nullif(btrim(target_request_id), ''), jsonb_build_object('explicitConfirmation', true))
  returning id into evidence_id;
  update private.hr_document_assignments set status = 'completed', completed_at = clock_timestamp(),
    completion_evidence_id = evidence_id, updated_at = clock_timestamp() where id = assignment_record.id;
  insert into private.hr_document_assignment_events(assignment_id, action, actor_employee_id, reason, metadata)
  values (assignment_record.id, case when expected_action = 'sign' then 'signed' else 'acknowledged' end,
    target_actor_id, 'Employee completed the assigned document action.', jsonb_build_object('evidenceId', evidence_id, 'requestId', target_request_id));
  insert into private.hr_document_access_events(document_id, version_id, action, actor_employee_id, request_id, reason, metadata)
  values (assignment_record.document_id, assignment_record.version_id, expected_action, target_actor_id,
    nullif(btrim(target_request_id), ''), 'Employee completed an assigned document action.',
    jsonb_build_object('assignmentId', assignment_record.id, 'evidenceId', evidence_id, 'mfaMethod', target_mfa_method));
  return jsonb_build_object('id', assignment_record.id, 'status', 'completed', 'evidenceId', evidence_id, 'completedAt', clock_timestamp());
end
$$;

revoke all on private.hr_document_requests, private.hr_document_request_events,
  private.hr_document_assignments, private.hr_document_completion_evidence,
  private.hr_document_assignment_events from public, anon, authenticated;
grant select, insert, update on private.hr_document_requests, private.hr_document_assignments to service_role;
grant select, insert on private.hr_document_request_events, private.hr_document_completion_evidence,
  private.hr_document_assignment_events to service_role;

revoke all on function private.service_require_active_hr_document_employee(uuid) from public, anon, authenticated;
revoke all on function public.service_get_hr_document_workflow_workspace(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.service_get_my_hr_document_workspace(uuid) from public, anon, authenticated;
revoke all on function public.service_create_hr_document_request(uuid, uuid, text, text, text, text, date, text) from public, anon, authenticated;
revoke all on function public.service_review_hr_document_request(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.service_create_hr_document_assignment(uuid, uuid, uuid, text, text, date, text) from public, anon, authenticated;
revoke all on function public.service_cancel_hr_document_assignment(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.service_issue_my_hr_document_access_grant(uuid, uuid, text, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.service_complete_hr_document_assignment(uuid, uuid, text, text, boolean, text, timestamptz, text) from public, anon, authenticated;

grant execute on function public.service_get_hr_document_workflow_workspace(uuid, text, integer, integer) to service_role;
grant execute on function public.service_get_my_hr_document_workspace(uuid) to service_role;
grant execute on function public.service_create_hr_document_request(uuid, uuid, text, text, text, text, date, text) to service_role;
grant execute on function public.service_review_hr_document_request(uuid, uuid, text, text, text) to service_role;
grant execute on function public.service_create_hr_document_assignment(uuid, uuid, uuid, text, text, date, text) to service_role;
grant execute on function public.service_cancel_hr_document_assignment(uuid, uuid, text, text) to service_role;
grant execute on function public.service_issue_my_hr_document_access_grant(uuid, uuid, text, text, text, timestamptz, text, text) to service_role;
grant execute on function public.service_complete_hr_document_assignment(uuid, uuid, text, text, boolean, text, timestamptz, text) to service_role;

-- Production access remains closed until a separate, evidence-backed release.
update private.hr_document_release_gate
set enabled = false, enabled_at = null, enabled_by = null, evidence_reference = null, updated_at = clock_timestamp()
where singleton;

do $$
declare baseline hris_stage4_run4_preservation_baseline%rowtype;
begin
  select * into baseline from hris_stage4_run4_preservation_baseline;
  if baseline.employee_count <> (select count(*) from public.employees)
    or baseline.employee_role_count <> (select count(*) from public.employee_access_roles)
    or baseline.role_permission_count <> (select count(*) from public.access_role_permissions)
    or baseline.override_count <> (select count(*) from public.employee_permission_overrides)
    or baseline.account_count <> (select count(*) from private.employee_accounts)
    or baseline.document_count <> (select count(*) from private.hr_documents)
    or baseline.version_count <> (select count(*) from private.hr_document_versions) then
    raise exception 'Stage 4 run 4 preservation assertion failed.';
  end if;
  if exists (select 1 from private.hr_document_release_gate where singleton and enabled) then
    raise exception 'Stage 4 run 4 must leave the document release gate disabled.';
  end if;
end
$$;

commit;
