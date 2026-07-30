# SygShift Dev Changelog — 07/30/2026

## Payroll Export Readiness

### What changed

- Added a dedicated Payroll Export screen at `Time & Attendance > Payroll Export`.
- Replaced the placeholder payroll route with a working command center for payroll review, CSV preview, official export locking, and locked export history.
- Added payroll period controls built around the real bi-weekly pay cycle:
  - Last completed pay period
  - Current open pay period
  - Previous pay period
  - Next pay period
  - Manual from/through date range
- Anchored the payroll calendar to the known pay date of 07/31/2026 so bi-weekly periods calculate consistently.
- Added payroll readiness checks before an official export can be locked.
- Added clear blocking messages when payroll has:
  - pending correction requests
  - unresolved exceptions
  - rows not ready for export
  - no payroll rows for the selected range
- Added official export lock support that saves the export as an audit-safe payroll batch.
- Added the ability to re-download locked payroll export CSV files from export history.
- Updated payroll CSV formatting so dates and times are readable for HR/Finance:
  - Dates use `MM/DD/YYYY`
  - Clock times show civilian and 24-hour time, for example `07/30/2026, 2:00 PM (14:00)`
- Added payroll export permission for Supervisors through the permissions system.
- Added automated tests around payroll period calculation, payroll export CSV formatting, locked export detail parsing, and payroll lock validation.

### How it works

Admins and authorized Supervisors can open Payroll Export, choose the correct pay period, review readiness, download a preview CSV, then lock the official export when the review is clean.

The official export is saved as a payroll batch. That means the exported rows can be pulled again later from history instead of relying on someone’s downloaded file.

### Quality checks completed

- TypeScript check passed.
- Lint check passed.
- Unit tests passed: 123 tests.
- Production build passed.
- Database migration applied and verified.
- Verified the locked-export detail RPC exists.
- Verified Supervisors have payroll export permission enabled.

### Notes

- This update prepares payroll exporting for real operational use.
- It does not submit payroll automatically. HR/Finance still receives the exported CSV through the company’s normal payroll process.
