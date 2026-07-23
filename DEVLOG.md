# SygShift Development Log

This file is the project handoff trail. Update it whenever production behavior, database functions,
deployment status, or major workflow assumptions change.

## Current production URLs

- Primary app: https://app.sygilant.us
- Worker fallback: https://sygshift.sygilant.workers.dev
- GitHub repo: https://github.com/Jbro9204/SygShift

## Operational notes

- Supabase is the production database.
- Cloudflare Workers serves the app and Worker API.
- Supabase remote migration history contains older remote-only migration entries that are not present locally.
  Because of that, `supabase db push --linked` has previously refused to run.
- For urgent production SQL fixes, targeted migrations have been applied with:
  `pnpm dlx supabase db query --linked --file <migration-file>`
- Do not run Supabase migration repair blindly. First reconcile remote migration history or intentionally apply
  a targeted SQL file.
- Button/action layout is protected by `src/buttonLayoutGuard.test.ts`. Do not add page/card action buttons
  with only generic `.primary-action` / `.secondary-button` sizing; use a local action wrapper or a proven
  shared action container so mobile and narrow-card layouts cannot overlap.

## 2026-07-23

### Reconciled the July 26-August 1 operational schedule

- Loaded the scheduler-provided CSV for the upcoming 07/26/2026-08/01/2026 week into the live SygShift schedule.
- Published the corrected week as schedule revision 8 with 142 shifts.
- Replaced the older week data where the new CSV differed, because the scheduler sent the newer file as the source of truth.
- Added missing operational sites/posts needed by the new schedule data, including 3300 Tamarac, Stone Cliff, and Patrol-daytime PERA lunch/day-hit coverage.
- Removed stale schedule rows that were not in the new CSV week.
- Kept operational wording clean: no visible `Bible`, `Import`, or `Source` schedule notes remain in the published week.
- Preserved scheduling safeguards instead of forcing unsafe assignments. Unresolved people, missing armed credentials, and overlapping assignments were left open with plain review notes so a scheduler can resolve them intentionally.
- Added `tools/schedule-sync/reconcile_dispatch_csv.py` so this specific CSV reconciliation can be audited or rerun without hand-editing production data.

### Improved save feedback and immediate admin refresh

- Added a global progress cursor while database-backed saves are running, so users get immediate visual feedback that the system is working.
- Updated Users & Access employee create/update/enable/disable flows to refresh the open employee dialog immediately after save instead of requiring users to close and reopen it.
- Tightened the Availability form layout so date fields, repeat selectors, and save buttons stay inside the card without overlap on narrower screens.

### QA completed

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 23 files, 77 tests.
- `pnpm build` passed.

## 2026-07-22

### Hardened button layout guardrails site-wide

- Removed the mobile rule that made every `.primary-action` full-width globally, which was the recurring
  source of action buttons stretching or crowding inside cards and toolbars.
- Added shared button safeguards: bounded width, stable line-height, wrapped approval/history action rows,
  and shrink-safe action children.
- Kept intentional full-width mobile buttons targeted to standalone page-intro, data-state, route-error,
  connection-banner, and direct request-form submit actions.
- Added `src/buttonLayoutGuard.test.ts` so the build fails if the global full-width button pattern or missing
  action-row safeguards are reintroduced.

### Corrected Availability-specific action layout

- Replaced Availability's remaining generic approval action wrapper with a dedicated
  `availability-card__actions` wrapper for approve/decline controls.
- Wrapped the Availability submit action in `availability-form__actions` so it is no longer caught by generic
  direct request-form button behavior.
- Updated `src/buttonLayoutGuard.test.ts` to fail if Availability regresses back to generic action wrappers.

## 2026-07-21

### Enlarged the scheduler shift editor

- Increased the Shift Edit dialog from roughly 610px to 920px wide on desktop.
- Consolidated date, start time, end time, and headcount into one row, with employee assignment and notes
  side by side, so the complete editor and action buttons remain visible without dialog scrolling.
- Preserved a single-column responsive layout for narrow screens so fields and buttons remain usable.
- The first deployment was rolled back after QA caught missing client-side Supabase configuration.
- Verified production deploy version: `521bfff9-0983-40b0-90b9-8095a54a2ad9`.

### Preserved legacy armed assignments when opening schedule drafts

- Issue: Opening any shift for editing could fail with an armed-qualification error, including unarmed and
  dispatch shifts, because draft creation revalidated every copied assignment in the week.
- Fix: An unchanged armed assignment inherited from the prior published revision can now be copied into the
  editable draft while certificate records are still being uploaded.
- Guardrails remain in place for new armed assignments, employee changes, changed shift blocks, and armed
  shift requests; those actions still require a valid armed credential for the shift date.
- Existing Bible-derived assignments were not removed or changed.
- Applied directly to production Supabase with migration
  `20260722003300_allow_inherited_legacy_armed_assignments.sql`; no Cloudflare deployment was required.

## 2026-07-16

### Added payroll rules and salary default payroll rows

- Added centralized payroll rules in Supabase:
  - Payroll week starts Sunday at 12:00 AM and ends Saturday at 11:59 PM.
  - Pay frequency is bi-weekly with a known pay-date anchor of July 17, 2026.
  - Daily OT starts after 12 paid hours in a day.
  - Weekly OT starts after 40 paid hours in the Sunday-Saturday payroll week.
  - Breaks are unpaid with a 30-minute typical break reference.
  - Salary employees receive a 40-hour weekly payroll default.
  - Approved time off reduces salary default hours.
