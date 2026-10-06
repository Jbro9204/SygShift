# Workforce Activity Report Employee Picker Repair

Date: 10/06/2026
Status: Released to production

## Outcome

The Workforce Activity report is available again, and authorized report users
can now choose any eligible employee first and see that person's scheduled or
worked activity for the selected day or date range. An employee with no work in
the selected period remains selectable and receives a clear empty result rather
than disappearing from the picker.

## Root cause

The report's grouped vacancy source expanded `shift.*`. A newer
`payroll_category` column therefore entered a grouped query without being part
of its group definition, causing PostgreSQL to reject the entire report before
it could load. Separately, the Employee filter was built only from report rows
for the selected period, which hid people who had no matching activity.

## Repair

- Replaced the unsafe wildcard shift projection with an explicit, schema-stable
  list of the fields the report actually uses.
- Preserved the existing canonical call-off duplicate safeguard while repairing
  the projection.
- Added the protected `get_workforce_activity_report_employee_options()` RPC so
  the Employee filter is sourced independently from authorized active, leave,
  inactive, and separated employee records.
- Kept report selection, export labels, loading, empty, retry, and clear-filter
  states aligned with the selected employee.
- Removed stale result retention while changing employees, so one person's
  results cannot briefly be shown as another person's work.

## Files and database change

- Source commit: `c4fe25b`
- Database migration:
  `20261006113000_workforce_activity_report_employee_picker_repair.sql`
- Rollback source checkpoint:
  `rollback/pre-workforce-activity-report-employee-picker-repair-20261006`
- Production Worker version: `e85f0848-7615-45a4-9def-b7ea2f0eb5d9`

## Verification

- Production migration preflight matched exactly one intended unsafe projection;
  postflight confirmed the projection repair, preserved call-off safeguard,
  authenticated-only picker access, anonymous denial, and live report rows.
- Full application gate passed after integration: strict TypeScript,
  zero-warning lint, **359 passing test files / 1 skipped**, **1,967 passing
  tests / 1 skipped**, production build, and static-asset contract.
- Focused production-candidate browser coverage passed **50/50** across desktop
  and mobile for both Workforce Activity and the mandatory Time Clock workflow.
- Authenticated live verification confirmed that the independent Employee picker
  loads, an employee selection filters the report to that person's record, and
  the report has no browser console errors.
- Production health returned `status: ok`; readiness returned `status: ready`
  with all required binding checks true.

## Release status

The repair is pushed to `origin/main` and deployed. It changes no employee,
schedule, assignment, timekeeping, payroll, report-history, or audit record;
it only restores the protected report query and its employee-selection path.

## Known narrow limitations

The picker intentionally does not invent activity. If an employee has no
scheduled or worked record in the chosen period, the report states that clearly.
The picker and report remain protected by the existing `time.reports.view`
permission and recent-MFA boundary.
