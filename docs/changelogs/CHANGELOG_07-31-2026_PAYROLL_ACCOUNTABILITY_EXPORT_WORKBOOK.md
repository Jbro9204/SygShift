# SygShift Change Log — 07/31/2026

## Payroll Accountability and Export Workbook

### Completed

- Added an employee self-report workflow for call-offs and sick reports from My Time.
- Added dispatch notification support so employee-reported call-offs/sick reports notify `dispatch@guardianshipsecurity.net`.
- Added payroll accountability records for sick, call-off, vacation/time-off, and legacy call-off data.
- Added Supabase database support for accountability events, payroll accountability reporting, dispatch delivery tracking, and related permissions.
- Added Active Directory-style permission entries for accountability viewing, creation, and management.
- Updated payroll export from CSV-only output to a structured Excel workbook.
- Organized payroll export into separate workbook tabs:
  - Payroll Summary
  - Discrepancies
  - Site Summary
  - One detail tab per employee
- Kept payroll totals based on actual SygShift clock-in/clock-out time only.
- Added scheduled-hours comparison so payroll can see scheduled vs. worked variance without counting scheduled hours as pay.
- Added accountability and time-off items into payroll export context.
- Updated payroll export file names to `.xlsx`.
- Added a polished example payroll workbook for the 07/26/2026–08/08/2026 pay period.

### Quality Checks

- TypeScript typecheck passed.
- ESLint passed.
- Automated test suite passed.
- Production build passed.
- Example workbook generated and visually reviewed.
- Example workbook was scanned for formula/error markers.

### Notes

- Payroll weeks remain Sunday through Saturday.
- The example pay period is 07/26/2026 through 08/08/2026, matching the next requested report window.
- Future automation can send the completed payroll workbook to `compliance@guardianshipsecurity.net` on the configured payroll schedule.
