# SygShift Production Regression Repair - 07/28/2026

## Summary

Fixed two production-impacting regressions reported on 07/28/2026:

- Employee updates could fail with `column reference "separated_on" is ambiguous`.
- Armed shift assignments using a documented credential override could save without clear scheduler feedback, and the backend override gate still depended on older hard-coded role logic instead of the newer permissions system.

## What changed

- Added a targeted Supabase repair migration: `20260728093000_production_regression_repair.sql`.
- Repaired `public.admin_update_employee` so employee separation dates are explicitly resolved against the employee row.
- Recreated `public.admin_separate_employee` safely to avoid PostgreSQL parameter-name replacement problems.
- Added `private.can_override_schedule_warnings()` as the central MFA-protected permission check for schedule warning overrides.
- Updated armed credential enforcement to accept users with the `schedule.override_warnings` permission, while keeping MFA required.
- Updated schedule draft editing, open shift creation, and review resolution flows to use the new permission-aware override check.
- Updated weekly schedule payloads so assignment override records are returned to the UI.
- Updated the Schedule UI to show saved credential and availability overrides directly under the assigned employee.
- Updated frontend schedule typing so older payloads without override data still render safely.

## Validation

- Typecheck passed.
- Lint passed.
- Test suite passed: 23 test files, 79 tests.
- Production build passed.
- Remote database repair applied successfully with a targeted SQL execution.
- Live Worker deployed successfully.
- Live health check passed.
- Live readiness check passed.

## Deployment

- Cloudflare Worker version deployed: `02b1aa31-d3fe-46e0-aa41-c00662faf42b`
- Production URL: `https://app.sygilant.us`

## Notes

- A normal Supabase `db push` was intentionally not used because remote migration history is not currently aligned with the local migration folder. Applying only the targeted repair avoided replaying a large backlog of historical migrations.
- The migration-history drift should be reviewed later as a maintenance task, separate from this production hotfix.
