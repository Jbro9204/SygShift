# Call-Off Alert Lifecycle and Automatic Retirement

Date: 10/05/2026
Status: Released to production

## Outcome

Call-off alerts, notifications, and coverage work now have one authoritative
lifecycle. Operations sees a call-off only while action is still required.
Covered, canceled, no-replacement, patrol-completed, duplicate, and expired
call-offs leave the live queue together while their original records and audit
history remain available for review.

An unresolved coverage window now retires automatically one hour after the
scheduled shift ends. Reading a notification does not resolve the operational
record, and acknowledging an alert does not replace an explicit lifecycle
decision.

## Behavior

- Added explicit terminal outcomes for covered, no replacement, replacement
  not required, patrol completed, canceled, shift ended unfilled, and legacy
  resolved records.
- Retires the linked operational alert, actionable employee notifications,
  email and push delivery work, supervisor outbox work, coverage waves,
  announcements, pending shift requests, and unassigned generated coverage
  shifts in the same database transaction.
- Preserves call-off reports, actions, alerts, notifications, coverage cases,
  schedule history, and delivery history instead of deleting them.
- Keeps future and grace-period call-offs live through scheduled shift end plus
  one hour, using stored UTC timestamps and the shift's authoritative timezone
  for schedule semantics.
- Supports a deliberate pre-cutoff `replacement needed` reopen with a fresh,
  generation-specific alert and delivery set while retaining prior resolved
  rows as history. Post-cutoff and terminal reopens fail closed.
- Makes Request Center and Time Operations fail closed for stale deep links and
  labels the active list **Current sick and call-off records**.
- Prevents raw browser writes from recreating terminal call-off reports or
  linked shift requests; the supported submit, withdraw, decision, resolution,
  and reclassification functions retain their authorization checks.
- Isolates scheduled timekeeping and lifecycle reconciliation failures so one
  job cannot silently prevent later Patrol and notification processors from
  running.

## Production data reconciliation

Migration `20261005123949` was applied as one targeted transaction with its
matching migration-ledger row. A broad migration push was intentionally not
used because the hosted ledger contains an already-documented semantic version
substitution from the 09/30 release.

Immediately before release, production had:

- 15 call-off reports and 22 call-off history actions;
- 8 active call-off alerts, all past their live window;
- 59 past-cutoff actionable call-off notifications;
- 9 past-cutoff unresolved canonical reports; and
- 2 stale Patrol-review coverage cases.

Immediately after release:

- active past-cutoff call-off alerts: **8 to 0**;
- actionable past-cutoff call-off notifications: **59 to 0**;
- unresolved replacement-needed canonical reports past cutoff: **0**;
- stale Patrol-review cases: **2 to 0**;
- pending call-off supervisor outbox and email work: **0**;
- call-off reports remained **15** and append-only actions increased from
  **22 to 31**; and
- every snapshotted report, alert, notification, and linked coverage record
  remained present.

The release overlapped a normal user-created publication of schedule revision
15 and working draft revision 16 for the week of 10/04/2026. Those two
revisions account for the contemporaneous schedule/assignment count increase;
the lifecycle migration contains no shift or assignment inserts and did not
create those revisions.

## Verification

- Exact migration SHA-256:
  `66dd762b1d188bd67b19833ff3ef45f089fcf16d410186ea5fda10a0f5fb95d7`.
- The migration and regression ran against the linked production schema inside
  one `BEGIN ... ROLLBACK` transaction before release.
- The exact migration-plus-ledger apply path then passed a second rollback-only
  dry run listing only `20261005123949`.
- The installed rollback-only SQL lifecycle regression passed after release.
- Two consecutive production full reconciliations completed with every
  call-off mutation counter at zero.
- All seven lifecycle triggers are enabled; direct authenticated `INSERT` and
  `UPDATE` are revoked on `call_off_reports` and `shift_requests`; private
  helpers are not browser-executable; service wrappers remain service-only;
  and every new security-definer function fixes `search_path` to empty.
- Focused application coverage: **9 files / 101 tests passed**.
- Full `pnpm check`: **357 files passed, 1 skipped; 1,949 tests passed,
  1 skipped**; strict TypeScript, zero-warning application/Worker lint,
  production build, and static-asset contract passed.
- Mandatory actual-component Time Clock matrix: **42/42 passed** across desktop
  Chromium and Pixel 7 mobile Chromium.
- Both production origins passed root, login, health, and readiness checks;
  every readiness binding reported ready. The live application entry bundle
  exactly matched the fresh local production build at SHA-256
  `120581d01ee232032b258ed1e8606d7cc7bbf4169e7cf792d74c084071977fca`.
- Authenticated production acceptance opened **Time Operations** and confirmed
  **Current sick and call-off records — Clear** with **No active call-offs in
  this range**. The page produced no browser-console errors.
- Database lint reported no finding in the new lifecycle functions. Existing
  unrelated HR workflow lint findings remain outside this release.

## Files

- Forward migration:
  `supabase/migrations/20261005123949_call_off_alert_lifecycle_retirement.sql`
- Rollback-only database regression:
  `supabase/tests/call_off_lifecycle_regression.sql`
- Static lifecycle guard:
  `src/calloffLifecycleRetirementGuard.test.ts`
- Application and Worker behavior:
  `src/components/AppShell.tsx`, `src/data/requests.ts`,
  `src/data/timeOperations.ts`, `src/pages/RequestsPage.tsx`,
  `src/time/TimeOperationsPage.tsx`, and `worker/index.ts`

## Release references

- Database migration: `20261005123949`
- Implementation commit: `2341dbe`
- Cloudflare Worker version: `4b9add8f-a9cd-4100-857a-e921de6f63c1`
- Rollback tag: `rollback/pre-call-off-alert-lifecycle-20261005`

The rollback tag restores application source only. The database change is
forward-only; any database correction must be a new migration.
