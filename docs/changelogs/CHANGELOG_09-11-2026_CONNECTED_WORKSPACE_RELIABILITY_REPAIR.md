# Connected Workspace Reliability Repair

**Date:** 09/11/2026  
**Status:** Released and verified in production

## Outcome

The HR Employee File and Accountability workspace are usable again, and the Attendance Alert Schedule Refresh no longer places continuous multi-second database pressure on SygShift. The fixes were made at the shared data and permission boundaries so they correct the actual failures without weakening authorization or changing historical records.

## Root causes repaired

- The HR permission projection recalculated the Required Actions checkpoint for every permission row. The repeated work exceeded the database statement timeout and surfaced as `Employee File unavailable`.
- Six immutable Accountability events reference valid shifts from superseded schedule revisions. The live-only reconciliation path rejected those historical revisions, returned null timestamps, and caused the strict frontend contract to reject the entire workspace.
- The Attendance Alert Schedule Refresh ran its global safety scan every minute. Its former active-alert filter also selected old unresolved payroll-review exceptions, and schedule edits could request the same full reconciliation repeatedly within one transaction.
- Raw nested validation details were allowed to reach the employee-facing Accountability error panel.

## Repairs

- Added a cheap Required Actions exit for employees who are not enrolled in the checkpoint and changed effective-permission projection to calculate the blocking state once per request.
- Preserved every existing permission grant, denial, MFA boundary, and urgent checkpoint allowlist rule.
- Added an Accountability-specific historical reconciliation path that accepts superseded and archived schedule revisions while preserving each event's original immutable shift relationship.
- Kept live attendance review on the published-schedule-only path.
- Made the client resilient to one damaged optional reconciliation object and replaced raw validation output with a safe, useful workspace error.
- Added a transaction-scoped attendance refresh queue so repeated schedule, assignment, and shift triggers coalesce to one affected week or employee scope.
- Added targeted partial indexes for alert-to-exception lookup and unresolved missing-clock refresh work.
- Bounded non-full safety refreshes to recent or genuinely active operational alerts and changed the global safety cadence from every minute to every five minutes.
- Preserved immediate reconciliation after schedule changes, the existing every-minute timekeeping automation, and the daily full reconciliation at 2:00 AM Denver time.

## Measured production improvement

- Effective permissions for the affected administrator improved from approximately 942 ms to 11.288 ms.
- The authenticated, MFA-complete HR Employee File query completed in 100.208 ms under the same 8-second timeout that previously reproduced the failure.
- The incremental attendance safety refresh improved from 2,689.047 ms and 343,514 shared-buffer hits to 703.668 ms and 86,622 shared-buffer hits.
- The global safety run now occurs once every five minutes, reducing its scheduled database frequency by 80% while leaving immediate and daily correctness paths intact.

## Production safety verification

- Both forward migrations completed rollback-only rehearsals before application.
- Hosted migrations `20260912180000` and `20260912181000` are recorded in the production migration ledger.
- The post-release database check reports zero invalid historical Accountability snapshots, zero queued refreshes, and both performance indexes active.
- No employee, schedule, shift, timekeeping, Accountability, HR, or audit record was deleted or rewritten by the repair.
- The document scanner, storage, queues, Durable Objects, environment bindings, routes, and other Worker integrations were unchanged.

## Verification

- Complete repository gate: 250 test files and 1,277 tests passed, with TypeScript, zero-warning lint, Worker build, and client production build passing.
- Complete rendered browser gate: 316 tests passed, 10 intentionally skipped duplicate mobile-project cases, and zero failed.
- Post-release Time Clock and Early Clock-In matrix: 46/46 passed across desktop and mobile, including clock-in, clock-out, break/resume, early acknowledgement, ambiguous-shift choice, permissions, failure recovery, duplicate prevention, and cross-page synchronization.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned HTTP 200 from `/api/v1/health` and `/api/v1/ready`, with every readiness check passing.
- The live main JavaScript, stylesheet, Accountability data chunk, and Accountability page chunk match the verified local production build byte-for-byte.

## Release record

- Source commits: `f18bc5c` (`fix: restore connected workspace reliability`) and `0c3cd3a` (`perf: bound attendance safety refresh`).
- Cloudflare Worker version: `3fd54f68-15b0-4210-a17d-9d22e64fcc27`, serving the production routes.
- Pre-release fallback tag: `rollback/pre-connected-reliability-repair-20260911` at `b99762d71f0d78cf89fba976afeb2feeae035ed8`.

## Files

- `supabase/migrations/20260912180000_connected_reliability_repair.sql`
- `supabase/migrations/20260912181000_bound_attendance_safety_refresh.sql`
- `supabase/tests/connected_reliability_repair.sql`
- `src/data/accountability.ts`
- `src/connectedReliabilityRepair.test.ts`
- `worker/index.ts`
- `src/worker.test.ts`

## Recovery

The application can be restored to the prior release with `rollback/pre-connected-reliability-repair-20260911`. The database changes are additive and forward-compatible and do not alter business history; any future database reversal must be delivered as a new corrective migration rather than editing applied migration history.
