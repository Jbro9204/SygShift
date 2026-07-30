# SygShift Change Log - 07/30/2026

## Update

SygShift Time - Phase 2 Employee My Time

## What changed

- Replaced the placeholder `/time/my-time` route with a dedicated employee-facing My Time page.
- Added a clean clock-status panel showing whether the employee is off the clock, clocked in, or on break.
- Added direct employee punch actions for:
  - Clock in
  - Start break
  - End break
  - Clock out
- Added a loading state to punch actions so employees receive immediate feedback while the server records the punch.
- Added automatic refresh behavior after punch saves so the My Time page, Time Command Center, and related review queries update without closing and reopening screens.
- Added assigned-shift selection when the employee is off the clock.
- Preserved unscheduled clock-in behavior for cases where no eligible shift is available, with clear supervisor-review language.
- Added the employee current pay-period summary:
  - Today
  - This Week
  - Pay Period
  - Corrections
- Added recent punch history using official server-backed time values.
- Added correction-request visibility so employees can see whether correction items are pending.
- Added a pay-period timecard list for the employee's own time rows.
- Kept advanced/supervisor tools under `/time/tools` instead of overcrowding the employee page.
- Added responsive layout styling for desktop, tablet, and phone screen widths.

## Existing functionality protected

- No database migration was required.
- Existing punches, active clock-ins, corrections, salary defaults, payroll review rows, and export history were not changed.
- Existing supervisor/admin Time tools remain available at `/time/tools`.
- Existing Time Command Center remains available at `/time`.

## QA completed

- TypeScript type-check passed.
- Lint passed with denied warnings.
- Automated tests passed: 112 tests across 29 test files.
- Production build passed.

## Notes

- This completes Phase 2 of the Time & Attendance rebuild roadmap.
- The next planned phase is Phase 3: Supervisor / Scheduler Team Time.
