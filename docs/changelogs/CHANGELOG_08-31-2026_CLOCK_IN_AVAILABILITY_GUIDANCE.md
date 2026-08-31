# SygShift Clock-In Availability Guidance

**Date:** 08/31/2026  
**Area:** Home and Time & Attendance  
**Status:** Production release

## Outcome

- Verified the reported employee account, effective `time.punch` permission, published assignment, and prior clock-out state.
- Confirmed the clock-in was attempted before the approved five-minute early clock-in window; no account, permission, schedule, or active-session defect was present.
- Preserved the five-minute payroll safeguard.
- Replaced the generic unavailable state with the employee's exact scheduled start, Site/Post, and clock-in opening time on Home and Time & Attendance.
- Kept the existing automatic dashboard refresh so the clock-in action becomes available without a logout or page reset.

## Verification

- Added regression coverage for the exact clock-in opening timestamp and server-time countdown.
- Type checking passed.
- Linting passed with zero warnings.
- 121 test files and 611 tests passed.
- Production build passed.
- No production employee, schedule, punch, payroll, or permission data was changed.
