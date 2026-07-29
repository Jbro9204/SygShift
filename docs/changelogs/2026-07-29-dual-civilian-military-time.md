# SygShift Change Log — 07/29/2026

## Update: Civilian + Military Time Display Standard

### What changed

- Added a shared time-formatting standard for operational displays:
  - Example: `2:00 PM (14:00)`
  - With timezone where needed: `2:00 PM (14:00) MDT`
- Updated major scheduling and operations surfaces to show both civilian and military time:
  - Schedule
  - Scheduler shift cards and edit/details windows
  - Events & Openings
  - Shift/request displays
  - Patrol
  - Availability
  - Time & Attendance
  - Account activity
  - Licensing notification timestamps
  - Account security remembered-device expirations
  - Main workspace operational clock
- Kept storage, payroll math, exports, and form input values unchanged.
  - This is display-only so the underlying schedule/timekeeping data stays stable.

### Verification completed

- Focused time-format tests passed.
- Button layout guard tests passed.
- TypeScript check passed.
- Full automated test suite passed: 28 test files, 104 tests.
- Lint passed.
- Production build passed.
- Cloudflare dry-run passed.
- Cloudflare deployment completed successfully.

### Production deployment

- Deployed to Cloudflare on 07/29/2026.
- Production URL: https://app.sygilant.us
- Worker URL: https://sygshift.sygilant.workers.dev
- Cloudflare Version ID: `5ea7a05e-c8bc-40eb-8f2b-da52091a0bf2`

### Notes

- The goal is to make SygShift easier for both layman users and 24-hour operations staff.
- The system now presents time in a human-readable format while preserving military-time clarity for scheduling accuracy.
