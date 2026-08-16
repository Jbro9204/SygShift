# SygShift Change Log — 08/16/2026

## Daily Attendance Reconciliation

SygShift now has a controlled next-morning attendance review workflow. The published schedule remains the permanent record of what was planned, while actual punches, call-offs, coverage changes, and authorized review decisions document what occurred.

### What changed

- Added **Daily Attendance Review** under Time & Attendance.
- Added a two-hour post-shift grace period so active or recently ended shifts are not flagged prematurely.
- Compares each ended published shift with:
  - published headcount and assignments;
  - effective SygShift punches, including approved corrections and Site/Post changes;
  - actual employees who worked;
  - multiple work segments and unpaid gaps;
  - call-offs, sick reports, and no-call/no-show records.
- Flags operational differences such as missing recorded time, planned or actual understaffing, replacement workers, schedule-versus-worked variance, call-offs, and incomplete punch sequences.
- Added a large review dialog that shows the published plan and actual record side by side.
- Added a direct **Correct time** path from the review dialog into Time Maintenance.
- Added audited outcomes for replacement coverage, confirmed call-off, uncovered work, legitimate variance, and an incorrectly generated finding.
- Requires an explanatory note for every approval, dismissal, or reopened review.
- Requires an explicit client-credit decision when work is confirmed as uncovered.

### Data integrity and payroll controls

- Published schedules are never rewritten by the review workflow.
- Original punches are never deleted or changed by an attendance decision.
- Decisions are append-only and tied to the exact schedule, punch, and call-off snapshot through a fingerprint.
- If the source schedule, time record, or call-off record later changes, the previous decision no longer clears the new occurrence and the shift returns for review.
- Incomplete or impossible punch sequences remain hard payroll blockers and must be corrected through Time Maintenance.
- Multiple legitimate work segments remain separate, and the time between clock-out and clock-in remains an unpaid gap unless a separate authorized payroll action changes it.

### Access control

- Viewing requires MFA and an effective Accountability, Team Time, Payroll, or Time Exceptions permission.
- Recording attendance decisions requires MFA and either `accountability.manage` or `time.manage`.
- Permission checks are enforced in the production database, not only in the interface.
- Every decision records the reviewer, timestamp, action, client-impact status, reason, and source snapshot.

### Database and deployment

- Added `public.attendance_reconciliation_decisions`.
- Added `private.get_attendance_reconciliation_snapshot(uuid)`.
- Added `public.get_daily_attendance_review(date, date, boolean)`.
- Added `public.resolve_daily_attendance_review(uuid, text, text, text, text)`.
- Applied production migrations:
  - `20260816120000_daily_attendance_reconciliation.sql`
  - `20260816123000_daily_attendance_review_permission_alignment.sql`
  - `20260816124500_daily_attendance_resolution_grace_guard.sql`
- Deployed Cloudflare Worker version `00118503-b231-46fd-aea4-8ba789fbf2dc`.
- Production URL: https://app.sygilant.us/time/daily-review

### Verification

- Production database objects and permission alignment verified.
- A live published-shift snapshot returned a valid 64-character occurrence fingerprint and structured scheduled-employee, actual-employee, and discrepancy arrays.
- Focused attendance reconciliation tests passed: 10 tests.
- Full validation passed: type checking, lint, 45 test files / 217 tests, and production build.
- Production `/api/v1/health` and `/api/v1/ready` checks passed.
- Public authentication gate loaded without browser console errors.
