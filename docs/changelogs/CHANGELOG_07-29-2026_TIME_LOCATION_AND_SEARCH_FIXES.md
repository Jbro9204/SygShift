# SygShift Changelog — 07/29/2026

## Update focus

This update fixed immediate Time & Attendance and scheduling usability issues while keeping the Accountability Tracker planning language simple and easy to explain as the workflow is developed.

## Completed

- Cleaned up the guard search field styling so it no longer appears like a box inside another box.
- Reworked the punch correction editor layout so the New Date and New Time fields stay aligned, readable, and contained.
- Added a dedicated Fix Location workflow for employee punches.
- Added a permanent database-backed location maintenance record for punches that were showing as Unscheduled Location.
- Preserved audit integrity by keeping original punch records append-only and recording location corrections as maintenance overrides.
- Updated Time Maintenance so corrected punch locations appear after save and refresh.
- Updated Time Review / payroll review data so corrected punch locations are available in review/export workflows.
- Added a new `location_update` maintenance action so location changes show as part of the punch maintenance history.

## Database changes

- Added `public.time_event_location_overrides`.
- Added `public.supervisor_update_time_event_location(...)`.
- Updated `public.get_time_maintenance(...)` to read the latest location override.
- Updated `public.get_timekeeping_review(...)` to use corrected locations in review output.
- Marked migration `20260729184500` as applied in Supabase after applying it directly.

## QA completed

- TypeScript check passed.
- Lint passed.
- Full test suite passed: 28 files, 104 tests.
- Production build passed.

## Notes

- The original punch row is not overwritten. This is intentional. SygShift keeps the original punch for audit history and layers the supervisor/admin-approved location correction on top.
