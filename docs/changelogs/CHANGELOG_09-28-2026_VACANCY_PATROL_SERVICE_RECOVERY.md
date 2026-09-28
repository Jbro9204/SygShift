# Vacancy Patrol Service Recovery

Date: 09/28/2026
Status: Release candidate; production migration, deployment, and postflight evidence pending

## Outcome

SygShift now has a separate service-recovery workflow for a regular published
Schedule shift that remains open and fully unassigned. An authorized scheduler
can request a bounded Patrol visit plan, Patrol management can accept the plan
and assign a qualified employee, and Finance can review the fully reconciled
service before recording its billing disposition.

This workflow does not turn a staffing vacancy into an employee absence. It
does not create a call-off, attendance occurrence, time entry, regular shift
assignment, invoice, or automatic client charge. The original published shift
remains intact and visibly open while its linked Patrol service is tracked as a
separate, auditable record.

## Schedule request workflow

- Added **Resolve vacancy** and **Send to Patrol** actions for eligible regular
  post shifts on a published schedule. The action is limited to an open shift
  with no operational assignment, no call-off/coverage record, and service time
  that has not ended according to trusted server time.
- Added a focused request dialog that shows the published shift, Site/Post,
  authoritative time zone, armed requirement, and eligible active Patrol
  routes without loading the broader Patrol administration workspace.
- The requester chooses a preferred route, one or more non-overlapping visit
  windows inside the original shift, the planned hits for each window, and a
  required operational/billing note. The database bounds a request to 1–24
  windows, 1–25 hits per window, and 50 planned hits in total.
- Armed vacancies expose only armed-capable routes. The selected route must
  retain a current version and active requirements for the service day.
- An explicit acknowledgment confirms that the request does not assign a
  Patrol employee, report an absence, change attendance, or approve billing.
- Each vacancy can have only one durable recovery request. Stable request
  numbers, versioned hit-window plans, and Schedule-card markers retain the
  stages **Patrol review**, **Patrol planned**, **Patrol partial**,
  **Patrol completed**, **Finance reviewed**, **Patrol declined**, and
  **Patrol canceled** across refreshes.

## Patrol acceptance, assignment, and hits

- Added a permission-scoped **Vacancy Recovery** workspace under Patrol with a
  bounded date range, status totals, search, pagination, request detail, and
  complete decision history.
- Patrol management reviews the original shift, requested route and windows,
  then selects the accepted current route and an active employee authorized to
  complete Patrol hits. Armed work additionally requires an active armed
  credential for the route-local service date.
- Acceptance rechecks that the source shift is still active, published,
  unassigned, and outside the established call-off/attendance workflow. If
  ordinary coverage or an absence record has appeared, acceptance fails closed
  instead of creating parallel work.
- Acceptance creates a distinct Patrol assignment and genuine required-hit
  obligations linked to the recovery windows. It does not create a regular
  `shift_assignments` row, so the original staffing vacancy is not presented as
  filled by a Patrol visit plan.
- The assigned employee receives the existing My Patrol work and completion
  controls. Required-hit progress drives the recovery from planned to partial
  and then completed only when every planned obligation is reconciled as either
  completed or explicitly missed. Completed-hit and missed-hit totals remain
  separate throughout the operational and Finance records.
- Managers can decline a pending request, cancel eligible recovery work with a
  reason, and reconcile Patrol obligation state. Pre-acceptance plan revisions
  preserve superseded versions instead of rewriting prior evidence.

## Finance review, report, and export

- Added **Vacancy Patrol Coverage & Billing** to the protected Reports library.
  It links the original shift and scheduled hours to the requested/accepted
  route, assigned Patrol employee, planned/completed/missed hits, service
  status, request/acceptance actors, and Finance review evidence.
- Added date, recovery-status, billing-disposition, and text filters; summary
  totals; compact pagination; and read-only detail for incomplete work.
- Finance cannot record a final disposition until every planned Patrol
  obligation is reconciled as completed or explicitly missed. The report keeps
  completed, missed, and remaining totals distinct so a missed visit is never
  represented as delivered service. The review form has no preselected billing
  outcome: a reviewer must deliberately choose **Bill Patrol separately**,
  **Included in contract**, **Non-billable**, or **Duplicate billing
  suppressed** and enter a reason of 5–1,000 characters.
- Separately billed service requires a normalized, unique invoice/work-order
  reference of 3–120 characters. Reusing that reference for another recovery
  is rejected to reduce duplicate-billing risk.
- A billing disposition is classification and evidence only. It never creates
  an invoice or charge, and it can be updated later only through the same
  protected, audited review path.
- CSV, Excel, and PDF downloads require a separate server authorization that
  appends an export audit event before the browser generates the file. CSV
  fields neutralize spreadsheet formulas, Excel uses the established formatted
  workbook path with the exported-row count and all server summary aggregates,
  PDF generation uses the compatibility-safe report layout, and attached
  temporary download anchors preserve browser/mobile download reliability.

## Security, audit, notifications, and retry safety

- Added MFA-sensitive permissions for requesting recovery, viewing Finance
  records, reviewing billing, and exporting Finance records. Schedule request
  access is assigned to the existing Dispatcher, Scheduler, and Admin roles;
  Finance permissions follow existing authorized payroll/Finance roles and
  Admin. Patrol acceptance continues to require the existing focused
  `patrol.assignments.manage` permission.
