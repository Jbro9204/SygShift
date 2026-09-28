# Time Off Workspace Rebuild

Date: 09/28/2026
Status: Released to production

## Outcome

SygShift now has one dedicated **Time Off** workspace for requesting planned
time away, reviewing decisions, and retaining complete request history. Shift
requests and urgent call-offs remain available as clearly separated workstreams
instead of being mixed into the planned-leave queue.

Existing time-off, shift-request, and call-off records were preserved. This
release replaces the broken request-center read and decision paths; it does not
reset history or infer a leave balance, policy entitlement, payroll credit, or
protected HR leave decision.

## Employee experience

- Added **Time Off** to Workforce navigation for every active employee and made
  `/time-off` the canonical route. Existing `/requests` links remain compatible.
- Added a guided request form with plain-language request types, profile time
  zone, expected return, full-day or partial-day choices, affected published
  shifts, and an authoritative requested-time preview.
- Separated planned leave from urgent **Report Sick / Call-Off** behavior so a
  current or imminent shift reaches Dispatch instead of quietly entering a
  planned-leave queue.
- Added dedicated **Upcoming requests** and **Past and closed requests** areas.
  Pending requests can be withdrawn through a confirmation step and remain in
  permanent history.
- Request dates follow the employee's profile time zone. Partial-day previews
  use the same DST-aware server interval that will be stored, including spring
  and fall clock changes.
- Added clear loading, empty, error, retry, and completion states without
  exposing database/provider error text.

## Management experience

- Employees with effective `requests.manage` permission receive a distinct
  **Pending Time Off review** queue and searchable decision history.
- Additive roles and individual effective permissions work the same as a
  primary management role; capability and returned rows now come from one
  authoritative permission decision.
- Review detail includes employee, request type, return date, requested time,
  affected shifts, schedule-local times, reason, and prior decision evidence.
- A reviewer cannot approve their own request. The request remains visible and
  explicitly waits for another authorized reviewer.
- Approval rechecks assigned/confirmed shifts against the exact request
  interval. Old assignments from a superseded schedule revision do not block a
  valid decision, while current draft and published assignments remain
  protected.
- Manager history is bounded to the newest 100 completed team requests while
  retaining every pending team request and the viewer's complete personal
  history. The interface states when the bounded team history is in effect.

## Schedule, notifications, and audit

- Full-day, partial-day, overnight, and DST intervals share one employee-zone
  server calculation across preview, submission, approval, and assignment.
- Approved time off blocks a conflicting new schedule assignment through the
  existing schedule guard. Adjacent intervals remain valid.
- Request submission, withdrawal, approval, and decline append audit evidence
  and retain submission/decision snapshots.
- Time-off notifications now link directly to the exact record under
  `/time-off?tab=time-off&request=...`; shift requests and call-offs link to
  their own tabs.
- The release safely corrects still-actionable old request links without
  rewriting completed history or sending duplicate alerts.

## Security boundary

- Time-off writes are RPC-only for authenticated users. Direct browser insert,
  update, delete, and truncate privileges are revoked.
- Employees can read and withdraw only their own eligible request; management
  visibility requires effective `requests.manage` permission.
- Decisions require MFA, management permission, a valid pending record, and an
  independent reviewer.
- Security-definer functions use an empty controlled search path and narrow
  authenticated execution grants.
- The same employee-scoped transaction lock serializes request submission,
  approval, and schedule assignment to close approve-versus-assign races.

## Database and implementation boundary

- Forward-only migration:
  `20260928203430_rebuild_time_off_request_center.sql`
- The migration preserves the existing `time_off_requests`, `shift_requests`,
  call-off, schedule, assignment, notification, audit, and payroll records.
- No paid-time balance was invented. The existing separate management decision
  about salary/vacation payroll treatment remains outside this repair.

## Verification

- Full repository gate: strict TypeScript, zero-warning application/Worker
  lint, **332 files / 1,751 tests**, production Worker/client builds, and the
  static-asset contract passed.
- Focused Time Off component/contract coverage passed, including effective
  permission roles, employee isolation, deep links, self-review suppression,
  withdrawal, safe errors, viewer-local dates, and DST-aware preview duration.
- Rendered Time Off QA passed **6/6** at 390x844 and 320x480, including employee
  and manager workspaces, exact-record links, retry, and horizontal-overflow
  checks.
- Mandatory Time Clock preservation passed **42/42** desktop/mobile browser
  checks after the final application changes.
- The exact migration and both database regression suites ran against the
  linked production schema inside one transaction with one final rollback.
  Production returned to migration `20260928021235` with the original 2 pending
  time-off requests, 3 pending future shift requests, and 0 unresolved future
  call-offs.

## Production release references

- Source commit: `a876434`
- Production migration ledger: `20260928203430`
- Cloudflare Worker version: `2141e044-e45b-4ccb-90ea-0a8c64ddfd3e`
- Rollback tag: `rollback/pre-time-off-workspace-rebuild-20260928`
- Custom and fallback origins returned HTTP 200 for health, readiness, and
  `/time-off`; both readiness responses reported every required binding ready.
- The authenticated production workspace loaded the 2 pending Time Off
  requests, 3 pending Shift Requests, and retained decision history. Michael
  Hinz's real AAL2 request-center postflight returned management access and the
  same live pending queues.
- Exact deployed assets matched the fresh local build:
  - `index-D8ucAt-X.js` (`4205b158...0a04`)
  - `RequestsPage-DEcPPGfS.js` (`b1deefd5...8eb6`)
  - `TimeOffRequestModal-cLlbaWOk.js` (`5281350b...3fa6`)
  - `index-BF77HDfS.css` (`32efa074...3427`)
- Supabase security and performance advisors reported no error-level findings
  after installation.
- Desktop archive copy:
  `C:\Users\Jordan\Desktop\SygShift Changelogs\CHANGELOG_09-28-2026_TIME_OFF_WORKSPACE_REBUILD.md`.

## Rollback and operator notes

The database change is additive and forward-only. If the application must be
rolled back, deploy the rollback-tagged application revision while retaining
time-off, notification, and audit history. Correct any installed database issue
with a new forward migration; do not delete request history or edit an applied
migration.

Planned Time Off does not replace the call-off process. Employees who cannot
work a current or imminent assigned shift must continue to use **Report Sick /
Call-Off** so Operations receives the urgent coverage notice.
