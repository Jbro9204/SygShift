# SygShift Change Log — Identity Verification and FIDO Workflow Repair

**Date:** 09/01/2026  
**Area:** Account Security / Licensing Center / Protected Documents  
**Status:** Validated and ready for production rollout

## Outcome

Protected Licensing Center actions now open one clear identity-verification dialog instead of returning a technical dead-end. The dialog automatically discovers the signed-in employee's available methods, offers a registered FIDO2 security key first when one exists, and retains the enrolled authenticator as the fallback.

After successful verification, SygShift resumes the pending document list, upload, preview, or download action. A selected upload file, its idempotency key, and a preview/download business reason remain in place while verification is completed.

The account-security checkpoint now completes security-key discovery before presenting MFA choices. Jordan's existing registered key remains intact and does not require re-enrollment. If key discovery is temporarily unavailable, the screen reports that condition, provides a retry control, and keeps authenticator verification available instead of silently omitting the key or signing the user out.

## Security preserved

- Password authentication remains required before either MFA method.
- Protected Licensing documents still require an exact effective Licensing permission and MFA verified within the existing 15-minute window.
- Remembered-device status alone still cannot satisfy the recent-document verification boundary.
- FIDO verification uses the existing one-time WebAuthn challenge and session-bound opaque token; no credential material is exposed to the browser.
- Authenticator verification refreshes the Supabase session before the protected action is retried.
- Adding, renaming, or removing security keys still requires a fresh raw authenticator AAL2 session. A registered key cannot authorize changes to itself.
- Preview and download still require a written business reason and create the established append-only audit evidence.
- No employee, credential, document, permission, account, or security-key record was changed by this release.

## Interface and recovery behavior

- Added a professional responsive **Verify your identity** modal with a plain-language explanation of why verification is required.
- Registered-key users receive a prominent **Verify with security key** action and a visible authenticator fallback.
- Employees without a registered key receive the six-digit authenticator flow directly.
- The modal explains that verification remains valid for 15 minutes and that the pending file/action is preserved.
- A method-loading failure is recoverable and never weakens the server-side authorization requirement.
- Security-key management mode explicitly explains why authenticator verification is required before changing registered keys.

## Validation

- Targeted identity, account-security, Licensing workflow, and FIDO guard tests passed: 4 files / 22 tests.
- Full validation passed: type checking, zero-warning lint, 140 test files / 685 tests, and Worker/client production builds.
- Responsive rendered checks passed for the identity dialog and Licensing document workspace in light and dark modes across desktop and mobile.
- Production rollout and live health verification are recorded below after deployment.

## Production rollout

Pending deployment.
