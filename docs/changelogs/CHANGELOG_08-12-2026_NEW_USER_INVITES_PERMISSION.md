# SygShift Change Log — New User Invites Permission

Date: 08/12/2026

## Summary

SygShift now has a separate, configurable permission for sending employee Welcome and Login Instructions emails. Email delivery is no longer inherited from the broader login-account management permission.

## Permission behavior

- Added **New User Invites** with permission code `admin.users.invite`.
- The permission is assignable to a custom role or directly to an individual employee.
- The permission requires MFA.
- The protected Admin role receives it by default.
- An individual deny removes invitation-email access even from an employee whose base app role is Admin.

## Users & Access workflow

- Added a dedicated **New user invites** card to the employee management dialog.
- The card contains:
  - **Email login instructions**
  - **Send welcome email**
- Added **Send new user invites** as the protected batch action for employees who need accounts.
- Employees with only New User Invites access can open Users & Access, select an employee, and use the invitation workflow.
- Login creation, password resets, account enable/disable, MFA resets, and remembered-device revocation remain under **Manage Login Access**.

## Server enforcement

- The Cloudflare Worker checks the effective `admin.users.invite` permission before any invitation email work begins.
- The check covers individual welcome emails, individual login-instruction emails, and batch invitation delivery.
- Direct calls without the permission receive HTTP 403.
- MFA is required before the permission appears in the effective session and before the Worker accepts the request.

## Database

- Added the permission to the production permission catalog.
- Granted it to the system Admin role.
- Updated the Users & Access directory boundary to recognize the new permission.
- Applied migration `20260812133000_new_user_invites_permission.sql`.

## Verification

- Focused permission and Worker checks: 27 tests passed.
- Full regression suite: 41 test files and 199 tests passed.
- Type checking: passed.
- Lint: passed.
- Production build: passed.
- Cloudflare startup analysis: passed with the current Wrangler runtime.
- Production deployment: `2fb56772-a659-4c83-bf52-83f80f03a536`.
