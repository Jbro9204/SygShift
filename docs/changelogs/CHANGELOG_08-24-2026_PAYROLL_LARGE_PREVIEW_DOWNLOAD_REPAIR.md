# SygShift Change Log — Large Payroll Preview Download Repair

Date: 08/24/2026

## What was fixed

- Repaired the `Maximum call stack size exceeded` failure that prevented a payroll preview workbook from downloading when the selected range contained production-sized payroll data.
- Replaced the workbook ZIP builder's large-array function expansion with bounded typed-array writes.
- Added explicit ZIP-format limit checks so an unsupported workbook size produces a controlled explanation instead of corrupting the download.
- Preserved the existing workbook structure, weekly payroll separation, employee detail sheets, formulas, formatting, and payroll calculations.

## Data safety

- No punch, schedule, payroll, locked-export, employee, or audit-history records were changed.
- The repair changes only how the already-generated workbook files are packaged for browser download.

## Verification

- Reproduced the production failure with a 1,200-row payroll workbook regression fixture before changing the ZIP writer.
- Confirmed the same fixture produces a valid, nonempty XLSX package after the repair.
- Type checking passed.
- Lint passed with zero warnings.
- 72 test files / 370 tests passed.
- Production build passed.
- Cloudflare deployment dry run passed.
- Live custom-domain and Worker-fallback health/readiness checks passed.
- Deployed Cloudflare Worker version: `18034a71-2c86-419c-b52e-b6368e9db473`.
