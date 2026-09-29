# Workforce Activity Report

Date: 09/29/2026
Status: Released to production

## Outcome

The former **Scheduled vs. Actual** report is now a dedicated **Workforce
Activity** workspace. HR and other authorized report users can choose one day
and answer the practical question, “Who worked, and where?”, then expand to a
date range or compare the published schedule with actual attendance when more
detail is needed.

The report is deliberately organized around operational records instead of
aggregate totals. Each result preserves the employee, employee number, client
or event, site, post, scheduled assignment, attendance evidence, row time zone,
and outcome needed to investigate or export the work.

## Report workflow

- Opens in a simple **Who Worked** one-day view.
- Supports one-day, date-range, and **Schedule Comparison** views without
  forcing the user through separate reports.
- Adds employee, location or event, outcome, organization, and free-text
  filters, plus server-side pagination.
- Shows clear loading, empty, failure, retry, and export states.
- Uses the signed-in employee's time zone when **Today** is selected, while
  every activity row displays and formats times in the assigned shift's own
  time zone.
- Preserves separate rows for legitimate same-time assignments instead of
  collapsing them into a single result.
- Excludes supplemental Dispatch phone duty from workforce-hour reporting.

## Schedule and attendance truth

- Reads only the highest current published revision for each schedule week,
  while retaining the immutable source context needed to explain historical
  call-offs and replacements.
- Includes worked assignments, scheduled-no-work rows, worked-only rows,
  vacancies, call-offs, incomplete punches, and replacement coverage.
- Applies approved time corrections, manual entries, corrected locations,
  overnight shifts, and full occurrence windows before classifying the result.
- Retains a historical replacement as `replacement_worked` only when its
  coverage assignment explicitly references the immutable source shift. No
  replacement status is inferred from a similar employee, time, or location.
- Never displays or infers punches, worked minutes, breaks, overtime, or
  payroll readiness for salaried employees. A salaried **Worked** marker only
  confirms attendance for the scheduled shift.

## Access, security, and exports

- Navigation and the report route require the effective `time.reports.view`
  permission.
- Both public report RPCs independently enforce the signed-in employee,
  effective permission, and recent MFA requirements in PostgreSQL.
- Excel and PDF exports additionally require `reports.export`; every export is
  audited and is generated from the complete unpaged result set rather than
  only the visible page.
- Exported records include exact employee and assignment identifiers, names,
  client or event, site, post, scheduled and actual activity, time zone, and
  outcome.
- Open vacancies do not inflate the unique-employee total, and salaried payroll
  readiness is rendered as **Not applicable**.

## Historical source boundary

The exact **Jason Crow** example is older than SygShift's retained operational
schedule and timekeeping records. The system contains a February 17, 2026
client-import note for **Jason Crowfor 2026 Campaign Kickoff** stating **6
Guards, $80, Stanley Market Place**, but that imported client row has no linked
site, event, shift, attendance, payroll, or employee roster. SygShift's
available time-event history begins July 5, 2026, and its available payroll
export rows begin July 29, 2026.

Accordingly, the new report returns the complete truth available inside
SygShift but cannot identify those six historical guards without a source such
as the former schedule, payroll roster, invoice staffing detail, or event
roster. No names were guessed or reconstructed from unrelated records. Once a
reliable source is supplied, that history can be backfilled through a separate
controlled import.

## Verification

- Focused report coverage: **23/23 tests passed**.
- Full repository gate: `pnpm check` passed with strict TypeScript,
  zero-warning lint, **338 files / 1,789 tests**, the production build, and the
  static-asset contract.
- Mandatory Time Clock preservation: **42/42 desktop/mobile checks passed**.
- Responsive report acceptance: **12/12 checks passed**, including **8/8**
  report checks across 1440 desktop, 800x600 small laptop/high zoom, 390 phone,
  and 320 narrow-phone viewports.
- The linked rollback-only SQL regression passed before installation and again
  against the installed production functions.
- A September 1-29 production smoke returned **565 activity records** with
  valid summary totals.
- Authenticated production browser verification confirmed filters, summary
  cards, row time zones, pagination, exports, Who Worked, and Schedule
  Comparison on the live application.

## Production release references

- Source commit: `e1ff1c572b20874e38758aa7c6d3754b02e99312`
- Database migration: `20260929143850_workforce_activity_report`
- Cloudflare Worker version: `7ea0ee1b-b3ad-41b4-8eac-b8d09a531e48`
- Rollback tag: `rollback/pre-workforce-activity-report-20260929`
- Production health returned `status: ok`; readiness returned `status: ready`
  with all required binding checks ready.
- Exact live assets matched the fresh production build:
  - `assets/index-BoXxSqfz.js`
    (`473d75ac4d690cfb08d7d88fa5f218ac5485f4dcac7775cef5031296c3a6b30e`)
  - `assets/ReportsPage-Buo0eZ8A.js`
    (`e2ffa9c82b35afc836f897c2785cd932697c8483d559da9e9eb8c7d5ea818da2`)
  - `assets/index-BTEZ2SBJ.css`
    (`51c507aac6e5cabcb903ea71fdd2cd9b4e65b34951ee78c8fb6b6c0868b30783`)

## Operator notes

Use **Who Worked** for the normal daily HR question and **Schedule Comparison**
only when investigating coverage or attendance differences. Keep the displayed
time-zone label with any copied time. Historical imports must preserve their
source and employee identity evidence; do not create inferred attendance rows
merely to make a historical client note appear in this report.
