# SygShift HR Onboarding Production Release

**Release date:** 08/31/2026

**Area:** HR & Finance — Onboarding
**Status:** Production release

## What changed

- Activated the protected Onboarding workspace while leaving Recruiting and every other dormant HR module disabled.
- Added dynamic onboarding requirements for federal, Colorado, California, and Arizona records; hourly, salary, and flex employees; and guard, administrative, operations, and other job families.
- Added conditional guard-license and armed-credential requirements only when the employee's work requires them.
- Added evidence-gated onboarding tasks so document-required items cannot be completed without their required records.
- Added an approval boundary: onboarding completion does not activate an employee until an authorized approver confirms the case.
- Connected approved onboarding to the permanent employee identity and User Account workflow without creating a second employee record.
- Kept the company welcome email and SygShift login-instructions email as separate, approved communications.
- Added production release assertions that fail and roll back if existing employees, accounts, roles, role memberships, or individual permission overrides change.

## Security and operational safeguards

- Existing User Accounts remains the authority for account administration.
- Existing Roles & Permissions remains the authority for access decisions.
- Onboarding approval is server-enforced and requires the approved permission.
- Checklist evidence, approval, activation, and email delivery are auditable.
- No employee, candidate, onboarding case, checklist assignment, or email was created automatically by this deployment.
- Recruiting remains disabled and unavailable until its own controlled production release.

## Verification

- Full TypeScript, lint, application, Worker, and production-build gate passed.
- 120 test files and 608 tests passed.
- Dedicated onboarding production-release controls passed.
- Cloudflare production binding review confirmed that only Onboarding is enabled among the protected HR modules.
- Supabase release migration preserves existing account and permission state and rolls back on any mismatch.
- Cloudflare production deployment `64bd2bcf-827d-4e46-a15d-1a35574edd7c` completed successfully.
- Production login, health, and readiness checks returned successfully after deployment.

## User impact

Authorized HR administrators can now create and manage real onboarding cases from the HR & Finance workspace. Existing employee access and daily SygShift workflows are unchanged.
