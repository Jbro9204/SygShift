# SygShift Change Log — Active Admin Count Alignment

**Date:** 08/31/2026
**Area:** User Accounts and Roles & Permissions

## Outcome

The User Accounts summary now reports active employees whose primary role is Admin. It therefore matches the active Admin population shown by the account list and Role Library instead of including preserved inactive or separated records.

## What changed

- Renamed the summary metric from **Admins** to **Active admins**.
- Limited the metric to active employees whose current primary role is Admin.
- Clarified the supporting label as **Current primary Admin role**.
- Added regression coverage for active, inactive, separated, onboarding, and leave statuses.

## Data and access safety

- No employee record was deleted or modified.
- No role, permission, extra role membership, individual grant, or individual denial changed.
- Historical inactive and separated records remain preserved for audit and operational history.
- This release changes only the meaning and presentation of the User Accounts summary count.

## Verification

- Focused metric tests passed.
- Type checking passed.
- Linting passed without warnings.
- Full validation passed: type checking, zero-warning lint, 122 test files / 615 tests, Worker build, and client production build.
- Live release checks are recorded in the repository development log.
