# Authorization and growth-hardening review

Reviewed October 19–20, 2026 against the captured production catalog, bounded live checks and subsequent guarded repair receipts. PostgreSQL reports version 17.6. Initial investigation was read-only; the independently approved authorization and shift-audit repairs described below were subsequently installed. Historical findings and original hashes remain identified as baseline evidence.

## Outcome

The 35 functions lacking an obvious inline guard are **not 35 proven vulnerabilities**. Most delegate to enforcing functions or return an intentionally narrow predicate/status payload. Manual tracing identified three concrete authorization issues affecting four of those function names:

1. The two imported-schedule preview functions expose private import payloads to an authenticated caller without an active employee or operational permission check.
2. `has_valid_credential` reveals another employee's qualification predicate while bypassing the credential table's row policy.
3. The support-ticket Admin branch bypasses MFA-sensitive effective permissions. A read-only probe confirmed assignee access at AAL1; the same predicate is also used by privileged support reads and mutations.

These baseline findings were subsequently repaired by independently tested migration `20261019233625` from source `7f867dc630105d42f7ea472f3febb11d9198b017`. See `AUTHORIZATION_CANDIDATE.md` for exact installed hashes, allow/deny preservation tests and limitations. The descriptions below retain the original evidence and original hashes; they do not imply the vulnerabilities remain in those installed definitions.

Installation at approximately 23:44:46 UTC and five-group hosted installed validation passed. The exact batch SHA-256 is `fb6d53c6109a00d3c6214ea755579994f99e6dfd69d4dbce3590ecc37598d022`; the mandatory fresh-ledger gate accepted the committed 371-version v2 baseline before activation. Nine restored-fixture groups, five hosted groups, exact ledger/forward-recovery rollback and drift-refusal evidence are recorded in `AUTHORIZATION_CANDIDATE.md`. The three concrete baseline issues are resolved within this reviewed scope. The coupled notification DB/browser/Worker candidate remains held by its documented release gates.

Baseline live privilege checks found **661 public SECURITY DEFINER functions and zero anonymous-callable functions**. Anonymous and authenticated roles both lack `USAGE` on `private`. Every one of the selected 35 had authenticated and service execution; none had anonymous execution. All 35 pre-repair definition hashes matched the captured baseline. The credential repair intentionally reduces the public definer count by one; all edited functions retain the reviewed owners, ACLs and configurations, with no anonymous/private-schema exposure added.

## Evidence and method

The baseline is [`catalog-before.json`](/C:/Users/Jordan/Projects/SygShift-misty-timezone/backups/overnight-2026-10-19/catalog-before.json). Its function entries retain full identities, definitions, owners, ACLs, and hashes. The selected list and exact current identities/hashes are in [`current-acls.json`](/C:/Users/Jordan/Projects/SygShift-misty-timezone/tmp/overnight-authorization/current-acls.json). Read-only probe SQL and aggregate results are under [`tmp/overnight-authorization`](/C:/Users/Jordan/Projects/SygShift-misty-timezone/tmp/overnight-authorization).

Selection used the prior lexical screen only to identify review targets. Conclusions below come from reading wrapper order, delegated authorization, row predicates, current grants, permission metadata, and three bounded probes. No raw employee identifiers, names, contacts, source rows, or ticket contents were returned by these probes. Test claims and role changes were transaction-local and ended with `ROLLBACK`; no authentication sessions or persistent impersonation records were created.

`public.get_effective_permissions()` filters permissions through an active employee and `permission_catalog.requires_mfa`; `has_effective_permission` and `has_any_effective_permission` delegate to it. Current catalog entries for the reviewed user-administration, schedule-management, announcement, accountability, and support permissions all require MFA. Therefore the absence of a literal `has_mfa()` in a wrapper is not sufficient to establish a missing MFA boundary.

## Function-level review

The names below identify the exact overloads in the 35-entry identity/hash evidence. All use a controlled empty search path. “Guarded” describes the reviewed call chain, not a proof of every unrelated workflow or every future permission configuration.

