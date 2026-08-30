# SygShift Change Log — 08/30/2026

## Timekeeping and Schedule Guardrails

### Delivered

- Employees may clock in only for an assigned, published shift and only when the clock-in window opens five minutes before the scheduled start.
- Early clock-in attempts show the exact time the window opens instead of recording premature paid time.
- Authorized time-maintenance users may still enter approved early work manually with a required reason and preserved audit history.
- The selected assignment now controls the workday and Site/Post for a punch. Overnight work remains assigned to the date on which the scheduled shift began.
- The scheduler now previews Sunday-through-Saturday scheduled hours before an assignment is saved.
- Assignments that would raise an employee above 40 scheduled hours show the current hours, proposed hours, resulting total, and overtime amount.
- Authorized users may approve scheduled overtime only with a required explanation that is stored in the schedule and audit history.
- Routine automatic clock-outs remain in the employee's time history and continue to support employee notification, but they no longer create unresolved review work.
- Prior unresolved review items and alerts created solely by successful routine automatic clock-outs are resolved or cleared automatically.
- Automatic clock-out failures, ambiguous time records, and other genuine payroll problems remain reviewable.

### Production Safety

- Actual punches are not rounded, merged, invented, or deleted by these controls.
- Clock-in enforcement exists on the server as well as in the interface.
- Existing schedule and timekeeping permissions remain authoritative.
- Scheduled-overtime approval requires an authorized permission and a written reason.
- Compatibility procedures preserve existing schedule workflows while the application uses the new guarded procedures.
- Original time events and their audit history remain intact.

### Verification

- TypeScript validation passed.
- Lint validation passed.
- Production build passed.
- All 115 test files passed, covering 577 tests.
- Database migration and production deployment are recorded with the release commit.

### Release Records

- `20260831050000_timekeeping_release_guardrails.sql`
- `20260831051000_schedule_overtime_guardrail.sql`
- Cloudflare Worker version: `14771f52-3845-426f-b97e-e49dcccbf6a7`
- Production URL: `https://app.sygilant.us`
