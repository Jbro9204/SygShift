# SygShift Time Maintenance, Overnight Time, and Patrol Clarity

Date: 08/19/2026

## Outcome

Time Maintenance remains usable when new audit actions are present, employee choices are ordered by first name, overnight work remains one occurrence assigned to the payroll week in which it began, and patrol time can be assigned to the correct client/accounting Site/Post.

## Changes

- Repaired the Time Maintenance response contract so a valid operational action such as an automatic clock-out no longer causes the full employee timecard to fail validation.
- Added a readable fallback status for future audited maintenance actions instead of exposing a technical validation error.
- Ordered Time Maintenance employees by preferred/first name, then username, matching the scheduler's requested name-finding workflow.
- Added bounded session grouping for unlinked punches: an overnight clock-out is paired with its preceding clock-in after the prior completed session, within a 24-hour safety boundary.
- Preserved every original punch timestamp, source, and audit record. No punches were merged, moved, deleted, or rewritten.
- Anchored unlinked overnight payroll assignment to the session's clock-in rather than splitting the occurrence at midnight.
- Added Site Code to Time Operations Site/Post choices so similar patrol locations can be distinguished.
- Added clear guidance in manual-time forms to select the exact client/accounting Site/Post, such as PERA, MG, or Anythink, and to use a general Patrol location only when that was the actual assignment.
- Added forward-only migration `20260819123000_time_maintenance_overnight_and_patrol_clarity.sql`.

## Production Verification

- Confirmed the new database helpers and Site Code payload are active.
- Confirmed the reported 08/09/2026 10:00 PM to 08/10/2026 6:00 AM Joseph Lee punch pair remains two original events but resolves to one occurrence.
- Confirmed that occurrence is assigned to the payroll week beginning 08/09/2026.
- Confirmed employee ordering and Site Code updates are active in the production database functions.

## Quality Assurance

- Type checking passed.
- Linting passed with zero warnings.
- All 49 test files passed with 266 tests.
- Production build completed successfully.

## Production URL

https://app.sygilant.us
