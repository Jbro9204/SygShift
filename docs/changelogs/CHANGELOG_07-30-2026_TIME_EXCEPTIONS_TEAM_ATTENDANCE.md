# SygShift Changelog — 07/30/2026 — Time Exceptions and Team Attendance

## Purpose

Finish the operational timekeeping pieces needed before payroll: live team attendance, exception review, punch correction, Site/Post correction, and payroll-period accuracy.

## Completed

- Added a real Team Attendance workspace at `/time/team`.
  - Admins, supervisors, schedulers, dispatchers, and any role with team-time permission can review who is clocked in, on break, missing review, or carrying pending corrections.
  - Managers can open an employee directly into time maintenance from the team view.
  - Guards and hourly employees still only see their own allowed time information.

- Added a real Exceptions workspace at `/time/exceptions`.
  - Exceptions now have their own focused page instead of being buried inside the old time screen.
  - The page separates missing punches, invalid punch sequences, unscheduled time, zero-paid events, and pending employee correction requests.
  - Managers can approve or deny employee correction requests from this area.

- Expanded Time Maintenance into the official correction workbench.
  - Managers can add missing punches.
  - Managers can adjust existing punch times.
  - Managers can void incorrect punch records without deleting history.
  - Managers can now correct the Site/Post for a punch instead of leaving it stuck as “Unscheduled Location.”

- Added controlled Site/Post correction.
  - Correction uses actual available Sites/Posts from the schedule database.
  - An “Other / manual label only” option remains available for unusual cases, but the normal workflow is selected from real site/post records.
  - Every Site/Post correction is saved through an append-only override record so the original punch history remains intact.

- Fixed payroll period anchoring.
  - Payroll is anchored to the 07/31/2026 pay date.
  - The last completed payroll period is 07/12/2026–07/25/2026.
  - The current open payroll period is 07/26/2026–08/08/2026.
  - Payroll weeks remain Sunday 12:00 AM through Saturday 11:59 PM.

- Confirmed export behavior remains worked-time only.
  - Payroll export does not report scheduled hours.
  - Payroll export only includes actual clock-in/clock-out time recorded in SygShift.
  - Salary defaults are not exported as worked time unless actual time events exist.

## Database Work

- Added migration `20260730223000_time_punch_site_post_corrections.sql`.
- Added `public.time_event_shift_overrides` for append-only Site/Post corrections.
- Added `public.get_time_maintenance_shift_options(...)`.
- Added `public.supervisor_update_time_event_site_post(...)`.
- Updated maintenance and review RPCs so corrected Site/Post data appears immediately in the timekeeping UI.
- Applied and repaired migration history against the linked Supabase project.

## QA Completed

- TypeScript check passed.
- Lint passed.
- Automated test suite passed.
- Production build passed.
- Live database function and payroll-rule validation passed.

## Operational Notes

- The old placeholder routes for Team Attendance and Exceptions have been replaced with functional pages.
- Time Maintenance is now the central place to fix payroll-impacting punch issues.
- The system preserves original records and layers corrections on top, which is safer for payroll audit history.
