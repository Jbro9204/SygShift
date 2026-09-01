# SygShift Change Log — Operations Manager Role

**Date:** 09/01/2026  
**Area:** Roles & Permissions / User Accounts  
**Status:** Production migration applied; application release verified

## Outcome

SygShift now has a protected, MFA-required **Operations Manager** access role for companywide operational leadership between Supervisor and Admin. The migration assigned the role to no employee and preserved every existing role membership and individual permission override.

## Access design

- Began with the live Supervisor operational bundle while deliberately excluding official payroll export.
- Added licensing management and communications, training management, operational exception resolution, basic HR People and Onboarding visibility, User Accounts visibility, onboarding communications, and narrow password-reset assistance.
- Excluded role and security administration, account-security controls, maintenance/backend controls, payroll export and reassignment, licensing configuration, restricted HR, compensation, payroll integration, financial records, SSN, PHI, and protected documents.
- Kept Operations Manager as a protected additive role so assignment does not rewrite an employee's primary job classification.

## Password recovery separation

- Added `admin.users.password_reset` as an exact MFA-sensitive permission.
- The Worker now authorizes employee password-reset delivery independently from `admin.users.manage`.
- Operations Manager can send an audited password-recovery link but cannot reset MFA, revoke FIDO2 keys, revoke remembered devices, enable or disable login, change roles, or remove an employee.
- Admin received the new active permission to preserve the protected complete Admin baseline.

## Data and access safety

- Forward migration `20260901120000_operations_manager_role.sql` fingerprints existing role assignments, individual overrides, existing roles, existing non-Admin role permissions, and existing permission definitions.
- The transaction aborts if any protected existing access state changes.
- No employee was automatically assigned to Operations Manager.
- No employee, schedule, punch, payroll, licensing record, document, or audit history was changed.

## Verification

- The isolated migration dry run proved that exactly `20260901120000_operations_manager_role.sql` would execute.
- The migration applied successfully and the post-apply dry run reported the remote database up to date.
- Production schema lint reported only previously existing issues in unrelated legacy/HR functions; it reported no Operations Manager migration issue.
- Type checking passed.
- Linting passed without warnings.
- All 124 test files and 624 tests passed.
- Worker and client production builds passed.
- Deployed Cloudflare Worker version `eed799e3-b840-4b66-ab7b-d662e9895ceb`.
- Production `/login`, `/api/v1/health`, and `/api/v1/ready` returned HTTP `200`; readiness confirmed assets, Supabase connectivity, and protected server configuration.
