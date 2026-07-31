# SygShift Dev Changelog — 07/31/2026

## Timekeeping Guardrail Repair

### What changed
- Adjusted active clock-in review logic so an employee who is still clocked in is not immediately counted as a missing punch simply because the scheduled shift end has passed.
- Set the active clock-in guardrail to 14 hours. Open punches under 14 hours remain treated as in-progress; open punches at 14 hours or longer are flagged for review.
- Updated the Clocked In Now dashboard warning to use the same 14-hour guardrail instead of the older 12-hour threshold.
- Added dashboard language so long active punches show as “over 14h” when the guardrail is triggered.

### Why this matters
- SygShift supports 12-hour shifts, so a missing-punch warning immediately after scheduled end created false alarms.
- Payroll and supervisors now see cleaner exception counts while employees are actively working.
- Truly stale punches still surface for correction before payroll.

### QA completed
- `pnpm test -- src/time/timePayroll.test.ts src/time/timeCommandCenter.test.ts`
- `pnpm typecheck`
- `pnpm build`
- `pnpm lint`

### Files touched
- `src/time/timePayroll.ts`
- `src/time/timeCommandCenter.ts`
- `src/time/TimeCommandCenterPage.tsx`
- `src/time/timePayroll.test.ts`
- `src/time/timeCommandCenter.test.ts`
