# SygShift Change Log — 08/10/2026

## Actionable Payroll Blockers

- Replaced read-only payroll blocker rows with direct **Fix blocker** actions.
- Each time-record blocker now opens the exact employee and work date in the time-maintenance workspace.
- Added an **Open first blocker** action to Payroll Status so the highest-priority issue is immediately reachable.
- Added pending employee correction requests to the payroll blocker list instead of hiding them on another page.
- Pending corrections can now be approved or declined from Payroll Export with an optional audit note.
- Payroll, exceptions, maintenance, attendance, and dashboard data refresh immediately after a correction decision.
- Added clear employee, date, location, clock-window, and blocker context to the workflow.
- Added responsive layout rules so blocker actions and correction dialogs remain aligned on desktop and mobile.
- Added automated guardrails covering blocker navigation, correction decisions, refresh behavior, and responsive layout.

## Quality Verification

- TypeScript typecheck passed.
- Lint passed with warnings denied.
- 170 automated tests passed across 36 test files.
- Production build passed.
