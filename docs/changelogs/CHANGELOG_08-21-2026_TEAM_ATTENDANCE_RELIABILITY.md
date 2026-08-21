# Team Attendance Reliability Repair

Date: 08/21/2026

## Reported issue

The Team Attendance employee list could fail to load and display an incorrect message stating that MFA was required, even when the signed-in Scheduler or administrator had already completed MFA.

## Root cause

The Team Attendance overview waited for the full payroll exception engine to process the entire pay period before showing the employee list. As timekeeping history grew, that payroll-grade review could exceed the request limit. The client then replaced every database failure—including a timeout—with the same MFA message, hiding the real cause.

## Changes completed

- Separated the Team Attendance overview from the full payroll exception workflow.
- Added a protected, set-based database function for worked time, breaks, overtime, worked segments, and pending correction totals.
- Preserved MFA and effective-permission enforcement for team time data.
- Preserved approved time corrections, voided-event handling, overnight punch pairing, daily overtime, and weekly overtime calculations.
- Kept detailed time maintenance available after an authorized user opens an employee.
- Replaced the misleading fixed MFA error with the actual database or authorization message.
- Added regression tests that prevent the employee list from being coupled to the payroll-grade review pipeline again.

## Verification

- The protected two-week production query was tested under a Scheduler account with verified MFA and returned 31 employee summaries successfully.
- The measured command completed in under two seconds, including client startup time.
- Application quality suite passed: 53 test files and 283 tests.
- Type checking, linting, and the production build passed.
- The production database migration applied successfully.

## Operational result

Authorized users can open Team Attendance without waiting for the full payroll exception engine. The employee overview loads from dedicated operational totals, while payroll-grade review remains available in its proper exception and payroll workflows.
