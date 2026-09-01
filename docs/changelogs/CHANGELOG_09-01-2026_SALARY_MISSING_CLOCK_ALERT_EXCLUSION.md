# Salaried Missing-Clock Alert Exclusion

Date: 09/01/2026  
Status: Released to production

## Outcome

Salaried employees no longer generate missing-clock-in shift alerts. Hourly and flex employees continue through the existing attendance-alert workflow without change.

## Production behavior

- The database rejects creation of a `missing_clock_in` operational exception for an employee whose authoritative employment type is `salary`.
- A second database guard rejects a direct `missing_clock_in` alert for a salaried employee.
- Existing unresolved salaried missing-clock exceptions are marked resolved with the `employment_exempt` method.
- Associated live alerts are cleared automatically with an explicit salaried clock-in exemption reason.
- Reclassifying an employee from hourly or flex to salary immediately runs the same reconciliation.
- The original exception and append-only resolution action remain available for audit.

## Safety boundaries

- No schedule, shift assignment, time event, payroll record, employee record, or acknowledgment was deleted.
- No punch, workday, pay-period, or payroll calculation logic changed.
- Automatic clock-out and all non-missing-clock alert types remain unchanged.
- The exclusion is based on the authoritative `public.employees.employment_type` value, not a UI label.

## Verification

- Isolated Supabase dry run identified exactly one pending migration.
- Production applied only `20260901170000_salary_missing_clock_alert_exclusion.sql`.
- Post-release dry run confirmed the remote database is up to date.
- Type checking passed.
- Lint passed with zero warnings.
- 126 test files and 630 tests passed.
- Worker and client production builds passed.
- Production login, health, and readiness endpoints returned HTTP 200.

No Cloudflare Worker deployment was required because this release changes only database-enforced alert behavior and repository regression coverage.
