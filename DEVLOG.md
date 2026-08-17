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

## 08/17/2026

### Attendance-review performance and seven-day Schedule layout

- Fixed Daily Attendance Review date-range timeouts that could leave the missed-punch queue empty or incomplete.
- Added an optimized read-only snapshot for published schedule occurrences with no recorded activity while retaining the full reconciliation path for occurrences with punches, overrides, call-offs, or attendance events.
- Production verification for 08/09/2026 through 08/16/2026 returned 739 review rows, including 737 no-recorded-time occurrences and 35 distinct scheduled employees missing time, in approximately 4.4 seconds.
- Verified sampled optimized results exactly matched the existing detailed reconciliation output.
- Updated the desktop Schedule to fit the Site/Post column plus all seven days without horizontal scrolling, while preserving the dedicated mobile layout.
- Applied targeted production migration `20260817120000_attendance_review_missing_time_fast_path.sql`.
- Full validation passed: type checking, lint, 45 test files / 223 tests, and production build.
- Production health and readiness checks passed.
- Deployed Cloudflare Worker version `a0a18990-425b-404b-b99d-27e759dbf47b`.

## 08/16/2026

### Attendance review coverage consolidation

- Fixed Daily Attendance Review so identical published coverage slots no longer appear as repeated review cards.
- Consolidation is based on the same published schedule, Site/Post or event, start, end, time zone, and armed requirement.
- Repeated copies of the same employee assignment now remain one scheduled position instead of inflating the required headcount.
- Legitimately different employees assigned to the same coverage window remain separate people under one combined occurrence.
- The combined review preserves every underlying shift ID, employee assignment, worked segment, unpaid gap, call-off, punch, and audit record.
- Attendance decisions now resolve the canonical combined occurrence and remain protected by the current occurrence fingerprint.
- Applied targeted production migration `20260816170000_attendance_review_coverage_grouping.sql`.
- Production verification confirmed the reported MG Properties Patrol and Neon Local duplicate groups now calculate as one scheduled employee for one required position.
- Full validation passed: type checking, lint, 45 test files / 219 tests, and production build.

### Daily attendance reconciliation

- Added a next-morning review workspace that compares ended published shifts with effective SygShift punches and recorded call-offs after a two-hour grace period.
- Preserved the published schedule as the original staffing plan and preserved all original punches.
- Added planned-versus-actual employee lists, worked segments, unpaid gaps, schedule variance, call-off context, and plain-language rule explanations.
- Added controlled outcomes for replacement coverage, call-offs, uncovered work/client impact, legitimate variances, incorrect findings, and reopened reviews.
- Made review decisions append-only, audited, MFA-protected, permission-enforced, and specific to a fingerprint of the exact underlying occurrence.
- Kept incomplete or impossible punch sequences as hard correction blockers and linked authorized reviewers directly to Time Maintenance.
- Applied production migrations `20260816120000_daily_attendance_reconciliation.sql`, `20260816123000_daily_attendance_review_permission_alignment.sql`, and `20260816124500_daily_attendance_resolution_grace_guard.sql`.
- Full validation passed: 45 test files, 217 tests, type checking, lint, and production build.
- Production health and readiness checks passed.
- Deployed Cloudflare Worker version `00118503-b231-46fd-aea4-8ba789fbf2dc`.

## 08/13/2026

### Scheduled paid training

- Removed the global Post Time and Training Time setup from payroll review and removed its export gate.
- Made regular scheduled work the automatic default without requiring a payroll classification step.
- Added a Paid training time checkbox to Add Shift/Event and Edit Shift so training is identified where the schedule is created.
- Replaced visible Post Time terminology with Worked Time across employee time, exceptions, team attendance, payroll review, CSV, and Excel exports.
- Kept Paid Training separate in payroll totals and employee detail sheets while hiding empty training totals.
- Retained authorized, audited time-category correction for genuine classification mistakes.
- Applied and verified targeted production migration `20260813120000_scheduled_paid_training.sql` without changing existing shifts, punches, or payroll history.
- Full validation passed: 43 test files, 207 tests, type checking, lint, and production build.
- Production health, readiness, login route, and deployed asset verification passed.
- Deployed Cloudflare Worker version `f6410166-3c88-45cf-8ef3-2c28238ef816`.

## 08/12/2026

### Schedule name disambiguation

