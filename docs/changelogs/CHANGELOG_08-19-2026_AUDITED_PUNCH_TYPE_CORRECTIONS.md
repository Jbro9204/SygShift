# SygShift Audited Punch Type Corrections

Date: 08/19/2026

## Outcome

Authorized Time Maintenance users can now correct a punch from Clock In to Clock Out, Clock Out to Clock In, Start Break, or End Break without voiding or deleting a valid source punch.

## What changed

- Renamed the maintenance action from **Change time** to **Change punch**.
- Added a **Punch type** selector alongside the corrected date and time.
- Kept **Void duplicate/accidental** as a separate, clearly labeled action.
- Added guidance explaining that Void is only for a duplicate or accidental punch.
- Requires a maintenance reason for every punch correction or void.
- Closes the correction editor after a successful save and refreshes all affected time, attendance, payroll, exception, and dashboard queries.
- Shows the original punch type in Time Maintenance whenever the effective type has been corrected.

## Audit and payroll safeguards

- The original `time_events` record remains immutable.
- The corrected effective type is stored in the append-only correction history with the actor, reason, approval time, and decision data.
- The effective type now drives:
  - current clock state,
  - Time Maintenance,
  - employee time history,
  - team attendance,
  - daily attendance reconciliation,
  - exception detection,
  - payroll calculations and exports,
  - timekeeping automation.
- A correction cannot be saved when it makes no change, is in the future, lacks a reason, or attempts to combine a correction and void in one action.
- Already voided punches cannot be silently changed.

## Validation

- Full typecheck, lint, test, and production build passed.
- 50 test files and 270 tests passed after adding the new regression guard.
- The production database verified the new correction field and RPC, plus effective-type usage in payroll, dashboard, clock-state, and maintenance readers.
- Production health and readiness were checked after deployment.

