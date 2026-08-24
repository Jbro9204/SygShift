# SygShift Change Log — 08/24/2026

## Payroll review reliability

- Repaired the production payroll-review query that could exceed the database statement timeout and display **Payroll review unavailable**.
- Replaced repeated per-punch session lookups with one set-based session calculation over the corrected punch stream.
- Preserved the established 24-hour session boundary used for unscheduled punches, including overnight and split-session behavior.
- Kept the original time events, corrections, schedules, payroll records, and audit history unchanged.

## Production verification

- Benchmarked the complete 08/09/2026–08/22/2026 payroll review before and after the repair.
- Reduced processing time from approximately 8.05 seconds to 1.37–1.49 seconds in three consecutive production checks.
- Verified that the repair returns the same 230 payroll-review rows and the same worked, regular, overtime, salary-default, gross, and paid-minute totals as the original calculation.
- Confirmed that the current production review completes below the application statement-timeout boundary.

## Quality assurance

- Added an automated guard that requires payroll session assignment to remain set-based.
- Added safeguards against payroll-review migrations modifying or deleting source punches.
- Completed TypeScript, lint, unit, and production-build checks.
- Test result: 72 test files and 363 tests passed.

