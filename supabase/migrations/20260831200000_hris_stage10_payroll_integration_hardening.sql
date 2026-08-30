begin;

-- Stage 10 establishes a dormant, versioned HR-to-Payroll control plane.
-- Payroll remains authoritative. No employee access, operating record, time event,
-- schedule, or locked payroll snapshot is changed by this migration.
create temporary table hris_stage10_preservation_baseline on commit drop as
select
  (select count(*) from public.employees) employee_count,
  (select count(*) from public.employee_access_roles) employee_role_count,
  (select count(*) from public.access_role_permissions) role_permission_count,
  (select count(*) from public.employee_permission_overrides) override_count,
  (select count(*) from private.employee_accounts) account_count,
  (select count(*) from public.schedules) schedule_count,
  (select count(*) from public.time_events) time_event_count,
  (select count(*) from private.payroll_export_batches) payroll_batch_count,
  (select count(*) from private.payroll_export_rows) payroll_row_count;

insert into public.permission_catalog(code,category,name,description,risk_level,requires_mfa,locked,active)
values
  ('hr.payroll_integration.view','HR & Finance','View payroll integration controls','View the approved integration contract, reconciliation state, and controlled release evidence.','critical',true,true,true),
  ('hr.payroll_integration.manage','HR & Finance','Manage payroll change proposals','Create governed HR-to-Payroll proposals without changing authoritative payroll records.','critical',true,true,true),
  ('hr.payroll_integration.approve','HR & Finance','Approve payroll change proposals','Independently approve or reject payroll-impacting proposals with a required reason.','critical',true,true,true),
  ('hr.payroll_integration.reconcile','HR & Finance','Run payroll reconciliation','Compare locked payroll snapshots and preserve reconciliation evidence.','critical',true,true,true),
  ('hr.payroll_integration.cutover','HR & Finance','Control payroll integration cutover','Authorize a controlled integration cutover or rollback after reconciliation.','critical',true,true,true),
  ('hr.payroll_integration.webhooks','HR & Finance','Manage payroll integration webhooks','Manage disabled-by-default webhook destinations and delivery evidence.','critical',true,true,true)
on conflict(code) do update set category=excluded.category,name=excluded.name,description=excluded.description,
  risk_level=excluded.risk_level,requires_mfa=excluded.requires_mfa,locked=excluded.locked,active=excluded.active;

create table private.hr_stage10_release_gates (
  gate text primary key,
  enabled boolean not null default false,
  enabled_by uuid references public.employees(id) on delete restrict,
  enabled_at timestamptz,
  reason text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_stage10_gate_name check(gate in ('integration','webhooks','cutover')),
  constraint hr_stage10_gate_consistent check(
    (not enabled and enabled_by is null and enabled_at is null)
    or (enabled and enabled_by is not null and enabled_at is not null and btrim(coalesce(reason,''))<>'')
  )
);
insert into private.hr_stage10_release_gates(gate) values ('integration'),('webhooks'),('cutover');

create table private.hr_payroll_integration_contracts (
  id uuid primary key default gen_random_uuid(),
  contract_version text not null unique,
  schema_version integer not null default 1,
  status text not null default 'draft',
  payroll_authority text not null default 'sygshift_payroll',
  effective_from date,
  contract_payload jsonb not null,
  payload_digest text not null,
  proposed_by uuid references public.employees(id) on delete restrict,
  proposed_at timestamptz not null default clock_timestamp(),
  approved_by uuid references public.employees(id) on delete restrict,
  approved_at timestamptz,
  approval_reason text,
  supersedes_contract_id uuid references private.hr_payroll_integration_contracts(id) on delete restrict,
  constraint hr_payroll_contract_version check(contract_version ~ '^v[0-9]+\.[0-9]+\.[0-9]+$'),
  constraint hr_payroll_contract_schema check(schema_version>0),
  constraint hr_payroll_contract_status check(status in ('draft','pending_approval','approved','superseded','rejected')),
  constraint hr_payroll_contract_authority check(payroll_authority='sygshift_payroll'),
  constraint hr_payroll_contract_payload check(jsonb_typeof(contract_payload)='object'),
  constraint hr_payroll_contract_digest check(payload_digest ~ '^[a-f0-9]{64}$'),
  constraint hr_payroll_contract_approval check(
    (status in ('approved','superseded') and approved_by is not null and approved_at is not null and btrim(coalesce(approval_reason,''))<>'')
    or status in ('draft','pending_approval','rejected')
  ),
  constraint hr_payroll_contract_maker_checker check(approved_by is null or proposed_by is null or approved_by<>proposed_by)
);

