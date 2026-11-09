# Password-change foundation — November 9, 2026

Status: local implementation only. Not deployed, not activated, and not ready for company-wide enrollment.

## Changes

- Added default-off, auditable Admin previews and exact-count, all-or-nothing password-change requirements.
- Requirements apply to new Auth sessions at or after the selected activation time; they do not set the legacy global onboarding flag or revoke existing sessions.
- Added request listing and cancellation without removing history.
- Added private append-only records of actual Auth credential-field transitions. No password or credential hash is stored in those records.
- Added versioned `mark_password_changed_verified()`; legacy completion delegates to the verified function after migration.
- Updated SygShift password completion to use the versioned function and fail closed if it is unavailable.
- Preserved successful lost-response retry handling only when the server verifies the earlier change. An unchanged password without proof does not satisfy the requirement.
- Preserved ordinary Guard MFA policy, roles, source employee records, and operational data.
- Final pre-release review caught and corrected a draft permission-projection regression. The migration now preserves the read-only verified installed function's active-employee filter, narrow ordinary-Guard app-launch exemptions, privileged-profile MFA requirements and explicit permission denials.

## Ownership and order

1. SygShift: `20261109154616_password_change_requirements_and_verified_completion.sql`.
2. Sygilant: `20261109155422_password_change_session_projection.sql`.

The latter migration owns the existing cross-application session projection and depends on the former's new private helper. The Sygilant scheduled-recovery work is documented separately.

## Local verification

- Focused AccountSecurityPage: 12 tests passed with Node.js 24.19.0.
- Required desktop/mobile Time Clock regression: 42 tests passed.
- Isolated PostgreSQL regression covers default-off installation, exact selection, Admin verification, idempotency, old/new sessions, credential proof, onboarding, inactive exclusions, cancellation and preserved roles/sessions.
- Full pinned-toolchain `pnpm check` passed: TypeScript, zero-warning lint, 2,533 application tests passed (one intentional skip), 216 release-tool tests passed (one intentional skip), production build, and static-asset contract.
- Isolated PostgreSQL testing loaded both owning migrations and passed ten scenario groups, including ordinary Guard AAL1 app launches, privileged Guard MFA, unrelated protected permissions, direct denials and inactive employee filtering. This is synthetic local evidence; no production verification is claimed.

## Activation blocker and remaining work

A read-only November 9 policy review confirmed an owner-only direct Data API path on employee availability that does not use the effective-permission check. Company-wide activation remains blocked pending the installed-policy/RPC audit and negative boundary tests described in `docs/security/PASSWORD_CHANGE_CAMPAIGN_ACTIVATION_GATE.md`.

No emails, passwords, account activation states, payroll, schedules, or employee permissions were changed in production. No company-wide campaign was started.

## Rollback

Keep the campaign flag off. Preserve receipt/request history and the verified completion path when rolling back UI. Never restore older weak completion as a fallback. A deployment requires the owning repositories' normal migration, quality, canary and release gates.

