# SygShift Changelog — 07/30/2026 — Payroll Summary Export View

## Payroll export organization

- Reworked the dedicated Payroll Export page so the primary review is grouped by employee, not by every individual worked shift.
- Added an employee summary table showing worked shift count, regular hours, overtime hours, break minutes, paid total, and payroll readiness.
- Added an employee detail drill-down. Clicking **View details** opens the full shift-by-shift audit detail for that person only.
- Kept detailed punch-level data available for audit without flooding the main payroll screen.

## Export behavior

- Added a Summary CSV export with one row per employee for the selected pay period.
- Kept the Detail CSV export available for payroll backup and audit review.
- Official payroll locking now downloads the Summary CSV by default.
- Locked export history now offers both Summary CSV and Detail CSV downloads.
- The older Time & Attendance payroll preview button now clearly exports a Summary CSV.

## Payroll safety

- Summary and detail exports continue to use only SygShift clock-in/out time records.
- Scheduled hours remain excluded from payroll exports.
- Salary default rows remain excluded from payroll exports.
- Detail export still excludes incomplete, unready, or exception rows from the official handoff.
- The summary view shows whether an employee has rows that still need review before locking payroll.

## QA

- TypeScript check passed.
- Lint passed.
- Payroll/timekeeping tests passed.
