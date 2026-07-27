# SygShift Dev Changelog - July 27, 2026

## Armed credential override workflow

This update adds a controlled temporary bypass for armed shifts when leadership already knows a guard is qualified, but the armed credential has not been entered into SygShift yet.

### What changed

- Armed shifts now allow schedulers, supervisors, and admins to select any active employee instead of hiding employees who do not yet have an armed credential on file.
- Every employee dropdown in the affected schedule workflows now clearly shows whether an armed credential is on file.
- If an armed shift is assigned to someone without an active armed credential record, SygShift requires:
  - a written reason,
  - confirmation that no armed credential is recorded in SygShift,
  - confirmation that leadership has verified the employee can work the armed post.
- The override appears in the schedule editor, scheduler shift modal, open-shift/direct-assignment builder, and schedule import/review resolution workflow.
- Guard self-service shift requests still cannot bypass armed credential requirements.

### Database and audit protection

- Added `armed_credential` as a valid schedule assignment override type.
- Updated the schedule qualification trigger so armed-credential exceptions are accepted only when a proper override record exists or when an MFA-verified scheduler/admin/supervisor action is being completed inside the controlled workflow.
- Added armed-credential override support to:
  - `public.update_schedule_draft_shift(...)`
  - `public.create_supervisor_open_shift(...)`
  - `public.resolve_schedule_review_shift(...)`
- Override notes are saved in `public.schedule_assignment_overrides` so the reason and author are retained for review.

### QA completed

- TypeScript check passed.
- Automated test suite passed: 79/79.
- Lint passed.
- Production build passed.
- Supabase migration was applied to the linked production project and the API schema cache was reloaded.
- Cloudflare Worker deployment completed.
- Production health and readiness endpoints passed:
  - `https://app.sygilant.us/api/v1/health`
  - `https://app.sygilant.us/api/v1/ready`

### Operational note

The normal Supabase `db push` flow is currently blocked by earlier remote migration-history entries that are not present locally. I did not run a migration repair because that can change migration history. This update was applied directly as a targeted SQL migration after local QA passed.