| Public function | Enforcing boundary or explicit behavior | Review result |
| --- | --- | --- |
| `admin_create_employee_with_time_zone` | Calls `admin_create_employee`, whose first action is `private.require_any_user_admin_permission`; then calls separately guarded `admin_set_employee_time_zone`. Role elevation has additional access-control checks. | Guarded. |
| `admin_update_employee_with_time_zone` | Calls `admin_update_employee` and, when needed, `admin_set_employee_time_zone`; both enforce effective user-administration/access-control permissions. | Mutations guarded. The wrapper and underlying updater read/lock the target before authorization; move the initial authorization ahead of that work to remove an existence/error distinction and avoid unnecessary locks. |
| `create_attendance_accountability_event_v2` | Calls `create_attendance_accountability_event` before extending the returned occurrence. Base requires an active employee, `accountability.create`, and MFA. | Guarded. |
| `create_payroll_export_batch` | Review delegates through the self/team time boundary; the final `private.create_payroll_export_batch_pre_payroll_category` requires active employee, MFA, and `time.export_payroll` before locking an export. | Export mutation guarded. An explicit early export guard would avoid unnecessary review/occurrence-lock work for a caller later denied export authority. No payroll operation was executed for this review. |
| `decide_time_off_request` | Delegates to `decide_time_off_request_v2`: active reviewer, `requests.manage`, MFA, and rejection of reviewing one's own request. | Guarded. |
| `get_accountability_workspace_v2` | Initializes its payload through `get_accountability_workspace`, which requires an active employee, MFA, and `accountability.view` or `accountability.manage`, before enrichment. | Guarded. |
| `get_bible_schedule_preview` | Baseline directly queried protected source imports without actor/permission checks. Installed function calls existing `private.require_import_admin()` before reading those records. | **Issue A repaired and installed.** |
| `get_call_off_coverage_workspace` | First calls `private.get_call_off_coverage_workspace_pre_call_off_lifecycle`; this requires `private.shift_coverage_manager_allowed()`. | Guarded before report enrichment. |
| `get_imported_schedule_preview` | Unchanged alias delegates to the now-guarded `get_bible_schedule_preview`; authorized payload remains equivalent. | **Issue A repaired through shared boundary.** |
| `get_maintenance_status` | Projects an explicit employee-safe maintenance/status field list; no identity records, provider secrets, internal notes, or mutations. | Intentional narrow status boundary. Current database grant is authenticated/service only; signed-out access remains Worker-owned. |
| `get_payroll_accountability_events` | First calls `private.get_payroll_accountability_events_pre_calloff_idempotency`: active employee, MFA, and one of the documented time/payroll/accountability permissions. Enrichment is limited to returned event IDs. | Guarded. |
| `get_support_ticket_assignees` | Uses `private.support_can_manage(ticket)`. Both shared support predicates now require existing verified MFA for elevated Admin access; own-ticket and permission-plus-route paths retain their policy. | **Issue C repaired and installed.** |
| `get_time_off_request_context` | Delegates to `get_time_off_request_context_v2`, which derives the active employee from authentication and returns that employee's context/affected shifts. | Self-scoped. Preserves ordinary employee access without requiring privileged MFA. |
| `get_timekeeping_operations_workspace` | Delegates through `private.get_timekeeping_operations_workspace_pre_absence_completion`, `_edit_base`, and `_base`. Base requires an active employee; team fields are permission-filtered, and ordinary shifts are restricted to the current employee. | Guarded/self-scoped; no inference that every employee needs team permissions. |
| `get_timekeeping_review` | Delegates through payroll-category, salary-boundary, preferred-name, and operations wrappers to `private.get_timekeeping_review_base`. Base requires active employee and filters effective events, salary rows, and corrections to self unless MFA plus an allowed team-time permission is present. | Guarded/self-scoped. |
| `has_shared_identity_session` | Calls `has_scoped_shared_identity_session` for the two supported scopes. Callee binds active employee, Auth user, current session ID, hashed header token, scope, expiry, revocation, account state, and assurance. | Current-session boolean; no arbitrary identity parameter. |
| `has_valid_credential` | Installed SECURITY INVOKER predicate uses the unchanged query under existing self/Licensing RLS. All 22 captured definer callers preserve their authorized owner context. | **Issue B repaired and installed.** |
| `is_actionable_schedule_review_note` | Computes a boolean from supplied text/end time and server time; reads no protected table. | Argument/clock-only predicate. |
| `publish_call_off_opening` | Calls `resolve_call_off_coverage`, which first checks `private.shift_coverage_manager_allowed`. | Guarded. |
| `publish_templated_announcement_with_acknowledgment` | Calls guarded `publish_templated_announcement` (`announcements.send`) and, when required, separately guarded `set_announcement_acknowledgment_requirement` (`announcements.acknowledgments.manage` plus MFA). | Guarded transaction; a failed second authorization rolls back the publication. |
| `remove_schedule_draft_shift` | First calls `private.remove_schedule_draft_shift_unmerged`: active actor plus `schedule.delete_shift`. Normalization follows successful authorization. | Guarded. |
| `replace_schedule_week_draft_with_payroll_categories_v1` | Delegates to `_with_work_types`, then `replace_schedule_week_draft_from_revision`: active actor plus `private.can_manage_schedule_drafts()`. | Guarded. |
| `replace_schedule_week_draft_with_work_types` | Delegates to `replace_schedule_week_draft_from_revision`. | Guarded. |
| `resolve_call_off_coverage` | First checks `private.shift_coverage_manager_allowed`: active actor, MFA, and an allowed request/pool/announcement/schedule permission. Then locks the report and checks lifecycle/idempotency. | Guarded. |
| `scheduler_add_draft_shift_assignment` | Reads source shift metadata, then calls `_v2`, which checks active actor and `private.can_manage_schedule_drafts()` before any mutation. | Mutation guarded. Move the wrapper's preliminary read behind the guard when hardening guard order. |
| `scheduler_create_coverage_plan_batch_with_payroll_category_v1` | Calls `scheduler_create_coverage_plan_batch_v1`, which checks active actor and draft-management permission before creating coverage; category changes follow returned shift IDs. | Guarded. |
| `scheduler_create_coverage_plan_with_payroll_category_v1` | Both branches (`scheduler_create_employee_local_coverage_plan_v3` and `scheduler_create_coverage_plan_v3`) check active actor and draft-management permission before work. | Guarded on both branches. |
| `scheduler_create_open_shift` | Delegates to `create_supervisor_open_shift`, which checks active actor and draft-management permission first. | Guarded. |
| `scheduler_create_typed_open_shift_with_payroll_category_v1` | Calls typed wrapper, then open-shift wrapper, then guarded `create_supervisor_open_shift`; category update follows success. | Guarded. |
| `scheduler_create_typed_open_shift` | Validates work type, delegates through `scheduler_create_open_shift`, then calls separately guarded `set_shift_work_type`. | Guarded. |
| `scheduler_resolve_review_shift` | Calls `resolve_schedule_review_shift`: active actor and draft-management permission before reading the target. | Guarded. |
| `scheduler_update_draft_shift` | Calls `update_schedule_draft_shift`: active actor and draft-management permission before target locks/mutations. | Guarded. |
| `scheduler_update_typed_draft_shift_with_payroll_category_v1` | Calls `scheduler_update_typed_draft_shift_v3`: active actor and draft-management permission; subsequent category change uses the authorized target. | Guarded. |
| `submit_time_off_request` | Delegates to `_v2`, which derives the active employee, locks that identity, verifies active status, and never accepts another employee ID. | Self-scoped; ordinary sick/time-off access is preserved. |
| `sygsphere_upload_capabilities` | First calls `private.sygsphere_request('presence', '{}')`: active employee, secure-session/password/MFA checks, and SygSphere release gate, before returning bounded upload policy values. | Guarded. This is not a pure read: the presence delegate writes activity. It was inspected but not executed during read-only probes. |

