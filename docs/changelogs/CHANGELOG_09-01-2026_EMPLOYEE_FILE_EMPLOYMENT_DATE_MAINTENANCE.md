# Employee File Employment-Date Maintenance

Date: 09/01/2026
Status: Released to production

## Outcome

Authorized HR users can now add or correct both the **Start / hire date** and **Separation / termination date** directly in the employee's protected Employee File. Employment Data Readiness remains a reconciliation workspace instead of the routine editor.

## Employee File experience

- The Employment card always shows both dates, including an explicit **Not recorded** state.
- Users with the effective `hr.people.manage` permission receive an **Edit dates** action; view-only users do not.
- The focused modal requires the date values, evidence type, source reference, and reason for the update.
- A separated employee must have a termination date.
- A future start date is permitted only for an employee whose current status is Onboarding.
- Future separations remain planned through the protected Offboarding workflow and are not silently activated from a date field.
- The card shows up to five recent evidence entries on demand instead of creating a long-scroll history.
- Successful saves refresh the Employee File, People workspace, Employment Data Readiness, and date history immediately.

## Data integrity and security

- The database requires an active employee identity, verified MFA, and the exact `hr.people.manage` permission.
- The permanent `public.employees` dates and the existing append-only HR effective-date evidence chain are updated in one transaction.
- Each update records the prior dates, replacement dates, evidence type, source reference, written reason, actor, timestamp, and superseded evidence relationship.
- Invalid order, unsupported evidence, missing explanation, no-change submissions, unsupported future starts, and future termination dates are rejected by the server.
- Existing schedules, punches, active clock sessions, time cards, payroll batches, payroll rows, accounts, permissions, licensing, documents, and other employee records are not rewritten.
- The migration itself fingerprints existing employee records and verifies protected row counts before commit; any unexpected change rolls back the release.

## Verification

- The isolated Supabase dry run identified exactly one pending migration.
- The first production attempt encountered a SQL alias syntax error and the transaction rolled back before commit; no production row changed.
- The corrected migration `20260901210000_employee_file_employment_date_maintenance.sql` applied successfully.
- The post-apply dry run confirmed the remote database is up to date.
- Type checking passed.
- Lint passed with zero warnings.
- 130 test files and 644 tests passed.
- Worker and client production builds passed.
- Wrangler dry run and production deployment passed.
- Deployed Cloudflare Worker version: `742d6601-5182-4123-804e-c816ace33591`.
- Production app, login, health, and readiness endpoints returned HTTP 200.

## Planning cleanup

The completed Employee File start/hire date item was removed from the active future queue. This release also covers the newly requested separation/termination date maintenance.
