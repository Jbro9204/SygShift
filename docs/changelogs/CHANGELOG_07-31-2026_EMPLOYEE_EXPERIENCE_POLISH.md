# SygShift Change Log — 07/31/2026 — Employee Experience Polish

## Summary

This update cleaned up the employee-facing experience so hourly employees see the information they actually need without operations/admin clutter.

## Completed

- Reworked the employee Schedule view into a personal schedule panel.
  - Employees now see only their own assigned shifts.
  - Added 1 week, 2 week, and month range options.
  - Added schedule search for sites, posts, shift notes, armed/unarmed, and overtime.
  - Added clean shift cards showing date, time, site/location, post, notes, and requirement.
  - Removed operations summary cards, source/import preview language, and horizontal operations board from employee-only schedule access.
- Added employee Overview announcements.
  - Employees now have an Overview card for current announcements and active coverage messages.
  - The employee landing still keeps quick clock/break, next shift, time card, and request shortcuts visible.
- Improved My Time layout.
  - Added a top-level “Report sick / call-off” action.
  - Moved the employee timecard/pay-period view above raw punch history and correction panels.
- Expanded Events & Openings cards.
  - Open opportunities now show coverage, job details, and pay/rate information when available.
  - Imported/source metadata is filtered out of employee-facing job details.
- Added responsive styling so the new employee schedule cards collapse cleanly on smaller screens.
- Added guard tests to prevent employee views from regressing into operations-heavy layouts.

## QA

- `pnpm lint` passed.
- `pnpm test` passed: 32 files, 147 tests.
- `pnpm build` passed.

## Notes

- The personal schedule filter is intentionally strict: if an employee session is not linked to an employee record, it shows no shifts instead of exposing team schedule data.
