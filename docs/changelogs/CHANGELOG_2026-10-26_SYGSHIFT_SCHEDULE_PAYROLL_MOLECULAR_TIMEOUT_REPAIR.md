# SygShift schedule and payroll timeout repair

Date: October 26, 2026  
Application: SygShift only  
Status: clean preview and local release verification complete; production release pending

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
- A fresh 388-entry production migration capture and clean Sygilant `origin/main` source review produced a fail-closed expected 398-entry post-activation manifest containing only the ten exact migration additions for this repair.

Production deployment evidence will be recorded here before this status is changed to released.
