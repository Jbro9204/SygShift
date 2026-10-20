Historical evidence recovered on 10/19/2026 from SygShift Legacy, source turn 01a15509-8bd9-77d2-9a37-b7aa1fc25a92. These are prior audit counts, not this run's baseline or after-state. The statement that no owning Sygilant source was found has been superseded: its active worktree was located during this run. No raw credentials or private employee records are included.

## Database audit complete

No changes were made to production, migrations, data, permissions, deployments, or email records.

### Bottom line

The database is currently online and has sufficient capacity. This is not a general overload problem.

However, I confirmed several real defects:

1. A broken Sygilant database trigger is generating hundreds of errors daily and blocking part of the client-email workflow.
2. A SygShift timekeeping review query is timing out.
3. Production and repository migration histories have seriously diverged.
4. Eight stored procedures contain verified SQL defects.
5. Notification failures and intentional suppressions are being mixed together, inflating failure reporting.

### Critical active findings

| Finding | Evidence and impact |
|---|---|
| Broken client-email trigger | 564 occurrences in the preceding 24 hours of `record "new" has no field "resource_type"`. |
| SygShift timekeeping timeout | 10 HTTP 500 responses from `get_timekeeping_review` and 13 database statement-timeout cancellations. |
| Migration divergence | 276 matching migrations, 108 local-only, and 89 production-only. |
| Broken stored procedures | Database lint identified eight PL/pgSQL errors, including Worker-called HR functions. |

#### 1. Broken Sygilant client-email workflow

The exact failure chain is:

`sygilant_service_claim_client_communication_email`\
→ inserts into `sygilant_email_outbox`\
→ activates `sygilant_validate_client_portal_complete_relationships`\
→ trigger references `NEW.resource_type`\
→ `sygilant_email_outbox` does not have that column.

The trigger is attached to 18 tables, but only two contain `resource_type`.

This is the largest active error source and is an application/schema defect—not a Supabase outage. It can prevent client-communication emails from entering the outbox.

#### 2. SygShift timekeeping review is timing out

Between 9:35 AM and 10:49 AM Eastern on October 19:

- `get_timekeeping_review` returned ten HTTP 500 responses.
- PostgreSQL canceled thirteen statements for exceeding the timeout.

This directly affects timecard review. The correct response is query-plan and indexing analysis; simply increasing the timeout would hide the underlying issue.

#### 3. Migration history is unsafe

Current comparison:

- 384 local migration files
- 365 production migration records
- 276 matching
- 108 local-only
- 89 production-only
- Local history ends at `20261019130405`
- Production continues through `20261019163000`

Some production-only migrations belong to Sygilant in the shared database, but their source files were not present in any repository found on this machine.

Consequences:

- Production cannot be reliably rebuilt from source control.
- A routine linked `db push` is unsafe.
- Release review and rollback analysis are incomplete.
- Database behavior can change without the active repository reflecting it.

The repository itself acknowledges earlier drift in [DEVLOG.md](C:/Users/Jordan/Projects/SygShift-misty-timezone/DEVLOG.md:1278).

Do not blindly “repair” the migration ledger. Production needs to be captured as a controlled baseline first.

#### 4. Eight stored procedures have verified SQL defects

The most operationally relevant are:

- `service_enqueue_hr_task_escalations`: invalid SQL alias usage. The scheduled Worker calls it from [worker/index.ts](C:/Users/Jordan/Projects/SygShift-misty-timezone/worker/index.ts:8651).
- `service_hr_operational_action`: ambiguous `employee_id`. The Worker calls it from [worker/index.ts](C:/Users/Jordan/Projects/SygShift-misty-timezone/worker/index.ts:6121).
- `service_save_hr_workflow_draft`: ambiguous `definition_id` in [20260830223000_hris_stage5_reliability_controls.sql](C:/Users/Jordan/Projects/SygShift-misty-timezone/supabase/migrations/20260830223000_hris_stage5_reliability_controls.sql:170).
- `private.enqueue_hr_workflow_jobs`: malformed JSON/array expression in the same [migration](C:/Users/Jordan/Projects/SygShift-misty-timezone/supabase/migrations/20260830223000_hris_stage5_reliability_controls.sql:294).

Four additional errors affect import, legacy promotion, and backfill functions. Some may be dormant, but the Worker-facing functions are active reliability concerns.

### Other important findings

