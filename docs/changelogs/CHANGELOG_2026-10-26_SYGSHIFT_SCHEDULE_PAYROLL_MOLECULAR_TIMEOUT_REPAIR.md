# SygShift schedule and payroll timeout repair

Date: October 26, 2026  
Application: SygShift only  
Status: released and verified in production

## Why this repair was needed

Two independent SygShift workflows were canceled by PostgreSQL's existing eight-second statement timeout:

- preparing an edit for a published schedule block;
- loading payroll and time-correction exception review.

The visible error was the same, but the database paths and root causes were different. The production timeout remains enabled and unchanged.

## Verified root causes

- Published schedule editing eagerly cloned a full schedule revision before an employee had saved any change. The clone also repeatedly searched assignment overrides without an index beginning with the referenced shift and employee keys.
- Payroll review made three overlapping database requests and rebuilt effective punch history through broad, repeated event scans.
- The minute runtime automation joined assignments and event history before first restricting work to shifts that were actually due.
- The runtime due-window used a volatile wall clock in its index predicate. PostgreSQL could select the index but could not use an index range condition, so it still scanned tens of thousands of entries.
- Two database-wide reconciliation lanes ran on the same daily tick, matching the timing of the reported CPU alert.

## What changed

### Schedule editing

- Opening the editor is read-only.
- The first save now materializes the needed draft and applies the edit in one atomic copy-on-write operation.
- The save includes an optimistic version token so a stale browser cannot silently overwrite a newer change.
- The override lookup now has an online index matching the actual shift/employee lookup.
- Existing schedule validation, MFA, permissions, audit history, published-revision immutability and retry idempotency remain enforced.

### Payroll and exception review

- The browser now requests one canonical review payload instead of three overlapping payloads.
- A trigger-maintained projection provides bounded effective punch events while original punches and corrections remain authoritative and unchanged.
- Overnight sessions are paired before period allocation, incomplete pairs remain blockers, and payroll-week/category/overtime logic remains explicit.
- Mid-week salary and carried-overtime cases use the preserved exact bounded calculation path so classification does not change at a partial-week boundary.
- Statement timeouts are not retried automatically and are shown as failed, non-persisted operations.

### Scheduled runtime load

- Candidate shifts are bounded before joining assignments and event history.
- Due-time and employee/shift event indexes support those predicates.
- Stable statement time is used only for due-window index boundaries; audit and job timestamps retain wall-clock behavior.
- Daily attendance reconciliation remains at 2:00 a.m. Denver time. The independent operational-alert reconciliation moves to 2:10 a.m. to prevent both database-wide passes from competing on one tick.
- The normal availability recovery cadence remains intact, with the next complete pass at 2:15 a.m.

## Data and policy boundaries

This repair does not:

- change the authenticated database timeout;
- change payroll policy, rates, overtime rules or payroll-week configuration;
- edit punches, corrections, schedules, employee identities or locked payroll records;
- weaken MFA, permissions or row-level security;
- approve exceptions or submit payroll;
- add employee-specific adjustments.

## Verification status

Completed before the final clean release rehearsal:

- schedule copy-on-write, stale-edit, retry, rollback and MFA regression coverage;
- payroll current-period, prior-period, partial-week, maximum-range and empty-range parity checks;
- overnight, DST, break, adjustment, incomplete-pair, category and payroll-week SQL regressions;
- index-plan evidence showing the runtime due lookup reduced from a filtered 62,719-entry scan to an index range lookup;
- rollback-only runtime cycle: 178.844 ms, with no job row persisted;
- release bundle tests and release-discipline checks.

Final clean-preview evidence:

- exact eight-phase migration chain applied successfully;
- all new and existing boundary SQL regressions passed;
- current-period cold review improved from 7,120.393 ms to 4,932.896 ms;
- warm current-period calls completed in 788.683–822.055 ms;
- three simultaneous calls completed in 981.162–1,398.651 ms with identical digests;
- projection range and close-boundary plans completed in 0.221 ms and 0.209 ms using their intended index-only scans;
- runtime due-window plans completed in 2.121 ms and 2.707 ms with real index conditions;
- a full runtime cycle completed in 177.287 ms under deliberate rollback and persisted no probe job;
- recovery restored all protected source hashes and unchanged authoritative row counts before the disposable branch was deleted;
- `pnpm check` and `pnpm release:verify` passed, including 2,501 unit/component tests, 207 release tests and 42/42 desktop/mobile Time Clock browser tests.

## Production release

- Exact source commit: `ccd31ed2a9bf15eaf06af668e494f91ea92aef95`.
- GitHub `Security and release checks` run `40387187656` passed for that exact commit. Candidate gate job `121798467193` and CodeQL job `121798467595` both succeeded.
- Local exact-candidate verification passed 384 test files with one skipped, 2,260 tests with one skipped, 180 release tests, 42/42 desktop/mobile Time Clock browser tests, typecheck, lint, build and static-asset validation.
- The earlier clean-preview count included tests from the separate, unactivated durability release. The exact production candidate deliberately excludes that release; no molecular test coverage was skipped.
- Ten reviewed molecular migrations are installed. The production ledger contains 398 entries, matches the fresh reviewed baseline and has no drift. The final Worker deployment performed no database write or migration.
- Worker version `c2e9b3c3-989a-4eab-bc26-9ee4a38ddda0` was promoted in deployment `7c226f04-faa7-41ca-a6e0-639e3652e4bf` with exact source metadata.
- The reviewed rollback Worker is `75910843-52c3-433f-b70b-676e790714dd`, sourced from `6070d5e49daac7854fd8c97c331c87fd97c8f03d`.
- Health and readiness returned HTTP 200, `ready=true`, all readiness checks true and `consecutiveFailures=0`.
- Two natural runtime cycles completed on the new Worker. Automation, push-delivery and alert-lifecycle lanes all completed successfully.

## Production performance evidence

- Current pay period: 1,333.394 ms, 134 rows.
- Prior pay period: 2,157.008 ms, 227 rows.
- Maximum supported 46-day range: 5,292.369 ms, 705 rows.
- Three simultaneous current-period reviews: 2,249.893 ms, 2,400.763 ms and 2,363.806 ms.
- Every call remained under the existing eight-second timeout. The timeout was not raised or disabled.

## Release-composition safeguard

An earlier broad candidate was rejected and automatically rolled back because it included unactivated durability Worker code whose push-delivery lane required database RPCs outside this release. The timekeeping lane itself completed in 298 ms. The production-compatible candidate was rebuilt from deployed source, received only the molecular repair and explicitly rejects those unactivated RPC dependencies. The excluded work remains preserved on `safety/unactivated-durability-20261026`.

## Production safety boundary

- Production closeout was read-only. It did not edit source punches, adjustments, published schedules, payroll records, identities, permissions, client records, licensing records or audit history.
- No authenticated production save was performed because doing so would alter a real schedule or time record. Atomic save/readback, retry safety and no-partial-write behavior are covered by rollback-only SQL, disposable-preview and application regression tests.
- The candidate-version URL was unavailable, so the release relied on guarded promotion, exact-source verification, health/readiness probes, automatic rollback criteria and confirmed natural runtime cycles.
