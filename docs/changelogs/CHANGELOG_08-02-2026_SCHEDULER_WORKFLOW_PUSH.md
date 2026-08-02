# SygShift Changelog - 08/02/2026 Scheduler Workflow Push

## Summary

This update tightened the scheduler workflow so schedule changes are clearly separated into draft work, publishing, and employee notification. The goal was to make the scheduler safer, clearer, and more uniform without automatically sending employees repeat notices while schedule work is still in progress.

## Completed

- Added a manual **Notify employees** workflow for published schedules.
- Updated full-week publishing so it makes the schedule live but does not automatically send schedule emails.
- Added **Copy week** so schedulers can copy a source week into a future working draft and edit from there.
- Kept add/edit/remove schedule work draft-safe until a scheduler intentionally publishes.
- Confirmed remove-shift workflow saves into the working draft and closes the modal after completion.
- Added backend database functions for manual schedule notifications and week-copy drafting.
- Added scheduler workflow modals with consistent spacing, summary cards, font treatment, mobile fallback, and uniform action buttons.
- Added guard tests to protect scheduler button layout, copy-week behavior, and manual notification behavior.

## Quality Checks

- TypeScript check passed.
- Lint passed.
- Test suite passed: 152 tests.
- Production build passed.
- Live database functions verified:
  - `copy_schedule_week_to_draft`
  - `publish_schedule_draft`
  - `queue_schedule_published_notification`

## Notes

- The Supabase migration was applied directly to the linked database and verified live.
- A historical Supabase migration-history drift still prevents normal `db push`; no broad repair was run during this update.
- Employee notifications are now intentionally manual after publishing, so last-minute schedule edits do not automatically send multiple notices.
