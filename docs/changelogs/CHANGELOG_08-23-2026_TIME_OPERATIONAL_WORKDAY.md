# SygShift Change Log — 08/23/2026

## Overnight workday and Time Maintenance correction

Time Maintenance now follows the same operational-workday ownership used by payroll. A shift that starts at 11:00 PM on 08/15/2026 and ends at 7:00 AM on 08/16/2026 remains one work occurrence for 08/15/2026 and the payroll week ending 08/15/2026.

### Corrected behavior

- Time Maintenance filters complete work occurrences by their assignment anchor instead of filtering each individual punch by its calendar date.
- An overnight clock-in and its next-morning clock-out can no longer be split into separate false missing-punch findings at a report boundary.
- Each punch row shows both its operational workday and its actual punch date/time.
- The employee's **Needs Attention** card now opens Time Exceptions already limited to that employee and the selected date range.
- The exception screen keeps the linked employee/date scope when payroll rules finish loading.
- Paid-hour and exception summary cards also respect that employee scope.

### Time Maintenance usability

- **Correct punch** now opens a centered modal at the current scroll position.
- The same modal contains Change Punch, Fix Site/Post, Time Category, and Void Duplicate/Accidental choices.
- Corrections continue to preserve the original punch and append audited correction history.
- The punch table was reduced to five meaningful columns and uses a fixed responsive layout so all information fits without an unnecessary horizontal scrollbar.
- Desktop and phone-width Chrome tests confirm the table and modal remain within the viewport.

### Break and scheduled-hour handling

- SygShift continues to count only completed clock-in/clock-out work segments as paid worked time.
- A real clock-out followed by a later clock-in remains an unpaid gap.
- The schedule does not need an artificial 30-minute block for the timecard to calculate that gap correctly.
- A worked-versus-scheduled difference may therefore show the real unpaid gap, but that difference by itself does not fabricate a missing punch or alter payroll time.
- No client/site-specific payroll exception was introduced; the rule applies consistently to PERA, patrol, and all other work locations.

### Production verification

- Daron Jones, 08/15/2026 11:00 PM through 08/16/2026 7:00 AM:
  - Operational workday: 08/15/2026
  - Payroll week ending: 08/15/2026
  - Paid time: 480 minutes
  - Missing-punch exceptions: 0
- Existing time-maintenance access remains protected by MFA and `time.manage`.
- Anonymous database execution remains denied; authenticated execution remains controlled by the function's internal permission checks.
- Type checking, lint, 59 test files / 312 tests, production build, and two Chrome layout checks passed.
- Production migration: `20260823123000_time_maintenance_operational_workday.sql`
- Cloudflare Worker version: `dcc75844-a009-4de2-b3ee-25dd75e0a456`
