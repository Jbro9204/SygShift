# 09/09/2026 — Future Queue Management Decisions

## Decisions recorded

- The existing Dispatch log will be retained. The open retain/replace/retire decision was removed from
  the active Future Items queue, and the TrackTik transition now explicitly preserves Dispatch-log
  continuity.
- The active-employee headcount audit and its related cleanup/count-definition work are not being
  pursued at this time and were removed from the active Future Items queue.
- The still-needed schedule-driven attendance-alert refresh remains queued as its own focused item.
- The already-completed On Duty Now / Clocked In roster action was removed from the active queue; its
  implementation history remains in the dated release records and `DEVLOG.md`.

## Scope

This was queue maintenance only. It did not change production code, Dispatch behavior, employee data,
accounts, schedules, attendance alerts, time records, payroll, permissions, or authentication.

