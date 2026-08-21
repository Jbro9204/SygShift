# Payroll Review Timeout Repair

Date: 08/21/2026

## Reported issue

The Payroll Export page could not load its readiness review and displayed `canceling statement due to statement timeout`. That prevented authorized users from seeing blockers, reviewing payroll status, or proceeding through the controlled export workflow.

## Root cause

The payroll review rebuilt the same effective punch, correction, Site/Post override, work-session, and payroll-assignment data repeatedly for every review row. The repeated row-by-row database work grew beyond the request timeout for a two-week payroll range.

## Changes completed

- Added one protected, set-based source for effective time events, approved corrections, voids, punch-type corrections, shift overrides, location overrides, and manual entries.
- Reused the calculated occurrence identity and payroll assignment anchor throughout the payroll review pipeline.
- Preserved occurrence-aware detail for incomplete, mapped, overnight, and multi-segment work.
- Replaced repeated unscheduled-session lookups with a set-based occurrence identity source.
- Preserved immutable original punches, append-only correction history, unpaid gaps, exception fingerprints, resolution history, payroll-week assignment, and authorization requirements.
- Added regression coverage for the optimized payroll review and the complex-occurrence fallback.

## Production verification

- The full 08/09/2026–08/22/2026 payroll review completed in approximately 3.2 seconds instead of approximately 34 seconds.
- The protected query returned 196 payroll rows successfully.
- Payroll reconciliation passed.
- The calculated paid-minute total remained 108,988 before and after the performance repair.
- Separate 08/09/2026–08/15/2026 and 08/16/2026–08/22/2026 checks both completed under the production statement timeout and passed reconciliation.
- Repository validation passed: type checking, lint, 54 test files / 287 tests, and production build.

## Operational result

Payroll Export can load its readiness review again. Authorized users can see and work actual blockers without changing valid punch history, and normal production load variance has sufficient room below the database request timeout.
