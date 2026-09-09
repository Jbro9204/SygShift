# Time Correction Workflow Repair

Date: 09/09/2026

## Outcome

Time correction requests now use one consistent review workflow. Team Attendance, Operations, the
Review Queue, and employee timecards agree about what is pending, and a manager's direct correction
resolves the older request tied to that punch without deleting the original request or time record.

## Reported Failure

- Team Attendance showed two pending requests for an employee while Operations showed none.
- The Review Requests action opened the previously completed pay period instead of the selected week.
- After a manager corrected the punches directly, the employee rows continued to display
  `Correction pending`.

## Implementation

- Added the legacy punch-correction queue to Operations and combined it with the existing adjustment
  and missing-time queues for one truthful count and employee-request list.
- Preserved the selected employee, date range, and pending-correction filter when moving from Team
  Attendance to the Review Queue.
- Corrected the Review Queue's pending filter to use the actual exception-code collection.
- Added a permission- and MFA-protected database reader for pending punch corrections. Authorized
  reviewers can see the team queue; other employees can see only their own requests.
- Made direct manager correction and request resolution atomic. A matching correction approves the
  pending request; a different correction closes it as superseded with an audit note.
- Reconciled historical requests only when an approved operations-maintenance correction already
  existed for the same punch. Original punches, request rows, decisions, and audit history remain
  intact.
- Added shared navigation/count helpers, component coverage, and a workflow guard so the separate
  correction sources cannot silently drift apart again.

## Database

- Applied and recorded exact forward migration
  `20260910060000_unify_time_correction_workflow.sql` in production.
- The migration was applied in isolation after an ordinary migration push correctly stopped on known
  remote/local ledger drift. No unrelated migration was replayed.
- Linked database lint did not identify the new reader or changed correction function. It continues to
  report eight older, unrelated function errors; those remain pre-existing database lint debt outside
  this repair.

## Verification

- `pnpm check` passed TypeScript, zero-warning lint, both production builds, 217 test files, and 1,081
  tests.
- The required Time Clock workflow passed 38/38 desktop and mobile checks before release and again
  after deployment, covering clock-in, early-clock acknowledgement, breaks, resume, clock-out,
  failure recovery, role boundaries, and duplicate-submit protection.
- Before the repair, the live current-week Team view showed two pending reviews for Jason. After the
  production migration, the same September 6-12 view showed zero pending reviews.
- The live Review Queue now retains September 6-12 and reports `No rows match this exception view`
  for pending corrections, with no unavailable or load-error state.
- The live Operations page loads the unified request totals and queue without an error.
- Production `/api/v1/health`, `/api/v1/ready`, and `/time/operations` returned healthy/ready HTTP 200
  responses.

## Release Evidence

- Rollback source tag: `rollback/time-correction-workflow-pre-release-20260909` at `b300be3`.
- Application source: `bf998e1` (`fix: unify time correction review workflow`).
- Cloudflare Worker version: `2454efb2-82e1-4d79-8e61-8cc88f8f51e8`.
- No test punches or production time records were created or rewritten during verification.

Remaining acceptance: none for this repair.
