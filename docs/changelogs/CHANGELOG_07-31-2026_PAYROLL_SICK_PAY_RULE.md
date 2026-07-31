# SygShift Changelog — 07/31/2026 — Payroll Sick Pay Rule

## Completed

- Updated payroll exports so called-in-sick records with an attached scheduled shift pay the scheduled shift length.
- Kept actual worked hours strictly tied to SygShift clock-in/out punches.
- Added separate payroll columns for Sick Pay Hours, Vacation/PTO Hours, Other Paid Hours, and Total Payable Hours.
- Added payroll review notes for sick/PTO records that do not have a scheduled shift window, so payroll does not guess hours.
- Updated the payroll UI summary table to show Sick/PTO and Total Payable totals by employee.
- Updated payroll accountability data to include employee role and employment type for cleaner reporting.
- Added regression tests for sick pay, date-only sick reports, and unpaid call-off handling.
- Generated a refreshed payroll example workbook with HR/Finance’s sick-pay requirement.

## Payroll Rule Applied

If an employee calls in sick for a scheduled shift, the sick pay amount is based on that scheduled shift’s length. For example, a 10-hour scheduled shift creates 10 sick-pay hours. If there is no scheduled shift attached, SygShift flags the item for payroll review instead of assuming a number.

## QA

- TypeScript: passed.
- Lint: passed.
- Test suite: 133 tests passed.
- Production build: passed.
- Example workbook rendered and scanned with zero formula errors.
