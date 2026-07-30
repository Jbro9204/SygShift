# SygShift Dev Changelog — 07/30/2026

## Payroll Export: Worked Time Only

### What changed

- Updated payroll export so it reports only actual SygShift timeclock records.
- Excluded scheduled hours from payroll export.
- Excluded salary-default rows from payroll export.
- Excluded time-off deduction rows/columns from the CSV export.
- Updated CSV generation so only clean, completed clock-in/clock-out rows are written.
- Updated the Payroll Export page totals to count worked punch rows only.
- Updated the older Time & Attendance supervisor export surface to use the same punch-only review.
- Updated payroll readiness cards so export readiness is based on worked time rows, not salary/default rows.
- Added server-side protection in Supabase so official locked payroll batches can only be created from worked punch rows.
- Updated locked export downloads so they return worked punch rows only.

### Important behavior

- A completed, clean clock-in/clock-out row can export.
- A missing clock-out blocks export.
- A pending correction blocks export.
- An invalid punch sequence blocks export.
- A scheduled shift with no punch does not export.
- A salary default does not export.

### Quality checks completed

- TypeScript check passed.
- Lint check passed.
- Unit tests passed: 125 tests.
- Production build passed.
- Supabase migration applied and verified.

### Notes

This aligns payroll export with the rule: HR/Finance should receive worked time from SygShift clock-in/out activity only.
