# SygShift Critical Production Hardening Run — 07/17/2026

## Scope

This run addressed the 12-item critical task list covering availability, scheduler usability, sites/posts permissions, time-off approval access, announcement publishing, timekeeping review, dashboard counters, and production-facing import language cleanup.

## Implemented

- Added database-backed employee availability management with guard submission, operations entry, approval/decline workflow, role checks, RLS, and audit trigger.
- Added the new `/availability` route and sidebar entry.
- Connected approved availability to scheduler staffing suggestions:
  - approved unavailable records block suggestions;
  - approved available records improve suggestion priority and labels.
- Fixed Sites & Posts by moving reads behind `public.get_sites_payload()` instead of direct frontend table reads.
- Reworked dashboard counters behind `public.get_overview_metrics_payload()`:
  - On Duty = active clocked-in employees from the latest non-voided time event within the active window;
  - Open Shifts = published open shifts whose end time is still in the future.
- Updated the dashboard Open Shifts counter after review so it only counts active published openings starting within the next 14 days instead of all future openings.
- Hardened schedule draft editing:
  - scheduler role included in eligible scheduling employees;
  - old active assignments are cleared before editing/reassigning a draft block to prevent self-overlap errors;
  - “leave open/unassigned” now actually clears active assignments.
- Limited Scheduler work board to current/future scheduling dates while preserving history.
- Added sticky schedule day/date headers.
- Fixed announcement publish validation by returning/tolerating `templateKey` consistently.
- Removed the Welcome-to-SygShift template from the Announcements composer while leaving the Users welcome email workflow intact.
- Removed direct app routes for obsolete import review and operational import screens.
- Replaced production-facing import/Bible wording in active UI copy with operational terms.
- Improved timekeeping review date display to US `MM/DD/YYYY` format.
- Tightened time maintenance layout and scheduler/time review action styling.

## Documented For Later — Not Implemented

- Credential expiration reminders.
- Scheduling block for expired credentials.
- Denver Guard Card requirement logic.

## Verification

- Supabase migration applied successfully to the linked SygShift project.
- Follow-up Supabase migration applied successfully for the two-week dashboard Open Shifts window.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 22 test files, 72 tests.
- `pnpm build` passed.
- Cloudflare deployment succeeded.
- Live smoke check returned HTTP 200 for `https://app.sygilant.us/login`.

## Remaining Decisions / Watch Items

- Scheduler access to credentials should remain limited. This run did not grant Schedulers broad Users & Access permissions.
- The existing time-correction system supports correction requests against existing punches and supervisor/admin review. A fully separate “missing punch request with no existing event” workflow is a future enhancement if the company wants employees, not supervisors, to initiate completely new punch records.
- Backend/internal import metadata remains in the repository and database for traceability; production-facing routes and visible wording were removed or replaced.
