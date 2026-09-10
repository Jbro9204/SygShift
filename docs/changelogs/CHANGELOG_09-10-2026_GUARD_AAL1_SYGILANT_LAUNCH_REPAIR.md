# Guard AAL1 Sygilant Launch Repair

Date: 09/10/2026

## Outcome

The production Guard canary identified that an active Guard could sign in at AAL1 but could not see the Sygilant launcher, even though the canonical Guard role held the required `apps.sygilant.access` grant. The session permission projection now preserves that one launcher entitlement for an active canonical Guard whose authoritative effective policy does not require MFA.

## Root cause

- `private.employee_effective_permissions()` correctly returned the Guard role grant.
- `public.get_effective_permissions()` then removed every permission marked `requires_mfa` whenever `public.has_mfa()` was false.
- `apps.sygilant.access` intentionally remains critical, locked, and MFA-protected for all other roles, so the generic filter removed the launcher before the SygShift UI could evaluate it.

## Security controls

- The exception applies only to `apps.sygilant.access`.
- The employee must be active, have the canonical `guard` base role, and have an effective MFA policy of false.
- Direct employee denials remain authoritative because projection still begins with `private.employee_effective_permissions()`.
- All other MFA-protected permissions continue to require `public.has_mfa()`.
- Outgoing assertion issuance, one-time consumption, role matching, source-session binding, and Guard-only AAL1 checks remain unchanged.
- No employee, account, credential, role, role assignment, or permission-grant row is changed by this repair.

## Implementation

- Added migration `20260912020100_guard_aal1_sygilant_permission_projection.sql`.
- Added a production postflight contract for the function definition, protected Guard role, enabled role grant, and protected launcher catalog entry.
- Extended the shared-identity source guard so later changes cannot silently remove the exception or broaden the MFA bypass.

## Verification

- Focused SygShift shared-identity suite: 5 files, 61 tests passed.
- `git diff --check`: passed.
- Production preflight identified an unrelated concurrent migration at `20260912020000`; the repair was moved to unique version `20260912020100` before execution.
- Production migration, postflight, deployment, and user-present Guard handoff evidence are recorded below after release.

## Rollback

- Pre-change source tag: `rollback/pre-guard-aal1-permission-projection-20260910` at `88c37a6`.
- Database migration history remains forward-only. Any database rollback must be a reviewed forward corrective migration that preserves audit and launch-ledger history.
