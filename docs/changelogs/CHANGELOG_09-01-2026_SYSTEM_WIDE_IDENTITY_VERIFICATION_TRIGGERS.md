# SygShift Change Log — System-Wide Identity Verification Triggers

**Date:** 09/01/2026  
**Area:** Protected HR / Administration / Operations / Time & Attendance  
**Status:** Production release complete

## Outcome

Protected SygShift actions no longer stop at an alert telling the employee to verify their identity. When the server returns an explicit MFA-required response, the application opens one shared identity-verification checkpoint, offers the employee's registered FIDO2 security key first when available, retains the authenticator as a fallback, and automatically retries the original action after verification succeeds.

The trigger covers the full Worker-backed HR suite, including Employee File compensation, documents, document workflows, onboarding, recruiting, leave, benefits, compensation, talent, learning, cases, safety, assets, offboarding, self-service, reporting, payroll-integration controls, and HR automation. It also covers protected Worker-backed User Administration actions, notification processing, and attendance reporting. The existing Licensing document workflow continues to use the same verification modal with Licensing-specific wording and preserved file/action state.

## User experience

- The verification checkpoint appears automatically; the employee does not have to leave the screen and find an unrelated Security page.
- One checkpoint coordinates concurrent protected requests so multiple cards cannot create a stack of competing MFA dialogs.
- Successful FIDO or authenticator verification resumes the blocked request with a freshly built access token and assurance headers.
- Current page state and entered form information remain in place during verification.
- The checkpoint explains the existing 15-minute recent-verification window.
- If the employee chooses **Not now**, the server denial remains enforced. The Compensation card keeps an explicit **Verify and retry** action so the employee is not left at a dead end.
- Document uploads preserve the selected file and idempotency key, then safely retry after verification without publishing a duplicate document.

## Security preserved

- Only explicit `*_mfa_required` and `recent_document_mfa_required` server responses may open the checkpoint.
- Authentication failures, missing permissions, and unrelated authorization denials are never converted into a verification retry and remain blocked.
- The original protected request is retried only once after successful verification.
- Request credentials and protected-session headers are rebuilt after verification instead of reusing stale assurance.
- Registered FIDO keys continue to use a one-time WebAuthn challenge and a session-bound opaque assurance token.
- Authenticator verification continues to refresh the Supabase session at AAL2.
- Adding, renaming, or removing a security key still requires raw authenticator AAL2 and cannot be authorized by the key being managed.
- No employee, HR, compensation, document, account, permission, schedule, time, or security-key record was changed by this release.
- No database migration was required.

## Validation

- Full validation passed: type checking, zero-warning lint, 142 test files / 693 tests, and Worker/client production builds.
- All 52 responsive browser checks passed in desktop and mobile Chromium, including protected identity verification in light and dark modes.
- Added focused coordinator tests for trigger recognition, successful verification and retry, cancellation behavior, shared application hosting, protected-service coverage, and the Compensation fallback action.

## Production rollout

- Pushed validated commit `f3552b6` to `main`.
- Deployed Cloudflare Worker version `7ba88d1a-a665-4334-b979-e7bbc5c2e8c6` with the existing production variables preserved.
- Primary and fallback login, health, and readiness checks returned HTTP `200`.
- The live application bundle contains the shared protected-access checkpoint, automatic action-resume copy, and FIDO verification action.
- Unauthenticated Employee File Compensation and User Administration Security Keys route checks returned HTTP `401`, confirming the server boundary remains enforced.
- No database migration, record mutation, or permission change was part of this release.