create or replace function private.set_hr_payroll_contract_digest() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.payload_digest := encode(extensions.digest(convert_to(new.contract_payload::text,'UTF8'),'sha256'),'hex');
  return new;
end $$;
create trigger hr_payroll_contract_digest before insert or update of contract_payload
on private.hr_payroll_integration_contracts for each row
execute function private.set_hr_payroll_contract_digest();

insert into private.hr_payroll_integration_contracts(contract_version,status,contract_payload)
values ('v1.0.0','draft',jsonb_build_object(
  'authority',jsonb_build_object('payroll','sygshift_payroll','hr','approved_inputs_only'),
  'stableIdentifiers',jsonb_build_array('employee_id','payroll_export_batch_id','proposal_id','event_id'),
  'payrollRules',jsonb_build_object(
    'hourlySource','completed_and_approved_punches',
    'weekStartsOn','Sunday',
    'timeZone','America/Denver',
    'overnightAttribution','scheduled_shift_start_workday',
    'lockedSnapshotsImmutable',true
  ),
  'approval',jsonb_build_object('makerCheckerRequired',true,'reasonRequired',true,'recentMfaRequired',true),
  'eventEnvelope',jsonb_build_object('schemaVersion',1,'eventType','sygshift.hr.payroll_change.approved.v1','idempotencyRequired',true,'payloadDigest','sha256'),
  'cutover',jsonb_build_object('parallelReconciliationRequired',true,'rollbackRequired',true,'manualApprovalRequired',true)
));

create table private.hr_payroll_change_proposals (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references private.hr_payroll_integration_contracts(id) on delete restrict,
  idempotency_key text not null unique,
  employee_id uuid references public.employees(id) on delete restrict,
  change_type text not null,
  effective_on date not null,
  status text not null default 'draft',
  proposed_payload jsonb not null,
  payload_digest text not null,
  proposed_by uuid not null references public.employees(id) on delete restrict,
  proposal_reason text not null,
  proposed_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_payroll_proposal_key check(btrim(idempotency_key)<>'' and char_length(idempotency_key)<=200),
  constraint hr_payroll_proposal_type check(change_type in ('employment_status','compensation','paid_leave','work_classification','payroll_identity','other')),
  constraint hr_payroll_proposal_status check(status in ('draft','pending_approval','approved','rejected','held','applied','canceled','rolled_back')),
  constraint hr_payroll_proposal_payload check(jsonb_typeof(proposed_payload)='object'),
  constraint hr_payroll_proposal_digest check(payload_digest ~ '^[a-f0-9]{64}$'),
  constraint hr_payroll_proposal_reason check(btrim(proposal_reason)<>'' and char_length(proposal_reason)<=4000)
);

create or replace function private.set_hr_payroll_proposal_digest() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.payload_digest := encode(extensions.digest(convert_to(new.proposed_payload::text,'UTF8'),'sha256'),'hex');
  return new;
end $$;
create trigger hr_payroll_proposal_digest before insert or update of proposed_payload
on private.hr_payroll_change_proposals for each row
execute function private.set_hr_payroll_proposal_digest();

create table private.hr_payroll_change_approvals (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references private.hr_payroll_change_proposals(id) on delete restrict,
  decision text not null,
  decided_by uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  decided_at timestamptz not null default clock_timestamp(),
  proposal_digest text not null,
  constraint hr_payroll_approval_decision check(decision in ('approved','rejected','returned','held','canceled')),
  constraint hr_payroll_approval_reason check(btrim(reason)<>'' and char_length(reason)<=4000),
  unique(proposal_id,decided_at)
);