## Confirmed issues and bounded reproduction results

### A. Private imported-schedule preview lacks an active-employee/permission boundary

Definition hashes: `get_bible_schedule_preview(date)` = `33e8759be4df799d9383e17e3265b463`; `get_imported_schedule_preview(date)` = `20c9dde24dadaa0e5c1cd6fe4616081a`.

The read-only probe ran as database role `authenticated` with no Auth subject or active employee. It reported `no_active_employee_context=true`, `latest_import_has_weekly_candidate=true`, and `imported_preview_response_type=object`. No payload fields were returned to the report. The result establishes an actual bypass of the private source-data boundary, not merely a missing keyword.

Browser source defines the RPC transport, but `SchedulePage` has `importedPreviewQuery.enabled=false`; that dormant browser workflow never provided an authorization boundary. Installed repair calls the existing `private.require_import_admin()`, enforcing MFA-filtered `admin.security.manage`, before the underlying source read. Current and legacy names retain equivalent authorized payloads; ordinary, unlinked, disabled and AAL1 source callers are denied. No private-schema grant or compatibility table was added. Installed underlying MD5 is `8d4afde02e4623b04572db5fe08d94e6`; the public alias remains unchanged.

### B. Credential predicate bypasses credential row policy

Hash: `has_valid_credential(uuid,credential_kind,date)` = `e5c3d9659547262f75f58c28f96bc5f1`.

