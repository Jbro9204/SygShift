# SygShift Change Log — Admin MFA Reset and Users & Access Layout

Date: 08/10/2026

## Summary

SygShift now provides a controlled administrative workflow for resetting an employee's authenticator enrollment. The Users & Access filter and action area was also reorganized so controls remain readable, aligned, and contained within the workspace at supported screen sizes.

## Administrative MFA reset

- Added **Reset MFA setup** to the employee management dialog for authorized administrators.
- Added an explicit confirmation step that explains exactly what will and will not change.
- Reset removes the employee's authenticator factors and revokes remembered-device records.
- Reset does not change the employee's password, profile, employment record, or operational history.
- The employee must enroll a new authenticator the next time protected account setup is required.
- The reset endpoint remains behind the existing administrator permission and verified-MFA boundary.
- Every reset records the operator, target employee, request ID, reset time, removed-factor count, and revoked-device count in protected append-only history.

## Matthew Swinney account

- Removed Matthew Swinney's existing authenticator factor.
- Verified that zero authenticator factors remain after the reset.
- Preserved his existing password and employee account.
- No remembered-device records were active on his account.

## Users & Access layout

- Moved page actions to a dedicated responsive action row beneath search and filters.
- Increased usable filter widths so selected values are not clipped.
- Added wrapping and small-screen rules that keep every button inside the panel.
- Preserved the existing button system and visual hierarchy.

## Database and security

- Added `private.employee_mfa_reset_events` as append-only protected history.
- Added service-only reset recording and trusted-device revocation.
- Applied migration `20260810154500_admin_mfa_reset_control.sql` to production.
- Kept all new service routines unavailable to public, anonymous, and ordinary authenticated clients.

## Quality assurance

- TypeScript, lint, unit, integration, and production build checks passed.
- 38 test files and 181 automated tests passed.
- 18 Playwright desktop and mobile browser tests passed, including a rendered Users & Access containment check at both viewport classes.
- Added regression coverage for authorization, factor removal, audit recording, responsive toolbar layout, and explicit confirmation behavior.

## Release

- Production database migration applied and verified.
- Cloudflare Worker version: `6b404868-4a68-4e15-a845-84b834287094`.
- Production health: `ok`.
- Production readiness: `ready`.
- Unauthenticated calls to the MFA reset endpoint are rejected with HTTP 401.
