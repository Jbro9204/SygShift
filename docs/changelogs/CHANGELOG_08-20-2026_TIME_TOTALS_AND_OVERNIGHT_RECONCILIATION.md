# SygShift Time Totals and Overnight Reconciliation

Date: 08/20/2026

## Outcome

Time Maintenance now gives schedulers a clear running summary for the selected employee, overnight punches remain one worked occurrence across midnight, and stale duplicate schedule publications no longer inflate the attendance-review queue.

## Time Maintenance Summary

- Added four concise summary cards for the selected employee and date range: Scheduled, Worked, Difference, and Needs Attention.
- Added an optional **View hours breakdown** section with regular hours, overtime, unpaid breaks, and completed work segments.
- Kept the detailed breakdown collapsed by default so the primary screen remains simple.
- Reused the production payroll calculations for worked time, overtime, unpaid breaks, and readiness instead of creating a separate total.
- Added responsive layouts for desktop, tablet, and phone widths without changing the existing maintenance actions.

## Overnight Time Repair

- Reworked occurrence identity so an overnight session is anchored to its original clock-in and cannot be split by midnight or a later Site/Post correction.
- Paired clock-out events to their preceding open session across midnight within the existing safety boundaries.
- Updated attendance review, payroll review, and Time Maintenance to resolve the same occurrence consistently.
- Preserved all original punch timestamps, sources, corrections, and audit history. No punch was deleted, merged, or rewritten.
- Verified the reported Jonny Durr occurrence from 08/09/2026 at 10:00 PM through 08/10/2026 at 6:00 AM as one eight-hour worked occurrence with no missing clock-out.

## Schedule Publication Integrity

- Preserved historical schedule revisions while allowing only the newest publication for each week to remain active.
- Superseded older published revisions instead of deleting them.
- Added a database constraint preventing more than one active published revision for the same week.
- Updated both schedule publication paths so future publications supersede the prior live revision safely.
- Removed false and duplicate review rows created by competing published revisions and incorrect overnight grouping.
- Reduced the reviewed production range from the reported approximately 459 rows to 122 current unresolved rows. Remaining rows were preserved for human review rather than silently cleared.

## Database Changes

- Added `20260820143000_overnight_occurrence_and_schedule_publication_integrity.sql`.
- Added `20260820170000_attendance_overnight_session_reconciliation.sql`.
- Added `20260820173000_attendance_occurrence_performance.sql`.
- Applied all three migrations to the linked production database and recorded their migration history.

## Quality Assurance

- Type checking passed.
- Linting passed with zero warnings.
- All 51 test files passed with 277 tests.
- Production build completed successfully.
- Production health and readiness endpoints both returned HTTP 200.
- Verified there are zero weeks with more than one active published schedule revision.
- Verified the overnight occurrence produces 480 paid minutes and no false missing-punch exception.
- Added regression coverage for immutable overnight occurrence identity, published-schedule uniqueness, running totals, and attendance reconciliation.

## Deployment

- Cloudflare Worker version: `9b0fae93-c117-4932-8566-6fe3c4063d7e`
- Production URL: https://app.sygilant.us
