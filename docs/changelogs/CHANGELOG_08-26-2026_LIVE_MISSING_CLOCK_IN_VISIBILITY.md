# SygShift Change Log — Live Missing Clock-In Visibility

Date: 08/26/2026

## Summary

Corrected the Time Command Center so dispatch can see employees who are currently scheduled but have not clocked in.

## Changes

- Restored the missing-clock-in grace period to 15 minutes after a published shift starts.
- Kept the separate 14-hour guardrail for unusually long active clock-ins.
- Added unresolved, in-progress missing clock-ins to the dashboard Missing Punches total.
- Added a focused dispatch panel showing the employee, Site/Post, and scheduled start time.
- Kept past missed starts in operational history without presenting them as a current no-show.
- Preserved all punch and schedule history.

## Validation

- Added model coverage for current and past scheduled no-shows.
- Added a migration guard proving the 15-minute no-show rule remains separate from the 14-hour active-clock rule.
- Passed type checking, linting, all 77 test files / 392 tests, and the production build.
- Applied and recorded targeted production migration `20260826150000_missing_clock_in_dispatch_visibility.sql`.
- Verified the production setting is 15 minutes and the live automation created the expected current missing-clock-in record for Randall Hurst.
- Deployed Cloudflare production version `ccd5a6ea-7e83-4700-9523-80ab530e49fd`.
- Verified the custom domain and Worker fallback health/readiness endpoints after deployment.