- Updated Schedule and Scheduler employee names so a one-character preferred name is never shown as an ambiguous initial-only identity.
- Employees with a normal preferred name continue to use it; for example, `Zachary` with preferred name `Zach` still appears as `Zach Ward`.
- Employees with a one-character preferred name now include the full first name and preference; for example, `Jainique` with preferred name `J` appears as `Jainique (J) Lee`.
- Applied the same rule to shift cards, assignment dialogs, employee selectors, staffing suggestions, and employee-specific training assignments.
- Added employee numbers to scheduling selectors and selected-assignment details as a second identity check when employees have similar names.
- Kept schedule and builder permission boundaries intact while extending the production database payloads.
- Applied and verified production migration `20260812153000_schedule_name_disambiguation.sql`.
- Full validation passed: 42 test files, 204 tests, type checking, lint, and production build.
- Deployed Cloudflare Worker version `245945a4-2071-4f5b-b57b-84e34b308263`.
- Verified production health, readiness, Schedule route delivery, and the live login surface without browser console errors.

### New User Invites permission

- Added the configurable `New User Invites` permission (`admin.users.invite`).
- Separated Welcome and Login Instructions email delivery from broad login-account management access.
- Added a dedicated onboarding-email card in each employee's Users & Access dialog.
- Added `Send new user invites` as the protected batch action for active employees who still need login accounts.
- Kept login creation, password resets, account disabling, MFA resets, and remembered-device controls under `Manage Login Access`.
- Enforced the new permission on all three Worker email routes, including individual welcome emails, individual login-instruction emails, and batch new-user invitations.
- Effective per-person denies are honored for these email routes even when the employee has an Admin app role.
- Granted the new permission to the protected system Admin role so existing Admin workflows continue after deployment.
- Updated the Users & Access directory permission boundary so custom roles or individual grants can use the invitation workflow without receiving login-security controls.
- Added regression tests for denied delivery, authorized delivery, route coverage, catalog registration, interface separation, and prevention of account-security changes by invite-only users.
- Applied and verified production migration `20260812133000_new_user_invites_permission.sql`.
- Full validation passed: 41 test files, 199 tests, type checking, lint, and production build.
- Cloudflare startup analysis passed with the current Wrangler runtime.
- Deployed Cloudflare Worker version `2fb56772-a659-4c83-bf52-83f80f03a536`.

## 07/31/2026

### Directory and Licensing Center workflow cleanup

- Widened the Directory profile modal so employee records have room to breathe on desktop while staying responsive on smaller screens.
- Removed credential/license management from the Directory profile modal.
- Kept scheduling availability inside Directory because schedulers need that information beside the employee profile.
- Replaced the old Directory credential summary with a clean profile snapshot focused on employment, role, title, contact, and schedule availability.
- Moved credential workflow ownership into Licensing Center:
  - Added an Employee List view for the licensing workflow.
  - Added a Credential List view for record-level review.
  - Added a cleaner employee licensing profile workflow where the licensing user selects one employee, selects one credential/license, and manages that item without scrolling through every credential card at once.
- Updated navigation so Directory no longer advertises credential-editing access. Licensing Center remains the credential workspace.
- Added guardrail tests to prevent credentials from being reintroduced into Directory and to protect the new Licensing Center employee/credential layout.
- Validation completed:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test` — 32 files / 143 tests passing
  - `pnpm build`
- Production deployment completed to `https://app.sygilant.us`.
- Cloudflare Worker version: `58d7a0cc-df54-4645-838a-97e86b405387`.

### Employee Overview, Break Controls, and Time-Card Correction Requests

- Reworked the Overview landing page so non-operations employees see a personal dashboard instead of company-wide operational totals.
- Employees now see simple cards for their next shift, their own time card, and time-card help.
- Operations/Admin/Supervisor/Scheduler/Dispatcher users still keep the broader operations metrics.
- Added a break action beside the time-clock action:
  - While clocked in: `Clock out` and `Start break`.
  - While on break: `End break`.
- Added employee time-card correction requests inside My Time:
  - Employees can request a correction from a recent punch or time-card row.
  - Requests preserve the original punch until reviewed.
  - Requests route into the existing pending time-correction workflow for supervisor/admin handling.
- Added UI guard coverage for employee Overview behavior, break controls, correction request wiring, and the supporting layout styles.
- Validation completed:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test` — 32 files / 142 tests passing
  - `pnpm build`
- Production deployment completed to `https://app.sygilant.us`.
- Cloudflare Worker version: `928240b6-4279-42f7-aa62-e84d7074ca2e`.

### Added employee-scoped schedule publishing

- Added a focused Scheduler workflow for publishing one employee's schedule without publishing the entire week.
- When the Scheduler is in Employee Schedule view and a specific employee is selected, SygShift now shows a
  `Publish [employee] only` action beside the normal full-week publish option.
