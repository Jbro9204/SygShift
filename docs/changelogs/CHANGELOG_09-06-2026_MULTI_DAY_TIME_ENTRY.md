# Multi-Day Time Entry Workflow Repair

**Released:** September 6, 2026

## What was fixed

- Corrected the supervisor time-entry workflow that forced an operator to close and reopen an employee time card before moving to another workday.
- Removed the dead end where selecting a scheduled shift locked the Workday field while the Site/Post choices remained limited to that same workday.
- Made Workday directly editable even after a scheduled shift has been selected.
- Changing Workday now clears the prior shift, Site/Post, manual-location, linked-context, success, and stale mutation state before loading the choices for the newly selected day.
- The Punch date follows an explicitly selected new Workday by default. Selecting an overnight scheduled shift still applies its correct next-calendar-day clock-out recommendation, preserving the required distinction between workday ownership and punch time.
- Added compact **Previous**, **Next**, and post-save **Add next workday** controls so an operator can process consecutive days without leaving the employee time card.
- Preserved the selected employee, time-card date range, automatic clock-out safeguards, original punch evidence, correction history, and payroll workday rules.

## Verification

- Added date-boundary tests for forward and backward workday navigation without local-time-zone drift.
- Added regression guards proving Workday is no longer disabled by a linked shift and that stale occurrence state is cleared when the day changes.
- Updated the rendered Time Maintenance layout scenario to cover Previous, Next, and Add next workday controls on desktop and mobile.
- Focused unit, type, zero-warning lint, and two desktop/mobile Playwright checks passed.
- Full release validation and production deployment are recorded below after completion.

