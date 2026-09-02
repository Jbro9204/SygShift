# HR Termination and Complete User Role Assignment

Date: 09/02/2026

## Outcome

Authorized HR users can now terminate an employee directly from the employee's authoritative HR Employee File. User Accounts now loads the complete active Roles & Permissions library when an administrator creates or edits an employee, so current custom roles such as Human Resources Employee, Human Resources Manager, and Operations Manager are available alongside the built-in roles.

## HR termination workflow

- Added a visible **Terminate employment** action to eligible active Employee Files.
- Requires an effective separation date, a meaningful reason, and the employee's exact username as destructive confirmation.
- Reuses the protected account-separation engine already used by User Accounts.
- Immediately marks the employee separated, disables sign-in, revokes remembered devices, resolves future assignments and pending shift requests, and records immutable audit/separation evidence.
- Preserves historical employee, schedule, timekeeping, payroll, and account records.
- Prevents self-termination and prevents a non-Admin HR user from terminating an Admin.
- Requires recent MFA plus the exact HR people-management and offboarding-approval permissions on the server.

## Complete role selection

- Replaced the six-role UI assumption with the live active role library from Roles & Permissions.
- Kept the existing primary account role for compatibility and added a compact, scrollable **Additional access roles** selector.
- New and edited employee records save selected access-role memberships atomically with the employee update.
- The primary inherited role cannot be duplicated as an additional membership.
- Role membership changes are permission-checked, audited, and protected by recent MFA.
- If the role library cannot load, employee profile changes preserve existing memberships instead of silently clearing them.

## Database and security

- Applied forward-only migration `20260902222001_hr_employee_termination_and_user_role_assignment.sql`.
- Public and anonymous execution is revoked from the new routines; only authenticated callers can enter the server-side permission boundary.
- All new security-definer routines use an empty `search_path` and fully qualified objects.
- The linked rollback rehearsal created an employee, assigned Human Resources Manager, terminated the employee through the HR boundary, verified evidence, and rolled the entire rehearsal back.
- Production verification confirmed the migration marker, zero rehearsal records, and a live HR Manager result of `canTerminate = true`.

## Verification

- Full repository gate passed: TypeScript, zero-warning lint, 153 test files / 741 tests, and Worker/client production builds.
- All 92 desktop/mobile Chromium Playwright checks passed.
- Desktop and mobile role-selector and termination-dialog layouts passed containment and accessibility checks.
- Production health and readiness returned HTTP 200 on both `app.sygilant.us` and the Worker endpoint.
- The deployed User Accounts and HR Employee File assets returned HTTP 200 and contain the new controls.

## Release status

- Git implementation commit: `33d7cae` pushed to `origin/main`.
- Database migration: `20260902222001` applied and recorded.
- Cloudflare Worker version: `b6718bb1-20ef-462a-bcec-80aaf79a18a8` deployed.
