# SygShift Release — Account Photo and Password Recovery

**Release date:** 08/27/2026  
**Production Worker version:** `cef37565-5659-41e0-a559-6f1e28373cd6`

## My Account photo editor

- Rebuilt the profile-photo workspace so the full selected image is visible before cropping.
- Added direct drag-to-position controls, one clear zoom control, and a reset-framing action.
- Added separate current-photo and new-photo previews so users can confirm the change before saving.
- Kept save, cancel, replace, and remove actions compact and consistent with the rest of SygShift.
- Improved responsive spacing and protected the account navigation tabs from clipping on smaller screens.

## User Accounts security controls

- Replaced temporary-password override controls with a secure **Send password reset** action.
- Password resets now use a single-use recovery link delivered only to the employee's approved non-company personal email address.
- Confirmation messages display only a masked destination address; administrators never see or generate the employee's new password.
- Kept onboarding instructions, MFA reset, trusted-device revocation, login enablement, and login disablement as separate, clearly labeled actions.
- Reorganized the security panel into account status, account actions, and a distinct danger zone.
- Added a dedicated password-recovery checkpoint that returns the employee to My Account after a successful reset.

## Security and audit controls

- Added append-only password-reset audit records containing the affected employee, acting administrator, request identifier, timestamp, and masked delivery address.
- Limited audit recording to protected server-side service operations.
- Preserved the existing approved-recipient safeguard that blocks delivery to `@guardianshipsecurity.net`.

## Database

- Applied and recorded migration `20260827170000_admin_password_reset_control.sql` in production.
- Verified the password-reset audit table and service recording function are present.

## Quality assurance

- Type checking passed.
- Lint passed with zero warnings.
- All 87 test files passed: 445 tests.
- Production build passed.
- Production health endpoint returned `ok`.
- Production readiness endpoint confirmed all required bindings are ready.

