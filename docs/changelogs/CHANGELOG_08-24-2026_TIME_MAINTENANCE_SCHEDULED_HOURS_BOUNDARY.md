# SygShift Time Maintenance Scheduled-Hours Boundary

Date: 08/24/2026

## Outcome

Time Maintenance now reports scheduled hours according to each shift's operational start date. Overnight work no longer adds a prior day's shift to a later date range merely because the shift ended after midnight.

## Root cause

The scheduled-hours summary used an interval-overlap rule. For the 08/09/2026 through 08/22/2026 selection, that rule included Bernard Petermon's 08/08/2026 8:00 PM through 08/09/2026 4:00 AM shift. That shift belongs to the 08/08 operational day and should not have been part of the selected range.

## Correction

- Scheduled shifts are included when their local operational start date falls within the selected inclusive range.
- Overnight shifts that begin on the final selected day remain fully assigned to that operational day.
- Overnight shifts that begin before the first selected day are excluded.
- Canceled shifts are excluded from scheduled-hour totals.
- Published-revision safeguards remain in place, so superseded schedule revisions are not counted.

## Production verification

- Old overlap rule: 9 shifts / 3,840 minutes / 64.00 hours.
- Corrected operational-date rule: 8 shifts / 3,360 minutes / 56.00 hours.
- Bernard's worked time is 56.00 hours, matching the corrected scheduled total.
- The 56 hours span two payroll weeks at 28 hours per week, so no weekly overtime warning is appropriate.
- No pending correction or payroll exception exists, so `Needs attention: 0` is correct.

## Validation

- Added regression tests for overnight start-date ownership and canceled-shift exclusion.
- Full validation passed: type checking, lint, 67 test files / 339 tests, and the production build.
- Applied targeted production migration `20260824170000_time_maintenance_operational_schedule_range.sql`.
- Verified the installed production function uses the operational start-date rule and no longer contains the prior overlap condition.
- This was a database-only correction and became live immediately without a Cloudflare Worker redeployment.
