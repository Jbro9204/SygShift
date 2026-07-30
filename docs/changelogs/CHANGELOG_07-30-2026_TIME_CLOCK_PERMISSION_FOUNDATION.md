# SygShift Changelog — 07/30/2026

## Time Clock Permission and Refresh Foundation

### What changed

- Reworked Time & Attendance access checks so the employee time clock follows the permissions system instead of relying on hard-coded role names.
- Added shared Time permissions helpers for:
  - Viewing personal time.
  - Using the employee time clock.
  - Viewing team time.
  - Managing time.
  - Exporting payroll.
- Updated the Time Command Center, My Time page, legacy Time tools, and Overview quick clock action to use the same permission rules.
- Added immediate post-save refresh behavior for clock punches:
  - The saved punch is applied to visible dashboard data immediately.
  - Related time dashboards, review data, maintenance data, and overview data are refreshed after the save.
- Added a database migration that serializes time clock writes per employee so two quick punch requests cannot create a double clock-in, double break, or other invalid time sequence.
- Added a server-side permission check to the time clock write function so self-service punches require `time.punch` or `time.manage`.
- Added safe fallback screens so permission-gated Time pages never render with missing dashboard data.

### Why it matters

- Employees can view and use their own Time & Attendance tools only when their account is configured for it.
- Admin-configured permissions now control access cleanly, which keeps this tied into the Active Directory-style permission model instead of forcing code changes for every access adjustment.
- Clock-in / clock-out screens update faster after saving and are less likely to confuse employees.
- The database now protects payroll data against fast duplicate punch requests, not just the frontend buttons.

### QA completed

- `pnpm vitest run src\time\timeCommandCenter.test.ts src\data\timekeeping.test.ts src\permissionSurfaceGuard.test.ts`
  - 3 test files passed.
  - 20 tests passed.
- `pnpm typecheck`
  - Passed.
- `pnpm lint`
  - Passed.
- `pnpm build`
  - Passed.

### Notes

- Existing unrelated dirty workspace files were not modified as part of this update.
- The new database migration must be applied to Supabase before the race-safe server-side punch behavior is live in production.