- Added RLS-enabled and forced-RLS request, hit-window, and status-history
  tables. Direct table access remains revoked from public, anonymous, and
  authenticated clients; narrowly granted authenticated RPCs perform their own
  current-employee, effective-permission, and MFA checks.
- Every security-definer function uses an empty controlled `search_path`.
  Private helper execution remains revoked from browser roles.
- Request, plan, acceptance, lifecycle, completion, billing-review, and export
  actions append protected audit evidence. Recovery status history is retained
  separately, database bigint audit identifiers remain numeric in the browser
  contract, and prior visit-plan versions are superseded rather than deleted.
- Request creation, manager actions, acceptance, and Finance decisions require
  idempotency keys. Matching retries return the original receipt; reusing a key
  with different inputs is rejected. A unique source-shift constraint prevents
  duplicate recovery requests, and deterministic notification keys prevent
  repeated recipient alerts.
- Notifications route the request to authorized Patrol assignment managers,
  acceptance to the requester and assigned employee, completion to the
  requester and authorized Finance viewers, and the Finance disposition back
  to the requester and accepting manager. Declines and cancellations return a
  documented outcome to the requester.
- Migration assertions preserve existing shifts, regular shift assignments,
  call-offs, attendance occurrences, and time events. No existing operational
  row is rewritten or backfilled by installation.

## Database and implementation boundary

- Forward-only migration:
  `20260928021235_vacancy_patrol_service_recovery.sql`
- New durable records:
  - `vacancy_patrol_recovery_requests`
  - `vacancy_patrol_recovery_hit_windows`
  - `vacancy_patrol_recovery_status_history`
- Existing `patrol_hit_obligations` records now identify ordinary route-plan
  work versus vacancy-recovery work and can retain the exact recovery window.
- The existing Patrol workspace admits an assignment manager without granting
  broader route-management authority.

## Verification

Release evidence must replace every pending item below before this changelog is
marked **Released to production**.

- **Focused application coverage:** [PENDING — record files, tests, and exact
  Schedule request, Patrol acceptance, completed/missed/remaining obligation
  reconciliation, Finance review, permission-denial, export, and
  idempotent-retry cases.]
- **Full repository gate:** [PENDING — record `pnpm check` result, test-file and
  test totals, strict TypeScript, zero-warning lint, Worker build, client build,
  and static-asset contract.]
- **Mandatory Time Clock preservation:** [PENDING — record the actual-component
  desktop/mobile matrix result after the final application changes.]
- **Database rehearsal:** [PENDING — record independent migration review,
  isolated linked-project dry-run selection, complete rollback-only lifecycle
  result including mixed completed/missed obligations and Finance readiness,
  permission allow/deny checks, idempotent replay checks, and verified rollback
  with no fixture residue.]
- **Preservation evidence:** [PENDING — record before/after counts or assertions
  for shifts, shift assignments, call-offs, attendance occurrences, time
  events, Patrol history, permissions, and audit records.]
- **Rendered workflow QA:** [PENDING — record wide desktop, laptop, phone,
  keyboard/zoom, light/dark, accessibility, loading, empty, error, denied,
  success, duplicate-request, and long-content checks for Schedule, Patrol, and
  Reports.]
- **Finance/export focused QA:** explicit-disposition, incomplete-work read-only,
  validation-boundary, authorization-before-download, formula-neutralization,
  download-anchor, summary-metadata, and 21-column workbook-alignment
  regressions are implemented. A three-page stress PDF was rendered and
  reviewed with aligned repeated headers, columns, rows, and footers. [PENDING
  — record the final focused file/test totals, Excel open/review, filtered-row
  reconciliation, and export-audit receipt results.]

## Production release references

- Production migration ledger: [PENDING — confirm migration `20260928021235`
  is the only intended pending migration and record it as applied.]
- Source commit: [PENDING]
- Cloudflare Worker version: [PENDING]
- Rollback tag: [PENDING]
- Primary and fallback health/readiness: [PENDING]
- Live route checks for `/schedule`, `/patrol/recovery`, and
  `/reports/vacancyPatrolFinance`: [PENDING]
- Verified deployed application/Schedule/Patrol/Reports asset names and
  SHA-256 hashes: [PENDING]
- Authenticated production ceremony or rollback-only equivalent: [PENDING —
  record request, duplicate denial/replay, acceptance, assigned My Patrol hits,
  separate completed/missed reconciliation, Finance disposition, export audit,
  permission denials, and cleanup without modifying a real employee's
  operational history.]
- Desktop archive copy:
  `C:\Users\Jordan\Desktop\SygShift Changelogs\CHANGELOG_09-28-2026_VACANCY_PATROL_SERVICE_RECOVERY.md`
  [PENDING — intentionally not copied until the release record is final.]

## Rollback and operator notes

The migration is additive and forward-only. If application rollback is needed,
deploy the preceding Worker/Git revision while retaining recovery, Patrol hit,
billing-disposition, notification, and audit history. Correct any database
defect with a new forward migration; do not remove the installed records or
edit the applied migration.

Patrol recovery supplements service for a vacancy; it does not staff the
original scheduled post. Operations must continue to treat that shift as open
until ordinary qualified coverage is assigned. Finance must still review every
completed recovery, and any external invoice or client communication remains a
separate authorized business process.
