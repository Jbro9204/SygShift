# Document Studio FIDO verification recovery

Date: 09/06/2026

## Problem and root cause

Document Studio and its protected inventory displayed generic unavailable errors instead of asking for fresh identity verification. The application security-key session can remain valid after the separate 15-minute protected-document verification window expires. The database correctly rejected stale evidence, but the Worker discarded the upstream error classification and converted the expected denial into HTTP 500. The existing verification popup only responds to an explicit MFA-required HTTP 403.

Read-only production checks confirmed that both workspace functions can read the populated catalog: the Studio summary reports 537 documents and inventory pagination reports 537 records over 54 ten-record pages. The affected account had an unexpired security-key session but no verification within the document freshness window. This is not evidence of missing uploads.

## Changes

- Preserve upstream status, error code, and RPC name internally in `worker/index.ts`.
- Convert only the known security-key freshness/verification denial into `recent_document_mfa_required`. The existing popup then resumes the blocked request after successful verification.
- Keep infrastructure, configuration, permission, and authentication failures distinct; do not turn unrelated failures into repeated verification prompts.
- Log unexpected document failures using the request ID, RPC name, and status/code only. No tokens, private payloads, or upstream message text are logged.

No database migration, production data mutation, re-upload, role change, security-window extension, MFA bypass, or timekeeping change is included in this fix. The temporary bulk-import route is not used or re-enabled.

## Verification

- Reproduced both original HTTP 500 failures in new Worker runtime tests before the correction.
- Added 16 Worker boundary cases covering expired FIDO, fresh FIDO, fresh authenticator, missing verification, denied permission, unauthenticated access, and configuration/infrastructure errors.
- Added an actual-component integration test using `HrisDocumentsPage`, both real data-access functions, `IdentityVerificationHost`, and `IdentityVerificationModal`: two blocked reads open one popup, then both workspaces load after a simulated successful factor check. Transport and the physical factor are isolated test doubles, not a production login.
- `pnpm check`: passed TypeScript, zero-warning lint, 183 test files / 900 tests, and production build.
- Browser regressions: 50/50 desktop/mobile Chromium checks passed, including the actual-component Time Clock workflow and light/dark document/verification layout fixtures. Layout fixtures are not a production login test.

## Release status

Application correction prepared; production deployment and final signed-in verification pending. A successful file import alone did not establish a usable workspace, and the earlier rollout completion statement overstated live browser verification.
