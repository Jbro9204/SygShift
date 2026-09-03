# Scheduled Overtime Forecast Report

**Released:** 09/03/2026  
**Implementation commits:** `d989764`, `71e40c5`, `6320175`
**Database migration:** `20260903154821_scheduled_overtime_forecast_report.sql`
**Cloudflare Worker:** `1b2fbf0c-b6a3-440a-a687-827def14c5d3`

## Outcome

SygShift Reports now includes a dedicated **Scheduled Overtime Forecast** for the Sunday-through-Saturday schedule week. It identifies employees assigned above 40 scheduled hours before the week begins and provides the assignment detail management needs to review or redistribute coverage.

The report presentation was refined into a compact two-part workspace: a balanced title/export header and an aligned filter panel with the selected week and schedule revision on their own status row. The large Back button, detached controls, uneven field layout, and excess whitespace were removed without changing report behavior.

## Report behavior

- Uses the newest draft schedule revision when one exists; otherwise uses the current published revision.
- Calculates scheduled hours from active, assigned standard shifts.
- Excludes supplemental Dispatch phone duty so overlapping phone coverage does not duplicate scheduled time.
- Separates armed and unarmed hours and identifies employees whose overtime includes armed coverage.
- Shows each shift, Site/Post, shift time zone, scheduled hours, and any scheduled-overtime approval note.
- Includes a separate armed Flex capacity planning list. Candidates have a valid armed credential through the week and remain below 40 scheduled hours, but management must still verify availability and assignment suitability.
- Makes the complete result available as an audited Excel workbook with **Overtime Forecast**, **Shift Detail**, and **Armed Flex Capacity** worksheets.

## Security and data preservation

- Viewing requires `time.reports.view` and verified MFA.
- Downloading additionally requires `reports.export`.
- Export authorization is recorded in the protected audit ledger.
- Both database functions are `SECURITY DEFINER` with an empty search path.
- Anonymous and PUBLIC execution are revoked; only authenticated sessions may invoke the functions, and internal permission checks remain authoritative.
- The migration verifies employee, schedule, shift, and assignment counts and fingerprints before commit. It does not rewrite employee records, assignments, schedules, punches, or payroll data.

## Verification

- Live read-only validation for 09/06/2026–09/12/2026 found four employees projected over 40 scheduled hours, including two with armed coverage, for 45 projected overtime hours on published revision 3.
- Migration completed and remote migration history was reconciled.
- Production grants verified: anonymous and PUBLIC execution denied; authenticated execution allowed subject to internal MFA and permission checks.
- Full repository validation passed: TypeScript, zero-warning lint, 162 test files / 777 tests, and both production builds.
- Six focused report and workbook tests passed.
- Authenticated production verification confirmed the report, shift-detail modal, schedule revision, and audited Excel download.
- The final workbook presentation pass merged metadata values across each worksheet so report scope and calculation notes remain readable without narrow-column wrapping.
- Four focused browser checks passed at 1440px, 1024px, 390px, and dark mode with no horizontal overflow or automated accessibility violations.
- Primary and fallback application, health, readiness, and report-route checks returned HTTP 200.
- Supabase security and performance advisors reported no new finding tied to this report. Existing informational project notices remain unchanged.

## Scope preserved

This release does not change assignments, approve overtime, infer employee availability, calculate final worked/payroll overtime, or change Dispatch overlap behavior. Scheduling decisions remain controlled by authorized management in Schedule.
