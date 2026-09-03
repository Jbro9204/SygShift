# Scheduled Overtime Forecast Report

**Released:** 09/03/2026  
**Implementation commit:** `d989764`  
**Database migration:** `20260903154821_scheduled_overtime_forecast_report.sql`
**Cloudflare Worker:** `ff284ac6-6e70-49d0-b199-d3667baab32a`

## Outcome

SygShift Reports now includes a dedicated **Scheduled Overtime Forecast** for the Sunday-through-Saturday schedule week. It identifies employees assigned above 40 scheduled hours before the week begins and provides the assignment detail management needs to review or redistribute coverage.

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
- Primary and fallback application, health, readiness, and report-route checks returned HTTP 200.
- Supabase security and performance advisors reported no new finding tied to this report. Existing informational project notices remain unchanged.

## Scope preserved

This release does not change assignments, approve overtime, infer employee availability, calculate final worked/payroll overtime, or change Dispatch overlap behavior. Scheduling decisions remain controlled by authorized management in Schedule.
