# 07/30/2026 — Scheduler Draft Overlap and Modal Error Reset

## Summary

Fixed a scheduler bug where editing a draft shift could be blocked by the published source copy of that same shift. This is what caused the Market/Jason Douglass edit to report an overlap against the live revision even though the scheduler was only changing the draft shift time.

## What Changed

- Updated the assignment overlap database logic so working drafts ignore the published source schedule for the same week.
- Preserved real scheduling safeguards:
  - same-draft employee overlap conflicts still block saving;
  - other-week conflicts still block saving;
  - approved time off still blocks saving;
  - headcount capacity checks still block saving.
- Cleared stale scheduler edit errors when:
  - opening a shift editor;
  - closing a shift editor;
  - resubmitting a shift edit;
  - switching from edit to remove;
  - removing, publishing, or canceling a draft.

## Live Validation

- Verified the live database originally returned Jason Douglass’s published 07/30/2026 Market shift as the false blocker.
- Applied the migration to Supabase.
- Re-ran the same live database check and confirmed the overlap function now returns no conflict for that source/draft edit case.

## QA

- `pnpm check` passed.
- TypeScript passed.
- Lint passed with denied warnings.
- 29 test files passed.
- 112 tests passed.
- Production build passed.

