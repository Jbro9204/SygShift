# Canonical Password Recovery Hardening

Date: 09/08/2026

## Outcome

SygShift's signed-out password recovery now completes through a first-party application route, and
Sygilant can request that same canonical workflow without copying employee credentials, email routing,
tokens, MFA factors, security keys, roles, or audit records.

## Changes

- Added a public `/password-recovery` application route that exchanges a single-use token hash with
  Supabase Auth and immediately removes recovery material from browser history.
- Removed raw provider action URLs from employee recovery messages.
- Recovery completion revokes the temporary recovery session and returns the employee to a full login.
- Added a dedicated Sygilant bridge secret that is used only to verify HMAC signatures.
- Bridge signatures cover a protocol version, 90-second timestamp window, nonce, one-way source
  fingerprint, and normalized username.
- Invalid or stale signed bridge requests are rejected before any identity query.
- Direct SygShift signed-out recovery remains available under the existing transactional username and
  request-source limits.

## Preservation

- No SygShift table, policy, migration, employee, punch, schedule, payroll record, message, MFA factor,
  security key, or trusted device was changed.
- The existing personal-first address rule and `guardianshipsecurity.net` provider-boundary block remain.
- The browser receives the same enumeration-safe response for eligible and ineligible usernames.
- Provider failures remain server-log and delivery-audit concerns; username and recipient values do not
  enter error responses or Worker failure logs.

## Verification

- Focused Worker boundary: 1 file / 33 tests.
- Full release gate after integration with the finalized SygSphere and communications release: 208 files /
  1,033 tests, TypeScript, zero-warning lint, and both production builds.
- Mandatory time-clock preservation suite: 38 desktop/mobile checks passed.
- Fresh production build after the browser suite: passed.

## Rollback

- Pre-change tag: `rollback/password-recovery-email-prechange-20260908`.
- First-party recovery route tag: `rollback/password-recovery-hardened-20260908`.
- Signed bridge release tag: `rollback/password-recovery-bridge-20260908`.
- Final coordinated production baseline: `rollback/password-recovery-pre-activation-20260908`.
- Final first-party route checkpoint: `rollback/password-recovery-hardened-final-20260908`.
- Final signed bridge checkpoint: `rollback/password-recovery-bridge-final-20260908`.
- Removing `SYGSHIFT_PASSWORD_RECOVERY_BRIDGE_SECRET` disables cross-platform signature acceptance while
  preserving direct SygShift recovery.

## Release Status

Application validation is complete against SygShift main `6e7ca13`. Production secret installation,
Worker deployment, and live health/recovery verification are recorded here after activation.
