# Scheduler Leave Unassigned Repair — 09/03/2026

## Summary

Restored the scheduler's **Leave open / unassigned** workflow after the scheduled-overtime preview guard incorrectly kept **Save draft shift** disabled when no employee was selected.

## What changed

- Scheduled-overtime preview loading and error states now block saving only when an employee is actually selected.
- Stale overtime errors and approval prompts no longer remain visible after the assignment is cleared.
- Saving an open shift continues through the existing audited draft-shift update path, which removes the prior active assignment and preserves the shift for later reassignment.
- Employee assignments still require successful overtime validation and any required approval note.
- Availability, credential, overlap, draft, publish, and audit behavior was not weakened or bypassed.

## Verification

- Targeted scheduler regression tests: 6 passed.
- Full release check: TypeScript, zero-warning lint, 158 test files / 763 tests, and production builds passed.
- Production deployment: Cloudflare Worker version `e4d89663-837b-415b-8a5d-e41fa4995b98`.
- Primary and fallback application, health, and readiness endpoints returned HTTP 200.
- Implementation commit: `bf4e570`.

## Operator workflow

Open the affected shift, select **Leave open / unassigned**, and save the draft. The employee can then be placed on the intended shift and replacement coverage can be assigned before the schedule is published.
