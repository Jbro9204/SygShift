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
- Added forward follow-up migration `20260912030000_guard_aal1_sygilant_session_projection.sql` after independent coordinated verification. It reasserts the same single-permission exception with explicit prerequisite checks and does not change any employee, role, assignment, override, or permission-catalog row.
- Added a production postflight contract for the function definition, protected Guard role, enabled role grant, and protected launcher catalog entry.
- Added a rollback-only live session matrix that exercises `public.get_session_context()` for eligible Guard AAL1, MFA-required AAL1, and MFA-required AAL2 sessions without retaining test data or account identifiers.
- Extended the shared-identity source guard so later changes cannot silently remove the exception or broaden the MFA bypass.

## Verification

- Focused SygShift shared-identity suite: 5 files, 61 tests passed.
- Full quality gate: 228 test files / 1,172 tests passed, plus TypeScript, zero-warning application lint, Worker build, and client production build.
- Protected browser regression: 54 of 54 desktop/mobile launcher and actual-component Time Clock checks passed, including early-clock-in acknowledgment, clock-in/break/clock-out, same-shift return, duplicate prevention, ambiguous shifts, and Guard/Admin/Dispatcher/Supervisor active controls.
- `git diff --check`: passed.
- Production preflight identified an unrelated concurrent migration at `20260912020000`; the repair was moved to unique version `20260912020100` before execution.
- Production preflight reproduced the AAL1 projection defect without exposing the selected Guard identity.
- Production migrations `20260912020100` and `20260912030000` are recorded in the hosted migration ledger. The follow-up migration SHA-256 is `C47B8808EF5868DD78BD14BF8A562C0CC2BB24BE009A87B352A6D32E62F51629`.
- The final rollback-only live session matrix passed: eligible canonical Guard AAL1 projected the launcher; every unrelated MFA-sensitive permission remained absent; MFA-required AAL1 did not project the launcher; MFA-required AAL2 did.
- Postflight confirmed the locked/critical/MFA-required catalog record remains intact, authenticated execution is allowed, anonymous execution is denied, and eligible plus MFA-required launch subjects remain available for both policy paths.
- The linked full-schema lint still reports nine pre-existing errors in unrelated legacy functions. The repaired SQL function installed successfully and every targeted security/runtime contract passed; none of the lint findings names `get_effective_permissions` or the Sygilant handoff.

## Production release

- Initial repair commits: `2b0198b` and migration-version correction `bf247e6`.
- Strengthened session-matrix commit: `54069aa`.
- Cloudflare Worker: `061e3d2a-1f0d-4360-8206-029356e2000a`.
- Primary and fallback roots, `/api/v1/health`, and `/api/v1/ready` returned HTTP 200; both readiness responses reported `ready: true`.
- An unauthenticated Sygilant launch request was rejected with HTTP 401 at the production Worker boundary.

## Rollback

- Pre-change source tag: `rollback/pre-guard-aal1-permission-projection-20260910` at `88c37a6`.
- Independent verification tag: `rollback/guard-aal1-session-projection-pre-release-20260910` at the same untouched baseline.
- Database migration history remains forward-only. Any database rollback must be a reviewed forward corrective migration that preserves audit and launch-ledger history.
