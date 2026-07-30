# SygShift Change Log — 07/30/2026

## Update

SygShift Time — Phase 1 Foundation and Time Command Center

## What changed

- Created the first dedicated SygShift Time module foundation instead of continuing to overload one crowded Time & Attendance page.
- Rebuilt `/time` into a cleaner Time Command Center focused on payroll readiness, exceptions, missing punches, clocked-in employees, overtime risk, and quick actions.
- Preserved the existing Time & Attendance tools by moving them behind `/time/tools` so current clock-in, clock-out, manual edits, review, and payroll export workflows remain available while the new system is built safely.
- Added future route structure for:
  - `/time/my-time`
  - `/time/team`
  - `/time/exceptions`
  - `/time/timecards`
  - `/time/payroll`
  - `/time/rules`
- Added a shared Time UI kit so Time screens use consistent buttons, cards, badges, section headers, alerts, empty states, and action layouts.
- Added centralized time rule defaults for Sunday-to-Saturday workweeks, biweekly periods, daily overtime, weekly overtime, unpaid breaks, and salary default hours.
- Added a Time Command Center model layer so dashboard metrics come from defined existing data sources rather than hard-coded display values.
- Added role-aware Time behavior:
  - Employees see their own clock state, personal time totals, pending corrections, and My Time direction.
  - Supervisors, schedulers, dispatch, operations, admins, and payroll-capable roles see team/payroll operational summaries when authorized.
  - Payroll export actions only show for users with payroll export access.
- Added responsive Time styling tested against small mobile, tablet, laptop, and desktop widths.

## Existing functionality protected

- No existing timekeeping tables were removed.
- No payroll database logic was replaced.
- No destructive migrations were added.
- Existing active punches remain in place and are read through the existing dashboard state.
- Legacy Time & Attendance tools remain available at `/time/tools`.

## QA completed

- TypeScript type-check passed.
- Lint passed with denied warnings.
- Automated tests passed: 112 tests across 29 test files.
- Production build passed.
- Visual responsive harness passed at:
  - 320px
  - 375px
  - 390px
  - 768px
  - 1024px
  - 1280px
  - 1440px
  - 1920px
- No page-level horizontal overflow was detected in the new Time Command Center layout.
- Time buttons remained readable and properly sized across tested viewports.

## Database changes

- None in this phase.

## Known limitations

- `/time/my-time`, `/time/team`, `/time/exceptions`, `/time/timecards`, `/time/payroll`, and `/time/rules` are staged routes only. They intentionally do not pretend to be complete.
- The legacy tools still handle the detailed working actions until each new Time area is rebuilt and approved.
- The new Command Center is the foundation layer; the full replacement of timecards, exception resolution, payroll export, and rules management remains future phased work.

## Next recommended phase

Build `/time/my-time` as the first fully functional employee-facing Time page, then continue into Team Attendance, Exceptions, Timecards, Payroll, and Rules in that order.
