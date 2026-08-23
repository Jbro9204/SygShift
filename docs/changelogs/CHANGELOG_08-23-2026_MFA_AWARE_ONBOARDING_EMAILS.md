# SygShift MFA-Aware Onboarding Emails

Date: 08/23/2026

## Outcome

SygShift now uses the approved permanent Welcome email and automatically selects the correct Login Instructions for each employee. Welcome and Login Instructions remain separate, and standard and MFA login instructions are mutually exclusive.

## What changed

- Replaced the older testing/rollout Welcome copy with a clear description of Schedule, Time, Time-Off, coverage, and announcement tools.
- Updated the Welcome signature to:
  - Jordan Brown
  - IT and Business Development Engineer
  - Guardianship Security
- Added standard Login Instructions for employees whose effective access does not require MFA.
- Added MFA Login Instructions for employees whose effective access requires MFA.
- The MFA version prominently explains:
  - Install Microsoft Authenticator or Google Authenticator.
  - The six-digit code appears in the authenticator app, not in email or SMS.
  - Scan the SygShift QR code from inside the authenticator app, not with the regular camera.
  - Use the phone's app switcher when completing setup on one device.
- Added explanatory text in Users & Access so invitation managers know SygShift selects the correct instructions automatically.

## MFA decision source

The email selection does not rely on a second hardcoded role list. It uses the same effective-access inputs as the SygShift session:

- the employee's active base system role;
- active custom access roles assigned to that employee; and
- active person-specific grants for MFA-sensitive permissions.

This means a custom role or individual permission change automatically affects future Login Instructions.

## Preserved controls

- Sending still requires effective `admin.users.invite` permission and an MFA-verified sender session.
- Login delivery is checked before account creation or temporary-password reset.
- Personal email remains preferred, and `@guardianshipsecurity.net` delivery remains blocked at both database selection and Worker delivery boundaries.
- Temporary passwords remain one-time onboarding credentials and are never stored in product documentation or source.
- All messages continue to use the approved SygShift branded email shell.

## Validation

- Full release validation passed: type checking, lint, 65 test files / 333 tests, and the production build.
- Applied targeted production migration `20260823200000_mfa_aware_onboarding_email_targets.sql`.
- Verified all three production database functions and their expected return types after installation.
- Deployed Cloudflare Worker version `38c0aa11-dbb2-4dbf-91ef-4d48e7cc1b43`.
- Live production health returned `ok`, readiness returned `ready`, and the login route returned HTTP 200 with the SygShift application shell.
- No employee onboarding messages were sent during release validation.