- The scoped publish copies the selected employee's active draft assignments into a new live schedule revision
  while preserving the rest of the team's current live schedule.
- The remaining working draft is automatically rebased afterward, so other scheduler work stays in draft and is
  not accidentally pushed live.
- The normal full-week publish path remains available as `Publish full week`.
- The publish workflow now closes the employee week/full shift editing surfaces after a successful save/publish
  so users are not left inside stale windows.

### Production deployment

- Applied targeted Supabase migration: `supabase/migrations/20260731161500_employee_scoped_schedule_publish.sql`.
- Deployed Cloudflare Worker/site version `c6b8fbae-e5d3-4542-836f-f23dbdaf028a`.
- Live app: https://app.sygilant.us

### QA completed

- `pnpm vitest run src/schedulerBehaviorGuard.test.ts` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 31 files, 138 tests.
- `pnpm build` passed.

## 2026-07-27

### Added scheduler-safe shift removal

- Added a controlled “Remove duplicate/open shift” action to the Scheduler selected-shift panel.
- Added a matching “Remove from draft” action inside the full shift editor so the action is available from both scheduler workflows.
- Removal now uses a confirmation dialog with an optional note field, so schedulers can record why a block was removed.
- If a scheduler is looking at a live published schedule, SygShift opens a working draft first, removes the matching draft shift, and keeps the live schedule unchanged until the draft is published.
- Removed shifts no longer show on the Schedule/Scheduler board, no longer count in staffing suggestions, and no longer enter Events & Openings / Shift Pool.
- Pending requests attached to a removed shift are canceled, and active assignments are canceled with the removal reason.
- The database now keeps a soft-removal audit trail on shifts instead of hard-deleting operational history.

### Scheduler access/responsibility clarification prepared

- Prepared scheduler-facing guidance for Michael’s questions about duplicate shift cleanup, employee setup, contract/site setup, time editing, manual current-week schedule additions, and Denver license/armed credential ownership.
- Recommendation: Admin/Ops owns official employee setup and contract/site records; Schedulers maintain schedule coverage, assignments, open shifts, availability, and credential updates needed to schedule armed work.

### Production deployment

- Applied targeted Supabase migration: `supabase/migrations/20260727103000_scheduler_shift_removal.sql`.
- Deployed Cloudflare Worker/site version `764edcd1-bbc7-4951-a5e8-b5edfd85d0c0`.
- Verified live URL responded with HTTP 200: https://app.sygilant.us

### QA completed

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 23 files, 78 tests.
- `pnpm build` passed.

## 2026-07-23

### Added Flex employment and Directory-based availability controls

- Added `Flex` as a first-class employment type in frontend schemas, Users & Access, Directory, timekeeping, import mapping, operations metrics, Worker auth typing, and the Supabase enum.
- Moved practical availability management into the Directory profile dialog so schedulers, supervisors, and admins can manage a person’s credentials and scheduling availability from one place.
- Added a compact weekly availability snapshot to each Directory profile, plus a polished form for adding approved available/unavailable rules and removing active/pending availability rules.
- Kept the UI intentionally contained: no new sidebar clutter, no crowded card controls, and responsive styling for narrow screens.
- Added database-backed availability cancellation through `public.cancel_employee_availability`.

### Added availability override guardrails to scheduling

- Added inline availability conflict warnings when assigning an employee from the scheduler panel, full shift editor, or Add shift/event form.
- Schedulers/admins can override availability only by entering a written reason; the save button stays disabled until that reason exists.
- Added `public.schedule_assignment_overrides` so availability overrides are stored with shift, employee, note, actor, and timestamp for history/audit.
- Updated schedule assignment RPCs so the database rejects assignments against approved unavailable time unless an override note is supplied.
- Updated staffing suggestions so Flex employees are labeled and scored intentionally, while approved unavailable windows continue to exclude employees from automatic suggestions.

### Production deployment

- Applied targeted Supabase migration: `supabase/migrations/20260723143000_flex_directory_availability_overrides.sql`.
- Deployed Cloudflare Worker/site version `57d80885-0b71-4eb0-925c-f665398fa46a`.
- Verified live URL responded with HTTP 200: https://app.sygilant.us

### QA completed

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 23 files, 77 tests.
- `pnpm build` passed.

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
pnpm lint
pnpm test
pnpm build
```

Deploy with:

```powershell
pnpm exec wrangler deploy --keep-vars
```
