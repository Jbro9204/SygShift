# SygShift Changelog — 07/30/2026 — Scheduler Removal Draft Persistence

## Issue addressed

Schedulers reported that removed shifts could reappear while editing the schedule. The remove action also looked different from the rest of the scheduling workflow because it did not clearly say that the removal was being saved to the working draft.

## What changed

- Updated the remove-shift workflow so the action clearly saves the removal to the working draft.
- Changed the remove modal button language to:
  - `Save removal to draft` for draft schedules.
  - `Open draft & save removal` for live/published schedules.
  - `Saving removal...` while the system is working.
- Reset stale removal/edit errors when opening or closing the remove dialog so old duplicate/overlap messages do not carry into unrelated edits.
- Refreshed the visible schedule windows immediately after a removal is saved.
- Invalidated the current weekly schedule query after removal so the screen reloads from the database and verifies the removed shift is truly gone.
- Added a Supabase wrapper for `remove_schedule_draft_shift` so removals now run through the same duplicate/open-state normalization pipeline as edits and publishing.
- Added regression coverage to protect the removal workflow and button language from drifting back into unclear behavior.

## Database work

- Added migration:
  - `supabase/migrations/20260730183000_scheduler_removal_draft_persistence.sql`
- The migration preserves the original removal function privately, then exposes a corrected public wrapper that:
  - saves the removal,
  - normalizes duplicate/open shift bookkeeping,
  - returns a fresh weekly schedule payload.

## QA completed

- TypeScript typecheck passed.
- Lint passed.
- Full test suite passed.
- Production build passed.
- Live Supabase function shape was verified after applying the migration.

## Expected user-facing result

When a scheduler removes a duplicate or unwanted shift, the action is now visibly treated as a saved draft change. The removed shift should not return after refreshing, editing another shift, or reopening the schedule, provided the scheduler publishes the draft when the week is ready.
