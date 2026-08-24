# SygShift Change Log — 08/24/2026

## Payroll session integrity

- Corrected the authoritative session boundary used to pair clock-ins and clock-outs.
- A valid clock-out now closes the employee's prior chronological work session even when the punch is already linked to a scheduled shift or was linked later through Time Maintenance.
- Later clock-ins now begin a new session consistently across payroll totals, exception review, and exports.
- Existing punch records remain append-only; the repair does not edit, void, or delete employee punches.
- The reported payroll record was verified in production as one 705-minute worked segment from 10:15 AM (10:15) through 10:00 PM (22:00), with no remaining zero-paid-time exception.

## Manual punch workday controls

- Added a separate **Workday** field to the supervisor-entered time-event form.
- Site/Post choices are now loaded from the selected operational workday instead of being inferred from the punch's calendar date.
- Overnight shift choices clearly display their workday.
- Selecting a shift automatically sets a clock-in to the shift start or a clock-out to the shift end, including the following calendar day for overnight shifts.
- Supervisors can still adjust the suggested timestamp when the actual punch differs from the scheduled boundary.
- The database continues to reject a shift-linked punch whose timestamp is outside that shift, preserving payroll and audit integrity.

## Quality assurance

- Added focused tests for overnight clock-in and clock-out defaults.
- Added a migration guard that prevents the raw-shift-link condition from returning to session-boundary logic.
- Completed TypeScript, lint, unit, database, and production build checks.
- Test result: 72 test files and 362 tests passed.
