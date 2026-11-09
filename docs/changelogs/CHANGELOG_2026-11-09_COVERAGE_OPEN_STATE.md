# November 9, 2026 — Terminal coverage open-state consistency

Status: applied on 11/09/2026 after a successful rollback-only production rehearsal. Natural-cycle verification and the final app release remain separate required checks.

## Verified interaction

The first published-retirement repair allowed the alert lifecycle to finish without editing immutable cancellation fields. Its initial focused test omitted the installed open-state normalization trigger. In production that trigger recalculated an unassigned generated vacancy as open, even after its coverage case was closed. Readiness recovered, but the vacancy flag remained open. This follow-up addresses that confirmed interaction; a successful scheduler cycle alone was not treated as proof of the correct flag.

## Forward repair

`20261109204156_retired_generated_coverage_open_state.sql` is separate from the already-applied retirement migration.

- The existing normalizer recognizes only a generated shift's exact terminal, resolved coverage case, matching its source shift, with no assigned-guard mode, replacement employee/assignment, or active/confirmed/completed assignment. Only that empty retired vacancy remains closed.
- The live unique `coverage_shift_id` index is verified before installation. Closed history for a different generated shift cannot override a current active case.
- Ordinary shifts and active/assigned coverage retain the existing capacity calculation. Canceled shifts retain the existing closed state.
- The retirement routine moves its one existing shift update after its coverage-case closure. The original locked `coverage_before` snapshot and replacement exclusions remain unchanged, so both states close in one transaction without an extra update or a later cron pass.
- Both functions have exact prior-source and security-metadata fences. The published-schedule protection function is not changed.

The case row was already locked before either update; this preserves the original case-to-generated-shift lock order. The normalizer's case lookup is an indexed read, not an additional row lock. The installed case lifecycle trigger immediately accepts terminal `closed` state.

## Verification

The expanded native regression passed 54 checks and loads the actual retirement routine, published guard, open-state normalizer, and assignment-count helper. It reproduces both original failures, verifies same-call closure, confirms a single close audit and idempotent retries, and checks draft cancellation, assigned replacements, partial staffing, ordinary capacity recalculation, missing resolution, replacement fields, unique case identity, different-shift history, and a closed case with the wrong source identity. It also verifies no business-row change at migration installation and preservation of punches and payroll fixtures.

Production verification must confirm the exact generated vacancy closes after a natural cycle, not merely that readiness becomes green. No manual cron invocation, direct employee/shift update, guard bypass, email, or credential operation is part of this repair.

The new reviewed 457-entry migration baseline preserves the complete prior 456-entry ledger and owning-source checksums, and adds only this explicit forward correction. The prior baseline is retained unchanged.
