# SygShift Weekly Development Update

Week of July 12-18, 2026

## Executive summary

This week focused on making SygShift cleaner, safer, and more operationally useful. The largest improvements were around payroll/timekeeping, MFA usability, production navigation cleanup, and database-backed permission fixes.

## Completed updates

### Payroll and timekeeping

- Added a Time Maintenance workspace for operations roles.
- Added employee/date filtering for time records.
- Added supervisor-entered missing punches with required reasons.
- Added time correction and void workflows that preserve the original punch history.
- Added direct `Review / edit time` actions from payroll review rows into the employee's editable time records.
- Improved the Add Missing Punch layout so controls are cleaner and easier to use.
- Added centralized payroll rules:
  - Sunday-Saturday payroll week.
  - Bi-weekly pay frequency.
  - July 17, 2026 pay-date anchor.
  - Daily overtime after 12 paid hours.
  - Weekly overtime after 40 paid hours.
  - Unpaid breaks.
  - 30-minute standard break reference.
  - Salary default of 40 hours per week.
  - Approved time off reduces salary default hours.
- Added salary default rows to payroll review/export without creating fake time-clock punches.
- Added regular hours, overtime hours, salary default hours, time-off deductions, and payroll notes to payroll export data.

### Security and access

- Confirmed operations roles that can access sensitive tools require MFA.
- Fixed remembered-device behavior so normal sign-out no longer removes the trusted-device token.
- Remembered devices still expire, can be removed by the user, and can be revoked by an admin.

### Requests and permissions

- Fixed time-off approval/decline permissions that were failing with private schema access errors.
- Time-off decisions now run through a controlled security-definer function and still require MFA for operations roles.

### Navigation and production cleanup

- Hid legacy Import Review and Operational Import tools from daily navigation.
- Kept the underlying import data/tools available as maintenance/reference support.
- Production navigation now emphasizes live workflows instead of setup/import scaffolding.

### Quality and deployment

- Added and updated automated tests for remembered-device behavior, time maintenance contracts, and payroll/salary default export behavior.
- Ran full QA checks before production deploys:
  - Typecheck
  - Lint
  - Unit tests
  - Production build
- Deployed updates to Cloudflare production.
- Pushed all production changes to GitHub.

## Current production URLs

- Primary app: https://app.sygilant.us
- Worker fallback: https://sygshift.sygilant.workers.dev
- GitHub repo: https://github.com/Jbro9204/SygShift

## Recommended next focus

- Add controlled payroll adjustment rows for salary or hourly exceptions before payroll lock.
- Add a clearer payroll-period selector for bi-weekly periods.
- Continue QA on real employee examples before company-wide rollout.
