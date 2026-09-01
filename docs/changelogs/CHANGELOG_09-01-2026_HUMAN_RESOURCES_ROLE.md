# SygShift Change Log — Human Resources Role

**Date:** 09/01/2026  
**Area:** Roles & Permissions / HR & Finance  
**Status:** Production migration applied

## Outcome

SygShift now has a protected, MFA-required **Human Resources** access role covering the ordinary employee lifecycle without conferring Admin, Finance, payroll, compensation, or security authority. The migration assigned the role to no employee and preserved every existing role membership and individual permission override.

## Included lifecycle

- HR People, recruiting, onboarding, ordinary HR documents, disciplinary and legal/safety documents
- Leave, benefits, talent, learning, training, employee cases, non-medical safety, and assets
- Offboarding, self-service administration, HR automation operation, and HR reporting
- Directory, credential, licensing, communications, time-off, schedule visibility, team-time visibility, approved login communications, and narrow password-reset assistance

## Protected exclusions

- Compensation, total rewards, payroll integration, official payroll exports, payroll reassignment, salary, banking, tax, SSN, and financial vaults
- Identity, medical, protected-leave, and restricted-medical-safety vaults
- Roles, permissions, security administration, MFA/security keys, login disable/enable, employee separation/deletion, maintenance, and backend controls
- Schedule editing/publishing, time correction, patrol, sites/posts, licensing configuration, and automation override

## Data and access safety

- Forward migration `20260901150000_human_resources_role.sql` fingerprints existing role assignments, individual overrides, existing roles, and every unrelated role permission bundle.
- The transaction aborts if any protected existing access state changes.
- The approved permission array is exact; unavailable permissions, missing permissions, extra permissions, or prohibited permissions abort the migration.
- No employee was automatically assigned to Human Resources.
- No dormant HR release gate was enabled.
- No employee, schedule, punch, payroll, licensing record, document, or audit history was changed.

## Verification

- The isolated dry run proved that exactly `20260901150000_human_resources_role.sql` would execute.
- The migration applied successfully and the post-apply dry run reported the remote database up to date.
- Type checking passed.
- Linting passed without warnings.
- All 125 test files and 627 tests passed.
- Worker and client production builds passed.

