# Time Self-Service Access Repair

Date: 09/02/2026

## Outcome

Restored My Time and employee Time Command Center totals for ordinary active employees. Employees can again load their own current pay-period time without operations access or MFA, while payroll administration and the complete payroll-rule configuration remain permission- and MFA-protected.

## Root cause

The 09/02 pay-period total correction made employee pages call `get_payroll_rules()` before requesting time rows. That function is intentionally limited to authorized Time operations users with MFA. Guards and other self-service users were therefore stopped at the payroll-rule boundary, which produced **My Time unavailable** and caused the Command Center snapshot to show zeroes with a partial-data warning.

The clock transaction itself was not changed or disabled; the failure was in the self-service reporting/read path.

## Repair

- Added `get_payroll_period_context()`, an active-employee endpoint that returns only the current server-resolved period boundaries and non-sensitive calendar labels.
- Kept `get_payroll_rules()` unchanged and protected for payroll administration.
- Updated My Time and Time Command Center to load the safe period context before requesting the exact current-period rows.
- Preserved the 08/23/2026–09/05/2026 authoritative range and the separation between Today, This Week, and Pay Period totals.
- Added parsing, boundary-calculation, access-boundary, and page-wiring regression coverage.

## Production verification

- Forward migration `20260903012122_time_self_service_pay_period_context.sql` passed a linked rollback rehearsal and was applied to production.
- An active ordinary employee session at AAL1 resolved the current range as 08/23/2026–09/05/2026 without MFA.
- The same session loaded eight own-time rows totaling 2,406 paid minutes (40.10 hours) plus all eight work-type records.
- No time event, active clock-in, correction, schedule, payroll export, employee, role, or permission record was changed.

## Validation

- Targeted regression validation passed: 5 files / 34 tests.
- Full validation passed: TypeScript, zero-warning lint, 156 test files / 754 tests, and both Worker and client production builds.

## Release status

- Database migration: applied and reconciled in production.
- Git, Cloudflare deployment, and final health/readiness verification: recorded at release completion.

## Rollback

A forward migration can revoke the new endpoint and restore the prior client query path. Existing time, payroll, and employee data require no rollback because this release does not rewrite them.
