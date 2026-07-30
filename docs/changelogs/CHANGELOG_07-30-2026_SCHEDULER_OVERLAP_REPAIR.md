# SygShift Change Log — 07/30/2026

## Update

Scheduler overlap conflict repair

## What changed

- Repaired the database overlap guardrail used when schedulers assign employees to shifts.
- The overlap check now ignores stale or unrelated draft schedule revisions instead of treating them like real active assignments.
- The overlap check still blocks true conflicts inside the same working schedule revision and against valid published schedules.
- Real overlap errors now include the conflicting shift details:
  - employee name
  - site/event/post
  - date
  - start time
  - end time
  - schedule revision/status
- Added regression coverage so stale drafts do not block valid scheduling while real overlaps continue to be blocked.

## Why this matters

Schedulers were being blocked by “employee is already assigned to an overlapping shift” even when the visible schedule did not show an overlap. The most likely cause was old draft schedule data being treated as active schedule truth. This update narrows the guardrail to real schedule conflicts and makes the message useful when a conflict is legitimate.

## Database changes

- Added `private.assignment_overlap_conflict(...)`
- Added `private.assignment_overlap_conflict_message(...)`
- Replaced `private.enforce_assignment_capacity_and_overlap()` with a revision-aware, detail-reporting version

## QA completed

- Live database SQL repair applied successfully.
- Verified the new database functions exist in Supabase.
- `pnpm check` passed:
  - typecheck
  - lint
  - 112 automated tests
  - production build

## Notes

- No frontend API contract changed.
- No schedule data was deleted.
- No employee assignments were bulk modified.
- Existing unrelated database lint warnings/errors still exist and should be handled separately.
