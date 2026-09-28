# Vacancy Patrol Service Recovery

Date: 09/28/2026
Status: Released to production

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
  **Patrol reconciled**, **Finance reviewed**, **Patrol declined**, and
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

- **Focused application coverage:** 10 files / 54 tests passed for Schedule
  eligibility and request creation, Patrol plan editing and acceptance,
  completed/missed/remaining reconciliation, Finance review, access denial,
  export authorization, and retry/idempotency contracts.
- **Full repository gate:** `pnpm check` passed: strict TypeScript, zero-warning
  application lint, 329 files / 1,727 tests, Worker/client production builds,
  and the static-asset contract.
- **Mandatory Time Clock preservation:** 42/42 actual-component Playwright
  checks passed across desktop and mobile Chromium after the final application
  changes, including early acknowledgment, break/resume, return-to-work,
  duplicate submission prevention, permission boundaries, and synchronization.
- **Database rehearsal:** the exact migration plus complete regression ran in
  one linked-production transaction with one `BEGIN` and one final `ROLLBACK`.
  The lifecycle passed MFA allow/deny, invalid-shift guards, stable retries,
  route scoping, real My Patrol completion, mixed completed/missed terminality,
  Finance review/export audit, and rollback with no fixture residue. The same
  regression passed again after installation.
- **Preservation evidence:** rollback assertions verified unchanged counts for
  ordinary shift assignments, call-offs, attendance occurrences, time events,
  and payroll export rows; the source published vacancy remained open and
  unassigned. Forced RLS, revoked direct table privileges, append-only history,
  permission assignment, notification routes, and audit receipts also passed.
- **Rendered workflow QA:** focused component tests cover bounded forms,
  validation, loading, empty/error, denied, success, duplicate/replay, and
  long-content behavior. Production route shells and exact deployed assets were
  verified live; the rollback-only ceremony avoided writing test records into
  real employee history.
- **Finance/export focused QA:** explicit-disposition, incomplete-work read-only,
  validation-boundary, authorization-before-download, formula-neutralization,
  download-anchor, summary-metadata, and 21-column workbook-alignment
  regressions are implemented. A three-page stress PDF was rendered and
  reviewed with aligned repeated headers, columns, rows, and footers. The final
  54-test focused gate covered Excel schema/alignment, filtered totals, download
  authorization, and export-audit receipts.

## Production release references

- Production migration ledger: `20260928021235` applied; the exact installed
  rollback-only regression passed afterward.
- Source commit: `b845808`
- Cloudflare Worker version: `e39db41d-486a-495d-9839-2d04cc6edcd6`
- Rollback tag: `rollback/pre-vacancy-patrol-service-recovery-20260928`
- Primary and fallback health/readiness: HTTP 200 from both
  `app.sygilant.us` and `sygshift.sygilant.workers.dev` health and readiness.
- Live route checks: HTTP 200 for `/schedule`, `/patrol/recovery`, and
  `/reports/vacancyPatrolFinance`.
- Verified deployed assets matched the fresh local production build exactly:
  `index-C2qG_Zom.js` (`874efc55...b1f6`),
  `SchedulePage-SQGDR9V0.js` (`918e9b2c...7c2e`),
  `PatrolPage-CqjuXtAo.js` (`3820616d...a2da`), and
  `ReportsPage-CU7ZTn5n.js` (`8d214b4c...e268`).
- Production ceremony: the linked rollback-only lifecycle exercised request,
  stable replay and duplicate protection, acceptance, assigned My Patrol hits,
  distinct completed/missed reconciliation, Finance disposition, export audit,
  and permission denials without leaving test or employee-history residue.
- Desktop archive copy:
  `C:\Users\Jordan\Desktop\SygShift Changelogs\CHANGELOG_09-28-2026_VACANCY_PATROL_SERVICE_RECOVERY.md`
  copied after the final release record was completed.

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