create or replace function private.enforce_hr_payroll_maker_checker() returns trigger
language plpgsql security definer set search_path='' as $$
declare proposal record;
begin
  select proposed_by,payload_digest into proposal from private.hr_payroll_change_proposals where id=new.proposal_id;
  if not found then raise foreign_key_violation using message='The payroll proposal does not exist.'; end if;
  if proposal.proposed_by=new.decided_by then raise insufficient_privilege using message='The proposer cannot approve their own payroll-impacting change.'; end if;
  if proposal.payload_digest<>new.proposal_digest then raise check_violation using message='The proposal changed after review began.'; end if;
  return new;
end $$;
create trigger hr_payroll_approval_maker_checker before insert on private.hr_payroll_change_approvals
for each row execute function private.enforce_hr_payroll_maker_checker();

create table private.hr_payroll_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references private.hr_payroll_integration_contracts(id) on delete restrict,
  source_batch_id uuid not null references private.payroll_export_batches(id) on delete restrict,
  comparison_key text not null,
  status text not null default 'queued',
  source_digest text not null,
  target_digest text,
  matched_rows integer not null default 0,
  difference_rows integer not null default 0,
  source_paid_minutes bigint not null default 0,
  target_paid_minutes bigint,
  started_by uuid not null references public.employees(id) on delete restrict,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  locked_at timestamptz,
  approval_note text,
  constraint hr_payroll_reconciliation_key check(btrim(comparison_key)<>'' and char_length(comparison_key)<=200),
  constraint hr_payroll_reconciliation_status check(status in ('queued','running','matched','differences','failed','approved','rejected')),
  constraint hr_payroll_reconciliation_counts check(matched_rows>=0 and difference_rows>=0 and source_paid_minutes>=0 and coalesce(target_paid_minutes,0)>=0),
  constraint hr_payroll_reconciliation_complete check((status in ('matched','differences','failed','approved','rejected') and completed_at is not null) or status in ('queued','running')),
  constraint hr_payroll_reconciliation_lock check((status in ('approved','rejected') and locked_at is not null and btrim(coalesce(approval_note,''))<>'') or status not in ('approved','rejected')),
  unique(source_batch_id,comparison_key)
);

create table private.hr_payroll_reconciliation_items (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references private.hr_payroll_reconciliation_runs(id) on delete restrict,
  stable_record_id text not null,
  comparison_status text not null,
  source_payload jsonb not null,
  target_payload jsonb,
  differences jsonb not null default '[]'::jsonb,
  recorded_at timestamptz not null default clock_timestamp(),
  constraint hr_payroll_reconciliation_item_status check(comparison_status in ('matched','missing_target','missing_source','value_difference','invalid')),
  constraint hr_payroll_reconciliation_item_payload check(jsonb_typeof(source_payload)='object' and (target_payload is null or jsonb_typeof(target_payload)='object') and jsonb_typeof(differences)='array'),
  unique(reconciliation_run_id,stable_record_id)
);

create table private.hr_payroll_integration_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  schema_version integer not null default 1,
  aggregate_type text not null,
  aggregate_id uuid not null,
  idempotency_key text not null unique,
  payload jsonb not null,
  payload_digest text not null,
  actor_id uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  occurred_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  constraint hr_payroll_event_type check(event_type ~ '^sygshift\.[a-z0-9_.]+\.v[0-9]+$'),
  constraint hr_payroll_event_schema check(schema_version>0),
  constraint hr_payroll_event_payload check(jsonb_typeof(payload)='object'),
  constraint hr_payroll_event_digest check(payload_digest ~ '^[a-f0-9]{64}$'),
  constraint hr_payroll_event_reason check(btrim(reason)<>'' and char_length(reason)<=4000)
);

create or replace function private.set_hr_payroll_event_digest() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  new.payload_digest := encode(extensions.digest(convert_to(new.payload::text,'UTF8'),'sha256'),'hex');
  return new;
end $$;
create trigger hr_payroll_event_digest before insert or update of payload
on private.hr_payroll_integration_events for each row
execute function private.set_hr_payroll_event_digest();

create table private.hr_payroll_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  endpoint_url text not null,
  secret_binding_name text not null,
  event_types jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  created_by uuid not null references public.employees(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint hr_payroll_webhook_https check(endpoint_url ~ '^https://'),
  constraint hr_payroll_webhook_secret check(secret_binding_name ~ '^[A-Z][A-Z0-9_]{2,127}$'),
  constraint hr_payroll_webhook_events check(jsonb_typeof(event_types)='array' and jsonb_array_length(event_types)>0)
);