`credentials_read` normally limits records to self or effective Licensing/credential-management authority. Under authenticated role with no active employee, the read-only probe observed zero visible credential rows but `has_valid_credential(...) = true` for an internally selected valid credential. The selected identity and credential record were never output. This reveals a boolean qualification property, not a full credential document, but it violates the table's scoping boundary.

Installed repair preserves the query and signature but uses SECURITY INVOKER, allowing existing credential RLS to govern direct calls. All 22 captured callers are SECURITY DEFINER and retain the enclosing authorized owner context; 31 exact dependency guards prevent unnoticed caller/security drift. Tests prove own and authorized Licensing eligibility, ordinary peer denial, unlinked/disabled false, and preserved nested qualification. No direct browser RPC call was found in current `src`/Worker code. Installed MD5 is `05ce24272d6d1cff14e318f1283b851f`; no new helper, permission or grant was needed.

### C. Support Admin role bypasses MFA-sensitive permission filtering

`private.support_can_manage(support_tickets)` hash = `dedc73265327d5b487e99593e8a30097`. The helper accepts an active Admin role independently of `has_effective_permission`. `private.support_can_view` has a similar Admin branch. `current_app_role()` derives the role from the active employee but does not add MFA.

The isolated read-only AAL1 probe reported an existing active Admin context, `has_mfa=false`, `has_effective_support_management=false`, and an assignee count of two. Names and ticket details were not returned. Definition review additionally found `update_support_ticket`, internal `add_support_ticket_message`, and support readers relying on the same helper without an independent Admin MFA check. These mutation paths were **not executed**.

Installed repair requires existing `public.has_mfa()` on the Admin branches of both shared predicates, retaining submitter self-service reads/replies and non-Admin support-plus-route checks. Nine local/five hosted groups cover Admin AAL1 denial/AAL2 permitted reads, confidential routes, ordinary submitters, unlinked/disabled callers and nested qualification; local fixtures also cover real permitted ticket updates/internal notes under rollback. Hosted validation performs no persistent ticket or provider mutation. Installed manage/view MD5s are `0b7e58a617c0ddc18fefca26cc2b799d` / `761615014994b6851c3fe1d0229ee421`. Employee clock and urgent absence remain independently guarded workflows.

## Audit churn: installed narrow repair

The baseline `private.write_audit_event()` hash was `b71cc8d34713424231da43820bc94c1e`; it wrote whole before/after JSON for every hooked update. Installed `20261019232727` from pushed source `257eda82378b44e80f60bee5eb4c59c5b9b63f73` changes its hash to `0144a3e9b68e95d5abc10d9ba9b377aa`. All 104 exact trigger attachments and security metadata remain unchanged; this is a public.shifts-only update rule.

Current aggregate evidence: 313,694 audit records, 577,871,872 total relation bytes (about 551 MiB). In the latest 20,000 audit records, 7,417 are shift updates and 3,658 change only `updated_at` (49.3% of sampled shift updates). This is a bounded recent sample, not a claim about every historical shift update.

The installed writer returns `NEW` **only** for `TG_OP='UPDATE'`, `TG_TABLE_SCHEMA='public'`, `TG_TABLE_NAME='shifts'`, both JSON records containing `updated_at`, a distinct old/new timestamp, and equality of the entire remaining JSON records after removing that one key. Returning `NEW` preserves the underlying shift update. INSERT, DELETE, identical final-row updates, every other table, and every business-field difference retain auditing. The complete-row comparison automatically includes future business columns. Existing BEFORE timestamp normalization means an SQL no-op may produce a genuinely timestamp-only final row and is correctly filtered by the same rule.

No historical audit record was removed or relabeled. Every one of 23 business columns, future JSON fields, NULL timestamp transitions, identical final rows, other tables, INSERT/DELETE and the real draft-shift workflow passed restored rollback regressions. Hosted lint/metadata, source/ACL/attachment drift refusals and exact release/forward recovery rehearsals passed. Immediate installed audit count 313,694 and shift count 64,629 were unchanged. Exact release SHA-256 `fd8c4b1ce0a7e23a0212e7875fa6d28051522f6827d84384a8da294db4503eac`; separately reserved recovery `20261019233511`. Recovery remains unapplied. This suppresses only future timestamp-only shift churn; it does not claim a measured organic post-release storage reduction or alter operational audit events.

