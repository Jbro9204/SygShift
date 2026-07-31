# SygShift Dev Changelog — 07/31/2026

## Scheduler Draft Save Modal Behavior

### What changed
- Updated the full shift editor so a successful draft save closes the modal automatically.
- Corrected the add-shift modal loading language from publishing language to draft-save language.
- Added scheduler behavior guard tests so future changes do not reintroduce misleading publish labels or leave the full shift editor open after a successful save.

### Product decision noted
- Current publishing is week-revision based. Publishing a draft publishes the selected week revision, not a single employee only.
- Single-person publishing should be treated as a separate database-backed workflow so one admin/scheduler cannot accidentally publish another scheduler’s unfinished work.

### QA completed
- `pnpm test -- src/schedulerBehaviorGuard.test.ts src/buttonLayoutGuard.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

### Files touched
- `src/pages/SchedulePage.tsx`
- `src/schedulerBehaviorGuard.test.ts`
