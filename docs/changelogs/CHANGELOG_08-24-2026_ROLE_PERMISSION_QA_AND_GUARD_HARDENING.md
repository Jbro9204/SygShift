# SygShift Role and Permission QA and Guard Hardening

Date: 08/24/2026

## Outcome

Completed a production role-and-permission QA across the application, Worker/database authorization boundaries, and all active employee assignments. Guards now have a fixed self-service-only access baseline, and all existing employee roles were preserved.

## Guard access

- Guards can use Home, view their own published schedule, use and review their own time, manage their own availability and requests, view announcements intended for them, view eligible open shifts/events, and view assigned training.
- Removed team-wide time visibility and accountability-event creation from the Guard role.
- Restricted Guard database visibility to their own employee, availability, published schedule, shift, and assignment records.
- Kept company directory, team schedules, team time, payroll, reporting, sites/posts, patrol management, licensing, announcements management, Users & Access, and Roles & Permissions unavailable to Guards.

## Other role corrections

- Made the existing Scheduler and Supervisor credential-editing permission usable in the Licensing Center.
- Kept Licensing Center employee-profile management, configuration, and communication controls hidden unless the session has those separate permissions.
- Preserved every non-Guard role permission and every employee role assignment.

## Production verification

- Confirmed 47 active employees and 47 enabled employee accounts.
- Confirmed 35 Guards, 3 Dispatchers, 1 Scheduler, 5 Supervisors, 2 Admins, and 1 Recruiting & Licensing employee.
- Confirmed zero additional access-role assignments and zero active person-specific overrides.
- Impersonated live Guard, Scheduler, and Supervisor access contexts at the database boundary.
- Guard access returned only the employee's own published schedule records and rejected Licensing Center access.
- Scheduler and Supervisor credential worklists loaded with MFA while broader licensing actions remained denied.

## Quality assurance

- Added Guard least-privilege route and database-boundary regression coverage.
- Added credential-editor Licensing Center route coverage.
- Full release validation passed: type checking, lint, 68 test files / 347 tests, production build, and access-control inventory.
- Deployed Cloudflare Worker version `5d17d26a-e401-460b-8847-914bfa77281f`.
- Live custom-domain health, readiness, login-route, and static-asset checks passed.

## Database changes

- `20260824183000_guard_least_privilege_and_self_service.sql`
- `20260824190000_credential_editor_licensing_access.sql`