## Audit partitioning and preservation design

Live catalog facts: `private.audit_events` is a regular table, has `PRIMARY KEY(id)`, and currently has zero incoming or outgoing foreign keys. An audit FK blocker was **not** found. The genuine design constraints are the existing global ID/reader contract, continuous writes, historical availability, and preservation of the complete rows.

PostgreSQL 17 does not convert a regular table directly into a partitioned table. A partitioned unique/primary key must include the partition key, so monthly `occurred_at` partitioning cannot simply retain the existing `PRIMARY KEY(id)` contract. These constraints are documented in [PostgreSQL 17 partitioning](https://www.postgresql.org/docs/17/ddl-partitioning.html).

The safe next implementation is a restored isolated rehearsal: inventory every audit reader/cursor and direct writer; compare a time-partitioned shadow design with an ID-range design preserving the single-column key; preserve a unique global identifier through an explicitly reviewed registry/ledger if time partitioning is selected; copy and verify historical records by ordered checksums, IDs, counts, timestamp bounds, and JSON equality; then rehearse concurrent capture and a bounded switch. Keep the original table and restore path until all reader, privilege, and reconciliation gates pass. Precreate future partitions and test missing-partition failure behavior. Never silently detach history from the canonical audit reader or drop an archive partition.

Partitioning alone does not prove that queries improve or storage decreases. First measure actual audit query predicates and plans; a time-correlated BRIN or targeted B-tree may be a smaller independently testable improvement. [PostgreSQL 17 index types](https://www.postgresql.org/docs/17/indexes-types.html) describes the relevant index properties. No index was selected solely from table size in this review.

Production partition deployment remains unprepared until the global-ID/read contract, concurrent-write migration, backup restore, and no-history-loss rehearsal are proven. No retention duration or historical deletion was invented.

## Minute-level job retention and rollup design

Current aggregate evidence: 85,161 `private.timekeeping_job_runs` rows, including 1,389 created in the preceding 24 hours. The table occupies 14,729,216 total relation bytes (about 14 MiB). There are 704 distinct job runs referenced by operational exceptions. The exact incoming constraint is `timekeeping_operational_exceptions_job_run_id_fkey`: `job_run_id REFERENCES private.timekeeping_job_runs(id) ON DELETE RESTRICT`.

There are 84,456 terminal completed/skipped runs with zero action counts and no exception reference. This is a classification for a future rollup/archive design, **not authorization to delete those rows**. Do not cascade-delete exceptions, null their evidence links, or replace referenced run records with aggregate rows.

Recommended staged design: add idempotent daily rollups keyed by job/date/status containing run counts, first/last timestamps, duration aggregates, action totals, failure-signature counts, and raw-run watermark/checksum. Preserve raw failures, action-bearing runs, running rows, and every referenced run. Keep raw history intact while validating that rollup totals reconcile to the raw set. A later archive route must preserve every required raw record and its query/restore path; FK-linked runs stay addressable by their original IDs. Proposed hot-history windows and any eventual physical reclamation require a deliberate retention policy and a tested archival retrieval contract.

Any database scheduler change must use supported Cron functions rather than writing internal Cron metadata directly; see [Supabase Cron](https://supabase.com/docs/guides/cron). The existing Cloudflare scheduled pipeline must not acquire another overlapping job runner. This report creates no job and enables no cleanup.

## Remaining outcomes

- Manual review and anonymous-exposure verification are complete for the requested 35-function screen.
- Three confirmed authorization issues are repaired by installed `20261019233625`; five-group installed hosted validation and exact owner/ACL/configuration checks passed. Original findings and hashes remain preserved above.
- The shift-only timestamp audit repair is installed as `20261019232727`, with business-field/availability/preservation and exact recovery evidence retained. No historical audit row was removed.
- Audit partitioning has a real primary-key/reader-contract gate; job reclamation has a real `ON DELETE RESTRICT` evidence dependency. Both require further implementation rehearsal and preservation design rather than a destructive overnight shortcut.
- The review does not establish complete security of all baseline 661 definer functions, role bundles, Worker boundaries, or user cohorts. Preliminary authorization-before-read/lock ordering suggestions in the table remain follow-up observations, not silently completed changes. Real browser MFA/session acceptance and the separately discovered urgent-maintenance exception have their own gates and receipts.
