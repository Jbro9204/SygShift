# SygTasks Detailed Activity Timeline

**Date:** 09/10/2026  
**Status:** Production database released; application release in progress

## Problem and user impact

Task Activity showed only an employee name, a raw internal action code, and a time. It did not explain what actually changed, which person or task was affected, or the previous and new values. That made the timeline unsuitable for operational follow-up and audit review.

## Changes

- Replaced raw action-code text with a professional timeline that explains each task, assignment, follower, label, checklist, comment, dependency, reminder, and alarm event in plain language.
- Added exact **Previous → New** values for changed task fields, checklist changes, edited comments, and reminder configuration.
- Added readable related employee names, usernames, label names, and dependency task titles instead of exposing UUIDs.
- Added precise Mountain/system timestamps and an explicit Employee action/System action source marker.
- Added rounded, responsive activity cards and expandable detail panels. Long descriptions and comments preserve line breaks without making the default timeline difficult to scan.
- Added cursor-based **Load Earlier Activity** pagination and live query invalidation through the existing SygTasks refresh channel.

## Database and security

- Added forward migration `20260910205447_sygtasks_detailed_activity.sql` (SHA-256 `935A7637DE9FB041F59A233381016F1A59D79BD91DD2BB05ECA6EF08E7A9B8C9`).
- Added `get_sygtasks_task_activity(uuid,bigint,integer)` as a bounded, task-authorized reader over the existing append-only activity history.
- The function is security-definer with an empty search path, is executable only by `authenticated`, and reuses the existing database-enforced `sygtasks_can_view_task` boundary.
- Existing activity, employee, task, schedule, shift, timekeeping, payroll, ticket, HR, document, and access records were not modified. Production activity remained 49 rows across 9 tasks before and after migration.
- Production migration history records version `20260910205447`. A rollback-only live database contract test passed, and Supabase Security Advisor returned no issues. Database lint did not flag the new function; its reported errors are older unrelated functions.

## Verification

- Focused SygTasks activity/data/page suite: 5 files / 30 tests passed.
- Complete repository gate: TypeScript and application lint passed; 237 test files / 1,218 tests passed; production Worker and client builds passed.
- SygTasks and mandatory Time Clock browser matrix: 52 passed / 10 intentional project skips across desktop and mobile.
- SygTasks light/dark layouts passed at desktop, 14-inch laptop, tablet, mobile, and 200% reflow sizes.
- Mandatory Home and Time workspace preservation passed for Early Clock-In, clock-in, break/resume, clock-out, same-shift return, ambiguous shift selection, rapid-submit protection, Guard/Admin/Dispatcher/Supervisor controls, and read-only permission denial.

## Release record

- Pre-release fallback tag: `rollback/pre-sygtasks-detailed-activity-20260910` at `a736355`.
- Source commit and Cloudflare Worker version will be recorded immediately after the application deployment and live verification.
- Production origins: `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev`.

## Recovery

The application can be restored to the pre-release source with the fallback tag. The database migration is additive and read-only; any database correction must be a reviewed forward migration that revokes and drops only the new activity-reader function. Existing append-only activity history must not be edited or removed.
