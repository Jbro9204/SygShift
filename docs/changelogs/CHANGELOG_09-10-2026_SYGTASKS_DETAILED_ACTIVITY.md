# SygTasks Detailed Activity Timeline

**Date:** 09/10/2026  
**Status:** Released and verified in production

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
- Post-deployment Time Clock regression gate: 42/42 passed across desktop and mobile, including the real Early Clock-In acknowledgment and retained clock-out/break controls.
- Both production origins returned HTTP 200 for `/health` and `/ready`. The live SygTasks bundle contains the new timeline, Employee action marker, Previous/New comparison UI, and responsive Activity styling.

## Release record

- Pre-release fallback tag: `rollback/pre-sygtasks-detailed-activity-20260910` at `a736355`.
- Source commit: `6e2b675` (`feat: add detailed SygTasks activity timeline`).
- Cloudflare Worker version: `e0f69d87-04d1-4cf6-bce8-e762a83923a2`.
- Deployed assets: `index-BokrS52K.js`, `SygTasksPage-6UmlK1OZ.js`, and `SygTasksPage-DUKl836W.css`.
- Verified SHA-256 hashes: main bundle `ABAF5AE9B98AE03EBAFB3D30B4E61500BE87131084706DCE9F7882081F2E748F`; SygTasks bundle `ADE0AC99A1432677A81929A47C7D5EF7013ABBB4274EA3AB47D7E26DEE08012E`; SygTasks stylesheet `705E41011D139337FE3A95B100198BF9602ED6BB93AE8A917120B40577D1268D`.
- Production origins: `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev`.

## Recovery

The application can be restored to the pre-release source with the fallback tag. The database migration is additive and read-only; any database correction must be a reviewed forward migration that revokes and drops only the new activity-reader function. Existing append-only activity history must not be edited or removed.
