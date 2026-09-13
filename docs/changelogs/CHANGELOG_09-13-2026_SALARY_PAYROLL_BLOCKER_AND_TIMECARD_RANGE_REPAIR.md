# Salary Payroll Blocker and Timecard Range Repair — September 13, 2026

## Outcome

Salaried employees can remain on published schedules and keep their operational punch history without appearing in hourly payroll totals, overtime, correction queues, or payroll blockers. The employee time-detail window also now displays the exact date range whose totals it is showing.

## Salary payroll boundary

- Preserved the normal salaried payroll row and its default paid minutes.
- Removed salaried punch rows from the hourly payroll-review result before totals and blockers are calculated.
- Removed pending salaried punch corrections from the hourly payroll blocker queue.
- Recomputed scheduled, paid, regular, overtime, exception, and blocker summaries from the filtered review rows so the header totals cannot retain excluded activity.
- Added a matching client-side boundary so an unexpected salaried punch row cannot enter payroll totals or export data even if an older database response is encountered.
- Kept salaried employees on schedules and retained every underlying shift, assignment, punch, correction, and audit record.

## Employee time-detail date range

- Connected the detail-window heading to the workbench's actual **From** and **Through** controls.
- The heading now changes whenever either date control changes and resets cleanly when a different employee is opened.
- This removes the misleading state where the modal title showed the current week while the controls and totals were still showing the prior week.

## Michael's reported examples

- Ernesto Munguia's prior week, September 6–12, is correctly **40.75 scheduled hours**: three 12-hour PERA shifts plus 4.75 hours at B'Nai.
- Ernesto's current week, September 13–19, is correctly **36.00 scheduled hours**: three 12-hour PERA shifts.
- Matthew Swinney remains salaried with his **40-hour salary default** retained.
- Matthew now has **0 hourly punch rows**, **0 hourly blocker rows**, and **0 overtime minutes** in the payroll review.

## Security and preservation

- The public payroll-review function remains unavailable to anonymous users and available only to authenticated users through the existing authorization boundary.
- The preserved private base function is not exposed to browser roles.
- No employee, schedule, assignment, punch, correction, payroll-history, permission, or account record was deleted or rewritten.
- Rollback point: `rollback/pre-salary-payroll-boundary-20260913`.

## Verification

- Focused payroll, period-synchronization, and migration guards passed **33/33** tests.
- Full repository gate passed: **256 test files / 1,308 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Full browser matrix passed: **328 passed / 12 intentional skips / 0 failures** across desktop and mobile.
- The post-release actual-component Time Clock matrix passed **42/42** desktop and mobile checks.
- A rollback-only rehearsal compiled the migration against the live schema, left every hourly and Flex row byte-for-byte unchanged, removed salary punch blockers, retained salary defaults, and finished with `ROLLBACK` so no rehearsal data or schema change remained.
- Production postflight confirmed Matthew's salary default at 2,400 paid minutes, zero salary overtime, zero salary blocker rows, and zero salary punch rows in the hourly payroll review.
- Production postflight confirmed Ernesto's two correct schedule totals: 2,445 minutes for September 6–12 and 2,160 minutes for September 13–19.
- Linked-schema lint did not identify an error in the new payroll-review function. Unrelated historical findings remain outside this repair; two Sygilant findings were handed to the Sygilant task without changing the shared payroll function.
- Both production origins returned healthy and ready. Nine entry and Time-workspace assets matched the final release byte-for-byte on both origins.
- A clean signed-out browser was redirected from `/time/team` to `/login`, and no protected Time workspace content was exposed.

## Release references

- Source commit: `6aa0dbc1d9b0714cf13b15f937275e13923f924c`
- Database migration: `20260913211117_exclude_salary_from_hourly_payroll_review.sql` — applied and recorded in production
- Cloudflare Worker version: `9ab647a7-fd65-4a69-9b42-2b9ec1c706b5`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`
