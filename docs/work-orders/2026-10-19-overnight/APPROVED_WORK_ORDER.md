Recovered on 10/19/2026 from the owner's approved work-order conversation, SygShift Legacy. The automation prompt is the current authorization and overrides any earlier instruction to wait for the owner. Scheduled window: 10/19/2026 7:00 PM EDT–10/20/2026 7:00 AM EDT. Source turn: 01a1551f-d8ad-7063-90b9-6b2548c54a04.

# Overnight Work Order: Database Stabilization and Recovery

## Objective

Repair the active SygShift/Sygilant database failures while preserving all payroll, punches, schedules, identities, audit history, and production records.

## Non-negotiable safeguards

- No database reset or destructive migration.
- No blind `db push`.
- Forward-only migrations.
- Capture every affected production definition before changing it.
- Separate SygShift, Sygilant, and shared-database ownership.
- No payroll submission, pay-rate changes, or identity corrections.
- Each production change gets its own validation and fallback point.

## Overnight priority work

### 1. Capture the production baseline

- [ ] Record current health, error signatures, and failure counts.
- [ ] Export affected functions, triggers, grants, policies, and table definitions.
- [ ] Record the complete production migration ledger.
- [ ] Establish rollback definitions before the first deployment.
- [ ] Confirm current Worker and database release versions.

**Gate:** No production repair proceeds without a recoverable before-state.

### 2. Repair the Sygilant client-email trigger

- [ ] Create a forward-only migration for `sygilant_validate_client_portal_complete_relationships`.
- [ ] Ensure it only accesses columns that exist on the triggering table.
- [ ] Test inserts and updates against all 18 attached tables.
- [ ] Verify `sygilant_email_outbox` accepts records.
- [ ] Confirm client-email claiming succeeds.
- [ ] Identify missed communications.
- [ ] Replay only verified missing work with duplicate protection.

**Acceptance:** The `NEW.resource_type` failure stops, and no unrelated client-table workflow regresses.

### 3. Repair SygShift timekeeping review

- [ ] Reproduce `get_timekeeping_review` timeouts with representative production parameters.
- [ ] Inspect the execution plan and expensive joins.
- [ ] Correct query structure and add only justified indexes.
- [ ] Test historical periods, large teams, overnight shifts, adjustments, and incomplete punch pairs.
- [ ] Verify overview, employee detail, breakdown, and payroll-facing results remain consistent.
- [ ] Confirm punches and payroll records were not modified.

**Acceptance:** Review requests complete reliably without increasing the timeout or changing calculated time.

### 4. Repair active stored procedures

Prioritize Worker-called functions:

- [ ] `service_enqueue_hr_task_escalations`
- [ ] `service_hr_operational_action`
- [ ] `service_save_hr_workflow_draft`
- [ ] `private.enqueue_hr_workflow_jobs`

Then repair and test the four import/backfill/legacy functions.

**Acceptance:** Database lint returns no function errors, and the relevant Worker paths pass focused tests.

### 5. Correct stale schema and permission contracts

- [ ] Trace callers requesting `sygilant_permissions`.
- [ ] Trace callers requesting `sygilant_report_packages`.
- [ ] Trace references to `client_documents.provenance`.
- [ ] Resolve `get_session_context` permission failures.
- [ ] Resolve `employee_effective_permissions` failures.
- [ ] Remove obsolete callers or restore the correct supported contract—without creating fake compatibility tables.

### 6. Repair notification reliability

- [ ] Separate `failed`, `suppressed`, `canceled`, and `retry_exhausted`.
- [ ] Stop retrying provider-suppressed recipients.
- [ ] Resolve the stranded five-attempt schedule notification.
- [ ] Preserve complete delivery history.
- [ ] Ensure intentional suppression does not generate failure alerts.
- [ ] Verify automatic clock-out and schedule messages independently.

### 7. Reconcile migration ownership

- [ ] Inventory all 89 production-only migrations.
- [ ] Inventory all 108 local-only migrations.
- [ ] Identify which belong to SygShift, Sygilant, or shared infrastructure.
- [ ] Locate or reconstruct missing Sygilant migration sources.
- [ ] Produce a controlled production baseline.
- [ ] Add a release gate that detects migration drift before deployment.

**Restriction:** Migration ledger reconciliation will not be forced overnight if validation is incomplete. The deliverable will be a verified baseline and safe reconciliation plan rather than a risky shortcut.

## Follow-on hardening

These can be analyzed overnight but should deploy only when independently verified:

- [ ] Audit-history partitioning and retention design.
- [ ] Reduction of meaningless `updated_at`-only audit churn.
- [ ] Workload-based prioritization of unindexed foreign keys.
- [ ] Manual authorization review of exposed `SECURITY DEFINER` functions.
- [ ] Retention/rollup for minute-level job history.
- [ ] Signature-based monitoring so one defect does not produce hundreds of indistinguishable alerts.

## Final overnight validation

- [ ] SygShift login, schedule, timekeeping, and review smoke tests.
- [ ] Sygilant client-email and document-related smoke tests.
- [ ] Worker scheduled-cycle verification.
- [ ] No new trigger, permission, or statement-timeout errors.
- [ ] No blocked sessions, deadlocks, or connection exhaustion.
- [ ] Compare before/after error counts.
- [ ] Confirm no payroll, punch, identity, or audit records changed unexpectedly.
- [ ] Produce a release report with commits, migrations, tests, deployments, remaining risks, and any deferred work.

If a stage fails validation, that stage stops at its fallback point while previously validated repairs remain intact.
