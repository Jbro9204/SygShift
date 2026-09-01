# Unified Editable Employment Dates

Date: 09/01/2026
Status: Released to production

## Problem corrected

The Employment Data Readiness page still opened the original evidence-verification modal. That legacy modal deliberately disabled dates already stored on the permanent employee record, so HR could see the dates but could not click or correct them. The Employee File had already received the newer editable workflow, leaving two conflicting experiences for the same information.

## Outcome

- Employment Data Readiness and Employee File now open one shared employment-date editor.
- Start/hire and separation/termination dates remain editable when a value already exists.
- Both entry points save through `public.update_hr_employee_employment_dates`; no duplicate table, form-specific write path, or competing employee record was created.
- Successful saves immediately refresh Employee File, People, Employment Data Readiness, and the compact date-history view.
- The readiness queue now says **Edit employment dates** and clearly explains that it updates the same permanent audited record used by Employee File.

## Security and integrity

- The database continues to require an active employee identity, verified MFA, and the effective `hr.people.manage` permission.
- Every change requires an evidence source, source reference, and written reason.
- Date order, employee status, unsupported future dates, future separations, and no-change submissions are enforced by the server.
- Every successful correction updates the permanent employee dates and appends a superseding evidence record in one transaction.
- Schedules, shift assignments, punches, active clock sessions, time cards, payroll batches, payroll rows, accounts, permissions, documents, and HR identity mappings are not rewritten.
- The protected HR identity backfill gate and recovery controls remain unchanged.

## Regression protection

- Both pages must reference the shared `EmploymentDateEditorDialog` component.
- The readiness page must not contain the old locked-date notice or date inputs disabled by permanent-record lock flags.
- The shared editor must call the authoritative employment-date update operation and continue requiring evidence and explanation.

## Verification

- Type checking passed.
- Lint passed with zero warnings.
- 130 test files and 644 tests passed.
- Worker and client production builds passed.
- Wrangler 4.106.0 dry run and production deployment passed.
- Deployed Cloudflare Worker version: `7f7d93c5-6cf7-4797-ade9-1cc2e1d925b5`.
- Production app, login, health, readiness, shared editor, Employee File, and Employment Data Readiness assets returned HTTP 200.
- The deployed readiness asset contains the shared editor and **Edit employment dates** action, and does not contain the legacy permanent-date lock notice.
