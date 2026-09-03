# Concurrent Dispatch Phone-Duty Assignment

**Released:** 09/03/2026  
**Implementation commit:** `376a093`  
**Database migration:** `20260903132400_concurrent_dispatch_phone_duty.sql`  
**Cloudflare Worker:** `8d0b8974-8f05-4985-b448-3ac830f315be`

## Outcome

SygShift now treats the existing **Dispatch Phone Coverage** schedule source as an explicit supplemental responsibility. An authorized scheduler may assign an employee to that duty while the employee is also assigned to one normal physical Site/Post shift for the overlapping period.

This is a narrow exception. Two physical shifts, two Dispatch duties, and Dispatch plus Training remain conflicting assignments.

## Time, attendance, and payroll protection

- Dispatch phone duty does not open a second clock session or create a second punch.
- Dispatch phone duty is excluded from missing-clock exceptions and attendance alerts.
- Its scheduled minutes are excluded from overtime preview totals, preventing duplicate scheduled-hour and overtime counts.
- No premium, stipend, or compensation rule was introduced. The release only prevents the same elapsed time from being counted twice.
- New time events cannot be directly tied to a Dispatch phone-duty shift.

## Visibility and audit

- Schedule cards, employee-week details, and day details identify the responsibility with a **Dispatch phone duty** label.
- The existing Dispatch coverage schedule remains the management coverage view and maintains its own coverage headcount.
- Concurrent assignments create audit evidence identifying the employee, Dispatch shift, overlapping Site/Post shift, assigning user, assignment time, and responsibility notes.

## Data preservation

The migration verifies employee, shift, assignment, and time-event counts plus a time-event fingerprint before commit. Existing published schedules were not rewritten. Twenty-three historical Dispatch-linked time events were preserved unchanged rather than deleted or reclassified.

## Verification

- Direct database behavior check: Dispatch + standard Site/Post allowed.
- Direct database behavior check: standard Site/Post + standard Site/Post blocked.
- Active Dispatch missing-clock alerts after release: `0`.
- Unresolved Dispatch missing-clock exceptions after release: `0`.
- Full repository check: 159 test files and 767 tests passed.
- TypeScript, zero-warning lint, and both production builds passed.
- Primary and fallback `/api/v1/health` and `/api/v1/ready` returned HTTP 200.
- Production Schedule bundle contains the released Dispatch-duty interface.

## Scope preserved

The release did not change employee identities, existing permissions, published schedule history, historical punches, payroll records, or unrelated scheduling behavior.
