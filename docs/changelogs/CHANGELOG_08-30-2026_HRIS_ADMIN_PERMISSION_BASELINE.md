# SygShift Change Log — Admin Permission Baseline

**Date:** 08/30/2026
**Production migration:** `20260831210000_hris_admin_permission_baseline.sql`

## Outcome

The protected Admin role now receives every active permission in the SygShift permission catalog. This establishes the expected enterprise baseline: an active Admin can administer every currently released or permission-defined area without needing one-off employee overrides.

## Production result

- Admin increased from 66 to 135 active permissions.
- 69 missing permissions were added to the protected Admin role.
- Both active Admin accounts inherited the complete baseline through their existing role.
- All other role definitions remained unchanged.
- All 46 active employee identities, usernames, primary roles, extra role memberships, individual grants, and individual denials remained unchanged.
- Dormant HRIS release gates remain disabled. Granting Admin the permission catalog did not activate unreleased HR modules or create business records.

## Safeguards

- Protected Admin permissions can no longer be partially removed through the role-permission function.
- The migration verifies the non-Admin access matrix, employee identities, memberships, overrides, and HRIS release gates before committing.
- A reviewed service-role repair function can restore the Admin baseline if the active catalog is intentionally changed later.
- New permissions added in the future still require a reviewed activation step; they are not silently granted by a background trigger.
- The change is recorded in the production migration ledger and audit history.

## Verification

- Full type checking passed.
- Linting passed without warnings.
- Production builds passed.
- 119 test files and 603 tests passed.
- Dedicated Admin-baseline tests passed: 6 of 6.
- Independent before/after production inventory confirmed Admin at 135 of 135 active permissions.
- Independent access comparison confirmed every non-Admin role and employee-specific access assignment was preserved.

## Release notes

This was a database and authorization-control release. No Cloudflare application deployment was required because no Worker or user-interface runtime changed.

Rollback must be performed through a reviewed forward migration using the captured pre-change access inventory. Admin permissions should not be removed manually because that could create an incomplete administrative account or weaken recovery access.
