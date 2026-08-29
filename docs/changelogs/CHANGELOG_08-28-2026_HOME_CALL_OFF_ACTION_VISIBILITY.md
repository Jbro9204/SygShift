# SygShift Change Log — Home Call-Off Action Visibility

**Date:** 08/28/2026  
**Area:** Home, urgent employee actions  
**Risk level:** Focused interface correction

## What changed

- Replaced the low-contrast call-off link in the Home time-status strip with a dedicated urgent-action control.
- Added a solid high-contrast red treatment, protected icon tile, concise urgency context, and stronger visual depth.
- Added explicit hover, keyboard-focus, and pressed states without changing the destination or call-off workflow.
- Preserved the existing employee visibility rule and the established `/time/my-time?report=call-off` route.
- Kept the action responsive so it remains readable and full-width where needed on narrow screens.

## What did not change

- No call-off, timekeeping, schedule, employee, payroll, or notification data was changed.
- No role, permission, or access assignment was changed.
- No database migration was required.

## Verification

- Targeted Home, employee-time, and planned-time-off workflow tests passed: 22 tests.
- Type checking passed.
- Linting passed with warnings denied.
- The complete automated suite passed: 95 test files and 485 tests.
- The production build passed.

## Production release

- Production URL: `https://app.sygilant.us`
- Cloudflare Worker version: `91f047ee-86fe-41d6-9c06-0a5f58210a1d`
- Source and rollback commit: `95ebdaa`
- Public health and readiness checks returned healthy after deployment.
