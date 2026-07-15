# SygShift Development Log

This file is the project handoff trail. Update it whenever production behavior, database functions,
deployment status, or major workflow assumptions change.

## Current production URLs

- Primary app: https://app.sygilant.us
- Worker fallback: https://sygshift.sygilant.workers.dev
- GitHub repo: https://github.com/Jbro9204/SygShift

## Operational notes

- Supabase is the production database.
- Cloudflare Workers serves the app and Worker API.
- Supabase remote migration history contains older remote-only migration entries that are not present locally.
  Because of that, `supabase db push --linked` has previously refused to run.
- For urgent production SQL fixes, targeted migrations have been applied with:
  `pnpm dlx supabase db query --linked --file <migration-file>`
- Do not run Supabase migration repair blindly. First reconcile remote migration history or intentionally apply
  a targeted SQL file.

## 2026-07-15

### Fixed time-off approval/decline permissions

- Issue: Approving/declining time-off requests failed with `permission denied for schema private`.
- Root cause: `public.decide_time_off_request` was still running as `security invoker` while the workflow depends
  on private account lookup helpers.
- Fix: Added migration `20260715100000_fix_time_off_decision_private_schema_permissions.sql`.
- New behavior:
  - Function runs as `security definer`.
  - Actor is resolved with `private.current_employee_id()`.
  - Only MFA-verified operations roles can approve/decline.
  - Decline still requires a decision note.
  - Approved time off blocks future scheduling through existing assignment guardrails.

## 2026-07-14

### Confirmed MFA requirement for operations roles

- Verified live Supabase `get_session_context()` requires MFA for:
  - Dispatcher
  - Scheduler
  - Supervisor
  - Admin
- Guards are not forced into MFA unless the policy changes later.

## 2026-07-09

### Priority operations workflow fixes

- Added `scheduler` role across app schemas/navigation/data access.
- Confirmed scheduler/dispatcher operational access uses MFA.
- Fixed Events & Openings access by moving to a controlled database payload.
- Added credential editing for guard license and armed guard credential in Users & Access.
- Added inactivity logout:
  - Warning at 8 minutes.
  - Logout at 10 minutes.
- Improved mobile MFA setup persistence when switching apps.
- Normalized main operational date displays toward MM/DD/YYYY.
- Time-off approval no longer forces current shift resolution before approval.
- Time-off decisions optimistically clear from the request queue and restore on failure.
- Past shift requests/call-offs are filtered out of action queues.

### Scheduler draft assignment fix

- Issue: Opening a schedule draft could fail with `schedules_week_revision_unique`.
- Root cause: draft creation picked the next revision from draft/published only, ignoring superseded/archived
  revisions that still occupy the unique `(week_starts_on, revision)` key.
- Fix:
  - `ensure_schedule_draft()` now locks by week and uses `max(revision)+1` across all statuses.
  - Manual assignment can open a draft and then apply the assignment instead of appearing dead.
- Production deploy version from that fix: `969c5668-81f4-4911-9b14-1e911b052534`.

## Standard QA before saying an update is done

Run these before deploy when code changes:

```powershell
$env:Path = 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:Path
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' run lint
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' test -- --run
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' run build
```

Deploy with:

```powershell
& 'C:\Users\Jordan\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\pnpm.cmd' exec wrangler deploy --keep-vars
```

