# Operational Alert Lifecycle and Backlog Reconciliation

Date: 08/26/2026

## Outcome

SygShift now keeps the live Dispatch alert queue focused on conditions that still require immediate action while preserving unresolved payroll occurrences and the complete audit trail.

## What changed

- Added one stable occurrence identity for each employee, exception rule, scheduled time window, and Site/Post or event.
- Prevented schedule revisions and repeated automation runs from creating multiple unresolved records for the same occurrence.
- Reconciled the existing backlog and retained one authoritative unresolved occurrence per real issue.
- Automatically resolves a missing-clock-in occurrence only when the source condition is provably no longer applicable:
  - a valid clock-in now exists;
  - the shift was canceled;
  - the employee was replaced on the shift; or
  - a valid call-off covers the occurrence.
- Keeps a genuine missed clock-in active for Dispatch during the shift and for one hour after the scheduled shift end.
- Moves an unresolved missed clock-in out of the live operations queue after that response window while keeping it available as a payroll-review exception.
- Retains original punches, schedules, exception records, action history, acknowledgments, and payroll history.
- Records automatic resolution, duplicate reconciliation, and payroll handoff reasons separately from manual acknowledgment.
- Runs incremental reconciliation every minute and a full safety reconciliation at 02:00 Mountain Time.
- Updated the Time Operations explanation so authorized users understand when alerts clear automatically and when they move to payroll review.

## Production reconciliation

- Active operational alerts before reconciliation: 693.
- Active operational alerts after reconciliation: 22 current actionable alerts.
- Older unresolved occurrences transferred to payroll review: 235.
- Resolved occurrences retained in history: 436.
- Unresolved duplicate occurrence groups remaining: 0.
- Active alerts whose source exception was already resolved: 0.

The reconciliation did not delete or rewrite punch, schedule, exception, or payroll-history records.

## Validation

- Type checking and linting passed.
- 83 test files and 415 automated tests passed.
- Production build passed.
- Cloudflare deployment dry run passed.
- Targeted migration `20260826210000_operational_alert_lifecycle_reconciliation.sql` was applied and recorded in production.
- Production health and readiness endpoints returned healthy responses.
- Released Cloudflare production version `14992d6d-2c02-4e7d-9446-a5c7b453ffbc`.
