# SygShift Change Log — Timecard Current-Week Default

**Date:** 08/26/2026  
**Area:** Time & Attendance / Team Attendance  
**Status:** Released and verified

## Issue

Time Maintenance could reopen on the last completed payroll period, while Team Attendance could reopen on the full biweekly pay period. A scheduler moving between screens therefore had to reset the dates before reviewing the current week's timecards.

## Correction

- Added one shared current-workweek rule using SygShift's authoritative `America/Denver` operational date.
- Timecard and Team Attendance defaults now open to the current Sunday-through-Saturday week.
- The weekly default is independent of the biweekly payroll-export period, so payroll screens retain their existing pay-period behavior.
- A deliberately selected Team Attendance range is written to the page URL and restored when returning through browser history or a saved link.
- Employee changes do not reset the selected range.
- Explicit date-specific links from Exceptions, Payroll Review, and Daily Attendance remain authoritative and continue to open the exact occurrence being reviewed.

## Safety

- No punches, schedules, payroll calculations, employees, permissions, or audit records were changed.
- The change affects only date-range initialization and navigation state.

## Verification

- Added date-rule coverage for the current Wednesday and Sunday boundary.
- Added a page-level regression guard covering the standalone Time Maintenance default, Team Attendance URL persistence, and explicit review-link precedence.
- Type checking passed.
- Lint passed with warnings denied.
- All 77 test files and 390 tests passed.
- Production build passed.
- Live health and readiness checks passed after deployment.
- Cloudflare production version `e150c43e-edc5-4e8a-b380-9d5c85fb0ef8` was deployed to `app.sygilant.us`.
- Both the custom domain and Workers fallback returned HTTP 200 for `/api/v1/health` and `/api/v1/ready`; readiness reported all required bindings available.

## Files

- `src/time/timeRules.ts`
- `src/time/timeRules.test.ts`
- `src/pages/TimePage.tsx`
- `src/time/TimeTeamAttendancePage.tsx`
- `src/timecardCurrentWeekDefaultGuard.test.ts`
