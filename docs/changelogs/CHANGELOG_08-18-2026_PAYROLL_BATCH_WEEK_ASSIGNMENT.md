# Payroll Batch Week Assignment Correction

Date: 08/18/2026

## Summary

SygShift now assigns each complete linked work occurrence to the payroll week containing the scheduled shift start in `America/Denver`. Payroll weeks begin Sunday at 12:00 AM and end Saturday at 11:59:59 PM. Overnight shifts are kept intact; punches are not split merely because the work crosses Sunday midnight.

## Assignment rules

- Scheduled shifts use the scheduled start, including approved corrections to the shift.
- Replacement employees inherit the parent shift's scheduled start.
- Manual entries linked to a shift inherit the parent shift.
- Standalone manual entries use the manual clock-in.
- Legitimate unscheduled work uses the actual clock-in.
- Missing or ambiguous anchors remain unresolved and block official payroll export until reviewed.
- Split shifts remain independent occurrences and may belong to different payroll weeks.

## Payroll controls

- Added one authoritative configurable payroll-week helper with Sunday-midnight defaults in Mountain Time.
- Kept payroll-batch grouping separate from daily and weekly overtime allocation.
- Added occurrence keys and fingerprints so one logical shift is represented once and recalculation is idempotent.
- Added reconciliation checks for occurrence uniqueness and `paid minutes = regular minutes + overtime minutes`.
- Added visible batch week, assignment source, cross-boundary status, manual-adjustment status, policy version, and configuration version to review and workbook output.
- Official locking now refuses unresolved assignments or failed reconciliation.

## Controlled correction and history

- Added the `time.override_payroll_assignment` permission for authorized, MFA-verified corrections.
- Corrections require a Sunday week-start date and a written reason.
- Corrections apply only to the selected unlocked occurrence and do not alter punches or disable the company rule.
- Locked export history remains immutable.
- Assignment changes and recalculation runs retain actor, time, reason, before/after evidence, and policy metadata.

## Production data transition

- Applied the database migration to the linked production project.
- Recalculated the open week beginning 08/16/2026 under `payroll-batch-v1`.
- Seven resolvable occurrences were recorded; a repeat dry run changed zero rows.
- Two clock-out-only records without a shift or clock-in remain correctly unresolved for human review.
- Live reconciliation found zero duplicate occurrence keys, and total paid minutes equal regular plus overtime minutes.

## Validation

- Covered Saturday-to-Sunday overnight shifts, Sunday midnight, early and late punches, replacement assignments, linked and standalone manual entries, unscheduled work, split shifts, locked history, missing anchors, configurable time zones, and daylight-saving transitions.
- Completed TypeScript, lint, automated test, production build, migration, helper-boundary, live-data reconciliation, and idempotency checks.
