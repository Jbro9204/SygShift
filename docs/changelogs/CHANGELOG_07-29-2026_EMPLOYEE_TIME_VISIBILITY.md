# SygShift Changelog — 07/29/2026

## Employee Time & Attendance Visibility

### What changed

- Added a dedicated **My Time & Attendance** section on the Time & Attendance page.
- All active employees can now open Time & Attendance and view their own time records.
- The employee view shows:
  - selected pay-period date range;
  - paid hours;
  - regular hours;
  - overtime hours;
  - pending correction count;
  - individual time rows with location, clock-in, clock-out, break minutes, notes, and payroll readiness.
- Added responsive styling so the employee time view stays clean on smaller screens.

### Access control / security

- Added the new `time.self.view` permission.
- Granted `time.self.view` to every built-in employee role: Guard, Dispatcher, Scheduler, Recruiting & Licensing, Supervisor, and Admin.
- Kept supervisor/payroll tools separate from employee self-service viewing.
- Tightened the time review database function so employees without payroll authority can only receive their own time rows.
- Updated the old `time.view` label to clarify that it is for team/permitted time review, while self-view uses `time.self.view`.

### Quality checks

- TypeScript check passed.
- Full test suite passed: 104/104 tests.
- Lint passed with denied warnings.
- Production build passed.
- Supabase migration was applied directly to the linked SygShift project.
- Cloudflare deployment completed.

### Deployment

- Cloudflare Worker version: `e9d67a45-38ba-4aa0-b0aa-eff1767320d7`
- Live app: https://app.sygilant.us
- Backup workers.dev URL: https://sygshift.sygilant.workers.dev
