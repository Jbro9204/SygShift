# SygShift Dev Changelog - 07/31/2026

## Employee-Scoped Schedule Publishing

### What changed
- Added a true single-employee schedule publish workflow.
- Added a new Supabase RPC: `public.publish_employee_schedule_slice(target_schedule_id, target_employee_id)`.
- Added a Scheduler UI action that appears only when the Scheduler is in Employee Schedule view with one specific employee selected:
  - `Publish [Employee Name] only`
  - `Publish full week`
- Changed the full-week publish label from a generic draft confirmation to `Publish full week` so the action is clearer.
- Updated the scheduler guidance copy so users understand they can publish either:
  - the whole week, or
  - one focused employee schedule.

### How it works
- The selected employee's active draft assignments are published into a new live schedule revision.
- The previous published schedule is superseded.
- The rest of the working draft is preserved by creating a new latest draft revision after the employee publish.
- The old draft is archived only after the new rebased draft is created.
- This prevents a one-person publish from wiping out another scheduler's unfinished work.
- A one-person publish does not send the broad full-week schedule notification.

### Why this matters
- Admins, schedulers, and other authorized users can safely publish one person's schedule without accidentally publishing the entire employee group.
- This supports situations where one person's schedule is ready while the main scheduler is still building the rest of the week.
- It keeps the scheduler workflow clearer and reduces the chance of human error.

### Database work
- Added migration:
  - `supabase/migrations/20260731161500_employee_scoped_schedule_publish.sql`
- Added private helper:
  - `private.copy_schedule_shift_block(...)`
- Applied migration to Supabase with `supabase db query --linked --file`.
- Marked migration version `20260731161500` as applied in Supabase migration history.
- Verified the new RPC exists on the remote database.

### QA completed
- `pnpm vitest run src/schedulerBehaviorGuard.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm deploy`

### Deployment
- Cloudflare deployment completed.
- Production URL: `https://app.sygilant.us`
- Worker URL: `https://sygshift.sygilant.workers.dev`
- Cloudflare version ID: `c6b8fbae-e5d3-4542-836f-f23dbdaf028a`

### Files touched
- `src/data/schedule.ts`
- `src/pages/SchedulePage.tsx`
- `src/schedulerBehaviorGuard.test.ts`
- `supabase/migrations/20260731161500_employee_scoped_schedule_publish.sql`
