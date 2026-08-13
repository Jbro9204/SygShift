# SygShift Change Log - Scheduled Paid Training

Date: 08/13/2026

## Summary

Paid training is now an individual scheduling decision instead of a company-wide payroll setup step. Regular shifts remain ordinary worked time automatically. A scheduler marks only the specific shift that represents paid training, and payroll reports that time separately.

## Scheduling workflow

- Added a clear **Paid training time** checkbox to the Add Shift/Event and Edit Shift windows.
- The checkbox is off by default, so regular work does not require an extra selection.
- Training-marked shifts display a **Paid training** indicator on scheduling surfaces.
- Regular shifts no longer display a repetitive Post Time label.
- Existing assignment, draft, publication, overtime, and audit behavior remains intact.

## Time and payroll workflow

- Removed the global Post Time and Training Time payroll configuration panel.
- Removed the payroll export confirmation gate tied to that global setup.
- Renamed ordinary time to **Worked Time** throughout employee time, exceptions, team attendance, payroll review, CSV exports, and payroll workbooks.
- Training totals appear only when paid training actually exists in the selected period.
- Payroll workbooks retain a separate **Paid Training** total and identify training occurrences in employee detail sheets.
- Ordinary worked time is no longer given a visible payroll pay-code column or Post Hours column.
- Audited time-category corrections remain available for authorized administrators when a genuine classification mistake must be repaired.

## Database and security

- Updated production payroll labels from Post Time to Worked Time and from Training Time to Paid Training.
- Removed authenticated access to the retired global work-type configuration functions.
- Preserved the internal compatibility value used by existing schedule and punch records; no schedule, punch, or payroll history was rewritten.
- Applied the change as a targeted production SQL migration because the older local and remote Supabase migration ledgers remain historically inconsistent.

## Verification

- Type checking: passed.
- Lint: passed.
- Full regression suite: 43 test files and 207 tests passed.
- Production build: passed.
- Production database labels and retired-function permissions: verified.
- Added regression coverage protecting the scheduling checkbox, payroll cleanup, workbook layout, and database permission change.
- Production health and readiness: passed.
- Live login route: passed without browser console errors.
- Live deployed assets: confirmed the scheduling checkbox is present and the retired payroll configuration is absent.
- Cloudflare deployment: `f6410166-3c88-45cf-8ef3-2c28238ef816`.