- Deployed callers are requesting nonexistent objects or columns:

  - `public.sygilant_permissions`
  - `public.sygilant_report_packages`
  - `client_documents.provenance`

  This shows that some deployed code and the current schema disagree.

- Permission errors are occurring for `get_session_context` and `employee_effective_permissions`. These need caller/grant-path tracing.

- The notification outbox has one `schedule_published` item permanently stranded at five attempts—neither delivered nor failed. The claimant stops selecting it after attempt five. The relevant behavior begins in [20260909220000_employee_writeup_and_signature_delivery.sql](C:/Users/Jordan/Projects/SygShift-misty-timezone/supabase/migrations/20260909220000_employee_writeup_and_signature_delivery.sql:243).

- There were 19 recent email-delivery failures, but all involved one recipient suppressed by the email provider after bounces or spam reports. This is not a general email-provider outage.

- Of 61 historical outbox “failures”:

  - 31 were actually intentional preference/lifecycle suppressions.
  - 27 were older provider-quota failures.
  - 3 were current bounce-suppression failures.

  Intentional suppression should not be classified as operational failure.

- `private.audit_events` contains 312,415 records and occupies about 549 MiB—roughly two-thirds of the database. More than 5,800 recent shift audit entries only changed `updated_at`. Audit history must be preserved, but partitioning/archival and no-op reduction are warranted. The full-row audit behavior originates in [202607030001_foundation.sql](C:/Users/Jordan/Projects/SygShift-misty-timezone/supabase/migrations/202607030001_foundation.sql:788).

- 738 foreign keys lack supporting indexes. These should be prioritized by actual workload, not automatically added in bulk.

- Minute-level timekeeping job history is unbounded. It already contains approximately 84,800 records. Recent job records were healthy, but retention or rollup rules are needed.

### Security assessment

Positive findings:

- All 179 public tables have row-level security enabled.
- No public table grants anonymous access.
- No public `SECURITY DEFINER` function was executable anonymously.
- No invalid indexes, unvalidated constraints, disabled triggers, or public/private tables without primary keys were found.
- No confirmed privilege bypass was identified.

Review backlog:

- 379 public `SECURITY DEFINER` functions are callable by signed-in users.
- Thirty-seven did not have an obvious inline authorization guard and require manual review.
- Fourteen tables have overlapping permissive policies.
- The 405 “RLS enabled without policy” notices primarily concern deliberately sealed private tables and are not evidence of public exposure.

### Current health

At the final check:

- Supabase status: `ACTIVE_HEALTHY`
- Connections: 34 of 60
- Blocked sessions: 0
- Deadlocks: 0
- Idle transactions: 0
- Replication lag observed: 0
- Gateway 5xx responses during final 15 minutes: 0

Earlier on October 19, there was a separate provider/data-plane incident with 133 gateway infrastructure errors and a PostgreSQL restart. It had recovered by the final check.

On October 16, the Worker also recorded 15 scheduled timekeeping automation failures caused by 504 timeouts. Those are historical and distinct from the active trigger defect.

### Failure-email review

I reviewed 1,188 Outlook messages from September 19 through October 19 and ran targeted searches in connected Outlook and Gmail sources.

I did not find the automated daily database/runtime failure emails described. The connected Dispatch mailbox also returned no matching messages. The messages reviewed did confirm recurring user-facing problems in:

- Timekeeping and payroll calculations
- Occurrence and coverage workflows
- Permissions and data visibility
- TrackTik upload idempotency/recovery

One original automated failure email—or identification of the mailbox receiving it—is still needed to match that email precisely to a database or Worker signature.

### Recommended resolution order

1. Repair the shared trigger with a forward-only migration and regression-test all 18 attached tables. Then safely recover affected client-email work with idempotency protection.
2. Profile and optimize `get_timekeeping_review`.
3. Pause ordinary database pushes until production migrations are captured, classified by application, and reconciled with source control.
4. Repair the eight lint-failing functions with forward-only migrations and focused tests.
5. Remove or update stale schema callers and correct the affected permission paths.
6. Separate `failed`, `suppressed`, `canceled`, and `retry-exhausted` notification states.
7. Introduce audit-history partitioning/retention without deleting required historical records.
8. Prioritize foreign-key indexes using actual slow-query and lock evidence.
9. Alert on unique error signatures and failed workflows rather than raw error totals.

The audit followed current [Supabase observability guidance](https://supabase.com/docs/guides/observability) and database-function debugging practices. Audit-generated diagnostic errors were excluded from the production findings.
