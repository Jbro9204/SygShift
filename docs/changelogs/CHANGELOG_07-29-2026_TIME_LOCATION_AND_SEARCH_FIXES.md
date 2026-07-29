# SygShift Changelog — 07/29/2026

## Update focus

This update fixed immediate Time & Attendance and scheduling usability issues while keeping the Accountability Tracker planning language simple and easy to explain as the workflow is developed.

## Completed

- Cleaned up the guard search field styling so it no longer appears like a box inside another box.
- Added a stronger modal-specific guard search override after screenshot review confirmed the generic form-grid input styling was still creating an inner input border.
- Reworked the punch correction editor layout so the New Date and New Time fields stay aligned, readable, and contained.
- Added a dedicated Fix Location workflow for employee punches.
- Fixed multi-day shift publishing so repeated shifts are created sequentially instead of creating competing schedule revisions at the same time.
- Added a regression guard that blocks the multi-day scheduler path from being changed back to parallel revision creation.
- Added a permanent database-backed location maintenance record for punches that were showing as Unscheduled Location.
- Preserved audit integrity by keeping original punch records append-only and recording location corrections as maintenance overrides.
- Updated Time Maintenance so corrected punch locations appear after save and refresh.
- Updated Time Review / payroll review data so corrected punch locations are available in review/export workflows.
- Added a new `location_update` maintenance action so location changes show as part of the punch maintenance history.
- Fixed assigned multi-day shift retries so SygShift refreshes the current schedule first, skips dates where the selected employee is already assigned for that same time, creates only the missing dates, closes the modal, and reports which dates were skipped.
- Confirmed Zach Ward already had ADMIN shifts on 08/03/2026 and 08/04/2026 in the database; the new scheduler behavior prevents that real saved data from looking like a broken overlap error on retry.
- Fixed the root stale-draft scheduler issue where an older draft revision could hide a newer published revision in the UI.
- Archived the stale 08/02/2026 draft revision that was causing Zach Ward to show 0 visible shifts while the database correctly blocked overlapping assignments.
- Fixed the Remove from draft destructive action button so it uses the same professional SygShift button system instead of rendering as a thin raw red browser-style button.
- Made Schedule visible to every active employee role so hourly employees can always view their own schedule without needing a manually added permission.
- Updated the normal employee Schedule screen to default into a simple self-schedule view instead of showing team/site controls that do not apply to them.
- Added a regression guard for employee self-schedule access so future permission or navigation work does not accidentally hide Schedule again.
- Hardened remembered MFA for Recruiting & Licensing by keeping a secure cookie backup of the trusted-device token in addition to localStorage.
- Hardened the Supabase trusted-device request wrapper so the `x-sygshift-trusted-device` header is added without dropping existing Supabase auth headers.
- Confirmed Zach Ward has active remembered-device records in Supabase; the issue was in reliable browser token reuse, not missing database records.

## Database changes

- Added `public.time_event_location_overrides`.
- Added `public.supervisor_update_time_event_location(...)`.
- Updated `public.get_time_maintenance(...)` to read the latest location override.
- Updated `public.get_timekeeping_review(...)` to use corrected locations in review output.
- Marked migration `20260729184500` as applied in Supabase after applying it directly.
- Added migration `20260729173000_latest_schedule_revision_selection.sql`.
- Updated `public.get_weekly_schedule_payload(...)` so the latest visible schedule revision wins instead of any draft automatically overriding newer published data.
- Updated `public.ensure_schedule_draft(...)` so stale older drafts are archived before opening or creating a working draft.
- Marked migration `20260729173000` as applied in Supabase after applying it directly.
- Added migration `20260729191000_employee_self_schedule_scope.sql`.
- Updated `public.get_weekly_schedule_payload(...)` so Admin, Supervisor, Scheduler, and Dispatcher roles keep team schedule visibility while regular employees only receive shifts assigned to their own employee record.
- Removed the older unarmed-shift visibility path from normal employee schedule access so “can view my schedule” does not expose company-wide unarmed coverage.
- Marked migration `20260729191000` as applied in Supabase after applying it directly.

## QA completed

- TypeScript check passed.
- Lint passed.
- Full test suite passed: 28 files, 104 tests.
- Follow-up scheduler fix passed: 28 files, 105 tests.
- Multi-day retry fix passed: 28 files, 106 tests.
- Destructive button style fix passed: 28 files, 107 tests.
- Employee self-schedule visibility fix passed: 28 files, 108 tests.
- Remembered MFA hardening passed: 28 files, 110 tests.
- Production build passed.

## Notes

- The original punch row is not overwritten. This is intentional. SygShift keeps the original punch for audit history and layers the supervisor/admin-approved location correction on top.
