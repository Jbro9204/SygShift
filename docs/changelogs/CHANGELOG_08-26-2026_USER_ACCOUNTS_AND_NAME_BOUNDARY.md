# User Accounts and Legal-Name Boundary

Date: 08/26/2026

## Outcome

SygShift now separates account administration from schedule-facing preferred names. Controlled account and payroll workflows use the employee's legal/profile name, while schedules retain the familiar preferred-name behavior and existing disambiguation safeguards.

## User Accounts

- Renamed **Users & Access** to **User Accounts** in active navigation, page headings, tests, and operating documentation.
- Kept account activation, usernames, login activity, MFA reset, onboarding messages, recovery, and account-state controls in this workspace.
- Kept role and permission design in the separate Roles & Permissions workspace.
- Removed the preferred-name field from User Accounts.
- Existing preferred-name values remain preserved when account records are updated.

## Name handling

- User Accounts displays the legal/profile name, including a recorded middle name when present.
- Current payroll review and newly generated payroll exports use legal/profile names.
- Preferred names remain available to schedule-facing workflows.
- Existing schedule disambiguation remains unchanged so similar names remain understandable; for example, Jainique Lee with the preferred name J remains distinguishable from Joseph Lee.
- Previously locked payroll exports remain immutable audit snapshots and are not rewritten.

## Data and security

- Added a protected database wrapper for current timekeeping review data.
- Legalized employee names in timekeeping rows, pending corrections, and exception-resolution history before they reach payroll review or export.
- Restricted the protected function to authenticated application use and revoked anonymous execution.
- Applied and recorded migration `20260826220000_user_accounts_legal_name_boundary.sql` in production.

## Validation

- Added unit coverage for legal-name construction and schedule-name preservation.
- Added guard coverage for the User Accounts preferred-name boundary and database authorization.
- Verified the live production database function, protected implementation, authenticated execution, anonymous denial, and legal-name replacement behavior.
- Type checking and linting passed.
- All 84 automated test files and 420 tests passed.
- All 20 focused browser tests passed across both configured viewports.
- Production build, Cloudflare package dry-run, and current Worker startup profiling passed.
- Custom-domain and Workers-fallback health/readiness checks returned HTTP 200.
- The live User Accounts bundle contains the new heading and no longer contains the old heading or preferred-name field.
- Released Cloudflare production version `75f5bb9c-9b1a-4da6-95c9-13bcd4d5e018`.

## Future queue

The completed User Accounts consolidation item was removed from the active queue. The separate **Manage Employee Access Workspace Redesign** remains queued because its role-membership and individual-permission interface is a different initiative.
