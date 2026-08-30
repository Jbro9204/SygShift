# SygShift Change Log — 08/30/2026

## HRIS Stage 9: Offboarding, Self-Service, and Reporting

### Delivered

- Added protected separation and rehire case foundations with explicit approval, preserved employment history, append-only events, and auditable downstream tasks.
- Added coordinated offboarding handoffs for User Accounts, Schedule, Payroll, Licensing, documents, training, and assets without replacing those authoritative systems.
- Added employee and manager HR self-service foundations scoped to the signed-in employee and effective permissions.
- Added permission-aware report definitions, scheduled reports, asynchronous export runs, and append-only report history.
- Added compact, permission-aware workspaces for Offboarding & Rehire, HR Self-Service, and HR Reporting using bounded 5/10/20 worklists.

### Security and release controls

- Added nine exact permissions without assigning any permission to a current role or employee.
- Added independent database and Worker release gates for all three Stage 9 modules; every gate remains disabled.
- Required recent MFA for Offboarding & Rehire and HR Reporting at both the Worker and database boundaries.
- Kept protected records behind row-level security, browser-role revocation, service-only access, and append-only event history.
- Preserved Schedule, Payroll, Licensing, documents, training, assets, User Accounts, and existing employee access as the authoritative downstream systems.

### Production state

- Production migration: `20260831160000_hris_stage9_offboarding_self_service_reporting_foundation.sql` applied and recorded.
- Cloudflare Worker version: `ed79e5e6-1f9d-4ab6-a148-92b93d3e81db`.
- Production verification confirmed all three release gates are disabled, all nine permissions are unassigned, no individual override exists, and every Stage 9 business workspace contains zero records.
- Existing employee, account, role-assignment, schedule, and time-event records were preserved by the database release.
- Local validation passed: Stage 9 contract validator, type checking, zero-warning linting, 117 test files / 589 tests, Worker build, client production build, and Git whitespace validation.
- Live health and readiness returned `200`, and the production login surface returned `200`.

### Activation boundary

Stage 9 is structurally complete but intentionally dormant. Activation is a separate controlled release requiring approved operating policies, named access owners, minimum permission assignment, recovery evidence, an isolated canary, and post-activation verification. Stage 10 remains responsible for controlled HR-to-Payroll integration and enterprise hardening.
