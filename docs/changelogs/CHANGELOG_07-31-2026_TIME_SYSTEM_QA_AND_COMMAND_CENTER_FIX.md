# SygShift Change Log — 07/31/2026

## Time System QA and Command Center Fix

### What changed

- Verified the Time System updates from the prior overnight build with typecheck, lint, unit tests, and production build.
- Confirmed the production Supabase database has the Time Maintenance and Team Attendance migrations applied.
- Confirmed `get_time_maintenance` no longer returns every employee punch row when no employee is selected.
- Fixed the Time Command Center so “Clocked In Now” uses the Team Attendance summary instead of raw Time Maintenance punch rows.
- Updated the Time Command Center test to prevent this regression from returning later.
- Deployed the fixed build to Cloudflare.

### Why it matters

- Team Time Maintenance now keeps the all-employee view clean and summary-based.
- Punch-level detail is only shown after selecting or drilling into one employee.
- The Command Center summary cards remain accurate after the raw punch-list protection change.
- The Time System is safer for payroll review because broad views do not dump every punch by default.

### Validation

- `pnpm typecheck` passed.
- `pnpm test -- --runInBand` passed: 31 files, 128 tests.
- `pnpm lint` passed.
- `pnpm build` passed.
- Production deployment completed through Wrangler.

### Deployment

- Cloudflare Worker: `sygshift`
- Production URL: `https://app.sygilant.us`
- Workers URL: `https://sygshift.sygilant.workers.dev`
- Version ID: `c76cf5bb-8913-4de5-a264-50c65b316d88`

---

## Follow-up Time Usability Fixes — 07/31/2026

### What changed

- Fixed active clock-ins so an employee who is currently clocked in is not treated as a Missing Punch while their active shift window is still open.
- Kept stale open punches protected: once the active window has passed, an unclosed punch still blocks payroll review as expected.
- Updated My Time so an active open punch reads as `In progress` instead of `Needs review`.
- Cleaned Team Attendance so it only lists employees with actual time activity, paid time, live clock status, pending corrections, or payroll exceptions.
- Moved Team Attendance punch maintenance into a focused modal instead of forcing the full editor at the bottom of a long page.
- Moved Exception correction into a focused modal opened from the exact exception row.
- Made Time Command Center metric cards actionable:
  - Payroll Ready opens Payroll.
  - Exceptions opens Time Exceptions.
  - Clocked In Now opens Team Attendance filtered to clocked-in employees.
  - Missing Punches opens Time Exceptions filtered to missing punches.
  - Payroll Lock opens Payroll.
- Improved query refresh after time maintenance saves so Team Attendance, Exceptions, Payroll, My Time, and Command Center data refresh together.
- Added regression tests for active clock-ins versus stale missing clock-outs.

### Why it matters

- A normal employee clocking in during their shift no longer creates a false payroll panic.
- Supervisors and admins see a cleaner Team Attendance view instead of every active employee flooding the screen.
- Punch correction now behaves like a focused workflow: click the employee or exception, fix it in a properly-sized modal, and return to the overview.
- Dashboard cards now behave the way real users expect: if a card says there is an issue, clicking it takes them to the work area.

### Validation

- `pnpm typecheck` passed.
- `pnpm test --run` passed: 31 files, 130 tests.
- `pnpm build` passed.
- Production deployment completed through Wrangler.

### Deployment

- Cloudflare Worker: `sygshift`
- Production URL: `https://app.sygilant.us`
- Workers URL: `https://sygshift.sygilant.workers.dev`
- Version ID: `b14ca800-9656-41d5-95f0-c485f8093983`