create table private.hr_payroll_webhook_attempts (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references private.hr_payroll_webhook_subscriptions(id) on delete restrict,
  event_id uuid not null references private.hr_payroll_integration_events(id) on delete restrict,
  attempt_number integer not null,
  status text not null,
  response_code integer,
  response_digest text,
  attempted_at timestamptz not null default clock_timestamp(),
  next_attempt_at timestamptz,
  constraint hr_payroll_webhook_attempt_number check(attempt_number>0),
  constraint hr_payroll_webhook_attempt_status check(status in ('queued','delivered','retryable','failed','canceled')),
  unique(subscription_id,event_id,attempt_number)
);

create table private.hr_payroll_rollback_plans (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references private.hr_payroll_integration_contracts(id) on delete restrict,
  plan_version integer not null,
  status text not null default 'draft',
  trigger_conditions jsonb not null,
  recovery_steps jsonb not null,
  verification_steps jsonb not null,
  created_by uuid not null references public.employees(id) on delete restrict,
  approved_by uuid references public.employees(id) on delete restrict,
  approval_reason text,
  created_at timestamptz not null default clock_timestamp(),
  approved_at timestamptz,
  constraint hr_payroll_rollback_status check(status in ('draft','pending_approval','approved','retired')),
  constraint hr_payroll_rollback_payloads check(jsonb_typeof(trigger_conditions)='array' and jsonb_typeof(recovery_steps)='array' and jsonb_typeof(verification_steps)='array'),
  constraint hr_payroll_rollback_approval check((status='approved' and approved_by is not null and approved_at is not null and btrim(coalesce(approval_reason,''))<>'') or status<>'approved'),
  constraint hr_payroll_rollback_maker_checker check(approved_by is null or approved_by<>created_by),
  unique(contract_id,plan_version)
);

create table private.hr_payroll_rollback_executions (
  id uuid primary key default gen_random_uuid(),
  rollback_plan_id uuid not null references private.hr_payroll_rollback_plans(id) on delete restrict,
  status text not null default 'started',
  initiated_by uuid not null references public.employees(id) on delete restrict,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint hr_payroll_rollback_execution_status check(status in ('started','completed','failed')),
  constraint hr_payroll_rollback_execution_reason check(btrim(reason)<>'' and char_length(reason)<=4000),
  constraint hr_payroll_rollback_execution_evidence check(jsonb_typeof(evidence)='object'),
  constraint hr_payroll_rollback_execution_complete check((status in ('completed','failed') and completed_at is not null) or status='started')
);

create table private.hr_enterprise_verification_runs (
  id uuid primary key default gen_random_uuid(),
  scope text not null,
  release_version text not null,
  status text not null default 'running',
  checks jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  executed_by uuid not null references public.employees(id) on delete restrict,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint hr_enterprise_verification_scope check(scope in ('security','permissions','audit','accessibility','mobile','performance','backup','recovery','full_release')),
  constraint hr_enterprise_verification_status check(status in ('running','passed','failed','blocked')),
  constraint hr_enterprise_verification_payloads check(jsonb_typeof(checks)='array' and jsonb_typeof(evidence)='object'),
  constraint hr_enterprise_verification_complete check((status in ('passed','failed','blocked') and completed_at is not null) or status='running')
);

create index hr_payroll_proposals_status_effective_idx on private.hr_payroll_change_proposals(status,effective_on);
create index hr_payroll_reconciliation_status_started_idx on private.hr_payroll_reconciliation_runs(status,started_at desc);
create index hr_payroll_events_published_idx on private.hr_payroll_integration_events(published_at,occurred_at);
create index hr_enterprise_verification_status_started_idx on private.hr_enterprise_verification_runs(status,started_at desc);

create or replace function private.hr_stage10_assert_enabled(target_gate text) returns void language plpgsql stable security definer set search_path='' as $$
declare gate_enabled boolean;
begin
  if target_gate not in ('integration','webhooks','cutover') then raise check_violation using message='Unsupported Stage 10 gate.'; end if;
  select release_gate.enabled into gate_enabled from private.hr_stage10_release_gates release_gate where release_gate.gate=target_gate;
  if not coalesce(gate_enabled,false) then raise check_violation using message='This payroll integration capability is staged but not enabled.'; end if;
