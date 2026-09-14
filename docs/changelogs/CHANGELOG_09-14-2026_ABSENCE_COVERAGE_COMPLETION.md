# Attendance Absence Coverage Completion — September 14, 2026

## Outcome

Recording an employee as absent now continues into the existing guided coverage workflow instead of stopping after the factual Attendance Tracker entry. Management must choose the coverage outcome, and choosing **Find an available guard** creates the separate linked open shift Michael expected while preserving the original published assignment.

## What was repaired

- Added **Absent / call-off** as the clear default occurrence type in Accountability Tracker.
- Made an Accountability absence atomically create and link the durable call-off record used by Requests, Time Operations, notifications, and coverage.
- Continued directly from both Accountability Tracker and Time Operations into **Review absence → Choose coverage → Confirm**.
- Added a **Finish coverage** action for unresolved call-offs so an interrupted workflow remains recoverable.
- Added **Handle coverage** to urgent attendance alerts and deep-linked alerts directly to the correct call-off.
- Restored the Request Center permission contract so authorized managers see the coverage controls; missing or malformed permission data now fails visibly instead of silently rendering a manager as a guard.
- Added durable coverage status to Time Operations so open-pool and Patrol-review cases remain visible while completed cases leave the active queue.
- Kept the existing correction path for an older **Other documented occurrence**: an authorized manager can correct it to **Absent / call-off** and finish the coverage plan.
- Prevented a later correction to a non-absence from incorrectly reopening the coverage dialog.

## Schedule and data integrity

- The absent employee's original published shift and assignment remain intact as permanent schedule history.
- The separate coverage shift is created only after management explicitly chooses **Find an available guard** or **Coverage already found**.
- **Find an available guard** publishes the separate shift into the open pool and stages the established Flex-first notification sequence.
- **Coverage already found**, **Request patrol review**, and **No replacement needed** continue to use the existing validated coverage workflow.
- Retries reuse the existing call-off and stable coverage identifiers rather than creating duplicate absence records.
- No automatic backfill created or changed a real shift, assignment, or coverage case.

## Randy's existing entry

Michael had already rearranged Randy's coverage manually. To avoid double coverage, this release intentionally left Randy's existing **Other documented occurrence** unchanged and created no call-off or duplicate shift for it. If the record needs to reflect an absence, an authorized manager can open it, choose **Correct occurrence type**, select **Absent / call-off**, and then choose the actual coverage result—most likely **No replacement needed** if Michael's manual arrangement is already final.

## Security

- Coverage controls are based on effective permissions, not a role label alone.
- All new public database functions require the existing authenticated/MFA/permission boundaries.
- Anonymous execution is denied.
- Private helper and preserved implementation functions are not browser-callable.
- Every new or replaced security-definer function has a fixed empty search path.
- Existing punch, payroll, HR, permission, employee, and schedule authorization boundaries remain unchanged.

## Verification

- Full repository gate passed: **259 test files / 1,315 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Focused absence coverage component and contract suite passed **9/9** after the final hardening.
- Full browser matrix passed **328 tests / 12 intentional project skips / 0 failures** across desktop and mobile.
- Post-release coverage and actual-component Time Clock matrix passed **44/44** across desktop and mobile.
- The coverage dialog was visually inspected at desktop and mobile sizes; it remains contained, rounded, readable, evenly cushioned, horizontally overflow-free, and keeps its actions reachable.
- A rollback-only production database lifecycle proved that an Accountability absence creates a linked call-off, the open-pool choice creates a separate open coverage shift, the original assignment remains active, and Time Operations receives the durable `open_pool` status. The transaction ended with `ROLLBACK` and left no test data.
- Production database advisors returned no error-level findings.
- Production function audit confirmed fixed search paths and denied anonymous execution.
- Both production origins returned HTTP 200 for health, readiness, Requests, Time Operations, and Accountability. Every readiness dependency reported ready.
- The live application shell, CSS, Requests, Accountability, and Time Operations assets match the release build byte-for-byte on both origins.
- Clean signed-out browsers were redirected from all three protected routes to login without rendering protected content.
- Postflight confirmed Randy still has zero call-off records and one unchanged **Other** occurrence.

## Release references

- Source commit: `420656ea02e3a020f25cfa4f199f544375d12398`
- Database migrations:
  - `20260914141934_absence_coverage_completion.sql`
  - `20260914145246_absence_coverage_contract_hardening.sql`
- Cloudflare Worker version: `3a182c1b-44c2-4426-8ba8-425b19d0937e`
- Rollback tag: `rollback/pre-absence-coverage-completion-20260914`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`

