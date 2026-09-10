# Schedule Week Copy Dispatch-Overlap Repair

Date: 09/10/2026

## Outcome

The Scheduler **Copy week** workflow can again copy the current 09/06/2026 schedule into the 09/13/2026 working draft with assigned employees included. Valid concurrent Dispatch phone duty now retains its authoritative assignment classification before the database evaluates employee overlaps.

Ordinary overlapping standard shifts remain blocked. The repair does not publish a schedule, notify employees, or create next week's draft on its own; Michael can initiate the normal copy after release.

## Reported Failure

Michael Hinz reported that copying this week's schedule into next week's draft did not work.

Production diagnosis confirmed:

- Michael's account is active and owns schedule.manage, scheduler.manage, and scheduler.view.
- The source is the current 09/06/2026 working draft.
- The 09/13/2026 destination did not already exist.
- The transaction rejected Joseph Lee's valid 09/15/2026 Dispatch-duty overlap.
- The destination remained empty because the atomic copy correctly rolled the failed transaction back.

## Root Cause

The atomic week-copy function was created before SygShift added explicit work_type, time-zone-source, and assignment_type fields. A later wrapper restored those values only after the base copy completed.

When assignments were copied, a legitimate dispatch_phone_duty shift therefore existed temporarily as standard. The overlap trigger correctly blocks two standard shifts, so it rejected the otherwise valid Dispatch-plus-physical-post combination before the wrapper could restore the Dispatch classification.

## Repair

Forward migration 20260910165913_schedule_week_copy_dispatch_overlap_repair.sql patches only the existing copied-shift insert. It now writes:

- work_type;
- time_zone_source;
- time_zone_employee_id; and
- assignment_type

from the exact source shift before inserting or validating any copied assignment.

The migration is guarded against an unknown function definition and aborts without changing the function if the reviewed insertion boundary no longer matches. Existing MFA, effective-permission, exact-revision, destination replacement, credential-override, inactive-employee, audit, and atomic rollback behavior remains intact.

## Regression Coverage

Added:

- src/scheduleWeekCopyDispatchOverlapGuard.test.ts
- supabase/tests/schedule_week_copy_dispatch_overlap_regression.sql

The rollback-only SQL lifecycle proves that:

- one standard physical-post assignment and one concurrent Dispatch assignment can be copied together;
- both destination shift classifications and both employee assignments are preserved;
- the source schedule remains unchanged;
- a genuine additional standard-shift overlap is still rejected; and
- every fixture, copied draft, assignment, and audit row is rolled back.

## Verification

- Linked exact migration rehearsal with one outer transaction and final rollback: passed.
- pnpm check: passed 232 test files and 1,199 tests, TypeScript, zero-warning application lint, and both production builds.
- Focused Schedule/Dispatch guards: 24/24 passed.
- Required actual-component Time Clock workflow: 42/42 passed across desktop and mobile.
- Production migration recorded as 20260910165913.
- Production security and performance advisors at error level: no issues.
- Production synthetic rollback-only Dispatch copy regression: passed.
- Michael-context rollback-only simulation copied 125 shifts across 13 sites, 126 active assignments, and retained both concurrent Dispatch-duty shifts.
- Post-simulation preservation: the 09/13/2026 destination still contains zero schedules, the current source remains 125 shifts and 126 active assignments, and zero synthetic employees remain.
- Primary and fallback health: HTTP 200.
- Primary and fallback readiness: ready: true.
- Production /schedule: HTTP 200.

## Release

- Source repair commit: c21d3b3.
- Migration: 20260910165913_schedule_week_copy_dispatch_overlap_repair.sql.
- Rollback tag: rollback/pre-schedule-week-copy-dispatch-overlap-20260910.
- No Cloudflare deployment was required because the browser and Worker already call the repaired database function.

## Scope Preservation

No employee, schedule, shift, assignment, punch, payroll, credential, permission, account, notification, or audit record was deleted or rewritten by the release. The actual 09/13/2026 schedule was not created during testing. Only the stored week-copy function definition and its migration-history record changed.