end $$;

create or replace function private.hr_stage10_require_actor_permission(target_actor_id uuid,target_permission text) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if not exists(select 1 from public.employees employee where employee.id=target_actor_id and employee.status='active') then raise insufficient_privilege using message='An active employee identity is required.'; end if;
  if not exists(select 1 from private.employee_accounts account where account.employee_id=target_actor_id and account.disabled_at is null and account.activated_at is not null) then raise insufficient_privilege using message='An active login is required.'; end if;
  if not (target_permission=any(coalesce(private.employee_effective_permissions(target_actor_id),array[]::text[]))) then raise insufficient_privilege using message='The requested payroll integration permission is required.'; end if;
end $$;

create or replace function private.hr_stage10_require_recent_mfa(target_method text,target_verified_at timestamptz) returns void language plpgsql stable security definer set search_path='' as $$
begin
  if target_method not in ('authenticator','totp','security_key','webauthn','recovery_code') or target_verified_at is null or target_verified_at < clock_timestamp()-interval '15 minutes' or target_verified_at > clock_timestamp()+interval '1 minute' then
    raise insufficient_privilege using message='Recent MFA verification is required for payroll integration access.';
  end if;
end $$;

create or replace function public.service_get_hr_stage10_workspace(
  target_actor_id uuid,target_page_size integer default 10,target_offset integer default 0,
  target_mfa_method text default null,target_mfa_verified_at timestamptz default null
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  page_size integer:=case when target_page_size in (5,10,20) then target_page_size else 10 end;
  row_offset integer:=greatest(coalesce(target_offset,0),0);
  contract_payload jsonb;
  gate_payload jsonb;
  counts_payload jsonb;
  items_payload jsonb;
begin
  if (select auth.role())<>'service_role' then raise insufficient_privilege using message='Service role required.'; end if;
  perform private.hr_stage10_assert_enabled('integration');
  perform private.hr_stage10_require_actor_permission(target_actor_id,'hr.payroll_integration.view');
  perform private.hr_stage10_require_recent_mfa(target_mfa_method,target_mfa_verified_at);

  select jsonb_build_object('version',contract_version,'status',status,'digest',payload_digest,'effectiveOn',effective_from,'approvedAt',approved_at)
  into contract_payload from private.hr_payroll_integration_contracts order by proposed_at desc limit 1;
  select jsonb_object_agg(gate,jsonb_build_object('enabled',enabled,'updatedAt',updated_at)) into gate_payload from private.hr_stage10_release_gates;
  counts_payload:=jsonb_build_object(
    'pendingProposals',(select count(*) from private.hr_payroll_change_proposals where status='pending_approval'),
    'pendingApprovals',(select count(*) from private.hr_payroll_change_proposals where status='pending_approval' and proposed_by<>target_actor_id),
    'reconciliationRuns',(select count(*) from private.hr_payroll_reconciliation_runs),
    'differences',(select coalesce(sum(difference_rows),0) from private.hr_payroll_reconciliation_runs where status in ('differences','failed'))
  );
  select coalesce(jsonb_agg(row.payload order by row.sort_at desc),'[]'::jsonb) into items_payload from (
    select proposal.updated_at sort_at,jsonb_build_object(
      'id',proposal.id,'title',initcap(replace(proposal.change_type,'_',' ')),
      'subtitle',case when employee.id is null then 'Company-level proposal' else concat_ws(' ',employee.first_name,employee.last_name) end,
      'status',proposal.status,'dateLabel',proposal.effective_on,'detail',proposal.proposal_reason
    ) payload
    from private.hr_payroll_change_proposals proposal
    left join public.employees employee on employee.id=proposal.employee_id
    order by proposal.updated_at desc limit page_size offset row_offset
  ) row;
  return jsonb_build_object('enabled',true,'pageSize',page_size,'offset',row_offset,'authority','SygShift Payroll','contract',coalesce(contract_payload,'{}'::jsonb),'gates',coalesce(gate_payload,'{}'::jsonb),'counts',counts_payload,'items',items_payload);
end $$;

do $$ declare relation_name text; begin
  foreach relation_name in array array[
    'hr_stage10_release_gates','hr_payroll_integration_contracts','hr_payroll_change_proposals','hr_payroll_change_approvals',
    'hr_payroll_reconciliation_runs','hr_payroll_reconciliation_items','hr_payroll_integration_events',
    'hr_payroll_webhook_subscriptions','hr_payroll_webhook_attempts','hr_payroll_rollback_plans',
    'hr_payroll_rollback_executions','hr_enterprise_verification_runs'
  ] loop
    execute format('alter table private.%I enable row level security',relation_name);
    execute format('revoke all on private.%I from public,anon,authenticated',relation_name);
    execute format('grant select,insert,update on private.%I to service_role',relation_name);
  end loop;
  create trigger hr_payroll_contracts_append_only before update or delete on private.hr_payroll_integration_contracts for each row execute function private.prevent_append_only_change();
  create trigger hr_payroll_approvals_append_only before update or delete on private.hr_payroll_change_approvals for each row execute function private.prevent_append_only_change();
  create trigger hr_payroll_reconciliation_items_append_only before update or delete on private.hr_payroll_reconciliation_items for each row execute function private.prevent_append_only_change();
  create trigger hr_payroll_events_append_only before update or delete on private.hr_payroll_integration_events for each row execute function private.prevent_append_only_change();
  create trigger hr_payroll_webhook_attempts_append_only before update or delete on private.hr_payroll_webhook_attempts for each row execute function private.prevent_append_only_change();
  create trigger hr_payroll_rollback_executions_append_only before update or delete on private.hr_payroll_rollback_executions for each row execute function private.prevent_append_only_change();
end $$;

revoke all on function private.enforce_hr_payroll_maker_checker() from public,anon,authenticated;
revoke all on function private.set_hr_payroll_contract_digest() from public,anon,authenticated;
revoke all on function private.set_hr_payroll_proposal_digest() from public,anon,authenticated;
revoke all on function private.set_hr_payroll_event_digest() from public,anon,authenticated;
revoke all on function private.hr_stage10_assert_enabled(text) from public,anon,authenticated;
revoke all on function private.hr_stage10_require_actor_permission(uuid,text) from public,anon,authenticated;
revoke all on function private.hr_stage10_require_recent_mfa(text,timestamptz) from public,anon,authenticated;
revoke all on function public.service_get_hr_stage10_workspace(uuid,integer,integer,text,timestamptz) from public,anon,authenticated;
grant execute on function private.enforce_hr_payroll_maker_checker() to service_role;
grant execute on function private.set_hr_payroll_contract_digest() to service_role;
grant execute on function private.set_hr_payroll_proposal_digest() to service_role;
grant execute on function private.set_hr_payroll_event_digest() to service_role;
grant execute on function private.hr_stage10_assert_enabled(text) to service_role;
grant execute on function private.hr_stage10_require_actor_permission(uuid,text) to service_role;
grant execute on function private.hr_stage10_require_recent_mfa(text,timestamptz) to service_role;
grant execute on function public.service_get_hr_stage10_workspace(uuid,integer,integer,text,timestamptz) to service_role;

do $$ declare baseline record; begin
  select * into baseline from hris_stage10_preservation_baseline;
  if baseline.employee_count<>(select count(*) from public.employees)
    or baseline.employee_role_count<>(select count(*) from public.employee_access_roles)
    or baseline.role_permission_count<>(select count(*) from public.access_role_permissions)
    or baseline.override_count<>(select count(*) from public.employee_permission_overrides)
    or baseline.account_count<>(select count(*) from private.employee_accounts)
    or baseline.schedule_count<>(select count(*) from public.schedules)
    or baseline.time_event_count<>(select count(*) from public.time_events)
    or baseline.payroll_batch_count<>(select count(*) from private.payroll_export_batches)
    or baseline.payroll_row_count<>(select count(*) from private.payroll_export_rows) then
    raise exception 'Stage 10 changed protected identities, access assignments, accounts, schedules, time records, or locked payroll evidence.';
  end if;
end $$;

commit;