- Payroll review now receives and displays active payroll rules.
- Salary employees now appear as `Salary default` payroll rows instead of fake clock punches.
- Payroll export CSV now includes row type, week start/end, regular hours, overtime hours, salary default hours, time-off deductions, and payroll notes.
- The payroll review default date range now opens on the active Sunday-Saturday payroll week.
- Overtime calculations avoid double-counting by allocating daily OT first, then weekly OT on remaining non-daily-OT hours.

### Added operations time maintenance workbench

- Added a live Time Maintenance workspace inside Time & Attendance for dispatcher/scheduler/supervisor/admin roles.
- Operations users can now:
  - filter employee time by date range and employee,
  - view detailed punch events,
  - add a missing supervisor-entered punch with a required reason,
  - prefill a related punch from an existing event so missing clock-ins/outs stay attached to the same shift when available,
  - change a punch time through an approved correction,
  - void an incorrect punch through an approved correction.
- Added Supabase function support:
  - `get_time_maintenance(date, date, uuid)`
  - `supervisor_record_time_event(uuid, time_event_kind, timestamptz, uuid, text, text)`
  - `supervisor_correct_time_event(uuid, timestamptz, boolean, text)`
- Added `public.time_event_maintenance_notes` so manual time work keeps actor, reason, action, timestamp, and audit history.
- Original punch records remain append-only; maintenance actions create auditable events/corrections instead of silently rewriting history.
- Fixed Add Missing Punch form layout so the button, reason field, and optional shift-link context do not crowd or drift.
- Payroll review rows now include a direct "Review / edit time" action that filters Time Maintenance to that employee/date and scrolls to the editable records.

## 2026-07-15

### Hid legacy import tools from daily navigation

- Import Review and Operational Import were removed from the normal sidebar because the Bible import has become legacy source data, not the operating system of record.
- The underlying pages/code/data were intentionally left in place as maintenance/reference tools if a future admin cleanup requires them.
- Production navigation now points users toward the live workflows: Schedule, Scheduler, People, Sites, Time-Off Requests, Events/Openings, Announcements, Time, and Reports.

### Fixed MFA remembered-device persistence

- Issue: "Remember this device for 14 days" still required MFA after each normal logout/login.
- Root cause: the browser trusted-device token was being cleared during regular sign-out.
- Fix:
  - Normal sign-out now keeps the remembered-device token so the next login can satisfy MFA with the trusted-device record.
  - Remembered devices are still removed by expiration, the user's Remove action, or admin revoke.
  - Account Security copy now explains that signing out does not remove a remembered device.
- Note: browsers that already lost the token before this fix must complete MFA one more time and check "Remember this device" again.

### Fixed time-off approval/decline permissions

- Issue: Approving/declining time-off requests failed with `permission denied for schema private`.
- Root cause: `public.decide_time_off_request` was still running as `security invoker` while the workflow depends
  on private account lookup helpers.
- Fix: Added migration `20260715100000_fix_time_off_decision_private_schema_permissions.sql`.
- New behavior:
  - Function runs as `security definer`.
  - Actor is resolved with `private.current_employee_id()`.
  - Only MFA-verified operations roles can approve/decline.
  - Decline still requires a decision note.
  - Approved time off blocks future scheduling through existing assignment guardrails.

## 2026-07-14

### Confirmed MFA requirement for operations roles

- Verified live Supabase `get_session_context()` requires MFA for:
  - Dispatcher
  - Scheduler
  - Supervisor
  - Admin
- Guards are not forced into MFA unless the policy changes later.

## 2026-07-09

### Priority operations workflow fixes

- Added `scheduler` role across app schemas/navigation/data access.
- Confirmed scheduler/dispatcher operational access uses MFA.
- Fixed Events & Openings access by moving to a controlled database payload.
- Added credential editing for guard license and armed guard credential in Users & Access.
- Added inactivity logout:
  - Warning at 8 minutes.
  - Logout at 10 minutes.
- Improved mobile MFA setup persistence when switching apps.
- Normalized main operational date displays toward MM/DD/YYYY.
- Time-off approval no longer forces current shift resolution before approval.
- Time-off decisions optimistically clear from the request queue and restore on failure.
- Past shift requests/call-offs are filtered out of action queues.

### Scheduler draft assignment fix

- Issue: Opening a schedule draft could fail with `schedules_week_revision_unique`.
- Root cause: draft creation picked the next revision from draft/published only, ignoring superseded/archived
  revisions that still occupy the unique `(week_starts_on, revision)` key.
- Fix:
  - `ensure_schedule_draft()` now locks by week and uses `max(revision)+1` across all statuses.
  - Manual assignment can open a draft and then apply the assignment instead of appearing dead.
- Production deploy version from that fix: `969c5668-81f4-4911-9b14-1e911b052534`.

## Standard QA before saying an update is done

Run these before deploy when code changes:

```powershell
$env:Path = 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' run lint
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' test -- --run
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' run build
```

Deploy with:

```powershell
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' exec wrangler deploy --keep-vars
```
