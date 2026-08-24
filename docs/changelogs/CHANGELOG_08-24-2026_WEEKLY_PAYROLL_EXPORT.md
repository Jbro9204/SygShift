# SygShift Weekly Payroll Export

Date: 08/24/2026  
Production: https://app.sygilant.us

## Purpose

Finance requested a payroll workbook that separates a selected biweekly period into the two Sunday-through-Saturday payroll weeks used for payroll. The export now presents those weekly totals clearly without splitting an overnight occurrence between weeks.

## What changed

- Payroll Summary now has one row per employee for each payroll week in the selected export range.
- Each weekly row shows scheduled hours, worked hours, training hours, regular hours, overtime hours, sick pay hours, PTO hours, other paid hours, total payable hours, and readiness status.
- The workbook includes separate `Week 1 Detail` and `Week 2 Detail` worksheets for a standard biweekly range. Longer custom ranges receive additional numbered weekly detail worksheets.
- Each employee worksheet now includes a weekly rollup before the full pay-period total.
- The Summary includes separate Week 1 totals, Week 2 totals, and complete pay-period totals.
- Shift-level details remain available for audit and reconciliation without crowding the primary Finance summary.

## Payroll-week integrity

- Payroll weeks remain Sunday at 12:00 AM through Saturday at 11:59 PM in America/Denver.
- An overnight occurrence belongs entirely to the payroll week in which its authoritative scheduled start or clock-in occurred.
- A Saturday 11:00 PM through Sunday 7:00 AM occurrence remains wholly in the week that began before midnight.
- A Sunday 11:00 PM through Monday 7:00 AM occurrence belongs wholly to the new week.
- Worked time is calculated from completed SygShift punch segments. Scheduled hours remain a comparison value and are not added to worked payroll hours.
- Sick, PTO, and other approved paid categories remain separate from worked time and are included in total payable hours only through their approved payroll categories.

## Data and audit safety

- This release changes workbook organization and calculations only.
- No punches, schedules, payroll batches, locked exports, or historical audit records were rewritten.
- The workbook consumes the existing authoritative payroll-week assignment produced by the timekeeping occurrence resolver.
- Exact minutes are accumulated before display conversion so weekly totals are not distorted by per-row decimal rounding.

## Quality assurance

- Full project validation passed: type checking, lint, 72 test files, 367 tests, and the production build.
- Added regression coverage for biweekly week separation, Saturday-to-Sunday overnight work, Sunday-to-Monday overnight work, and weekly worked/regular/overtime/sick/payable totals.
- Generated a representative workbook and verified all eight worksheets by importing, inspecting, rendering, and visually reviewing them.
- Workbook formula-error inspection returned zero errors.
- Cloudflare deployment dry-run passed with the production bindings intact.
- Deployed Cloudflare Worker version `1992a2c1-7d46-4870-86f6-0e966e56d354`.
- Production custom-domain health and readiness checks passed; the Worker fallback health check also passed.

