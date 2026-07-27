# SygShift Dev Changelog — 07/27/2026

## Update: Active Directory Style Roles & Permissions

### What changed

- Added a full access-control foundation in Supabase:
  - Permission catalog with 41 named permissions.
  - Baseline system roles for Guard, Dispatcher, Scheduler, Recruiting & Licensing, Supervisor, and Admin.
  - Custom role support for Admin-created roles.
  - Extra employee role memberships.
  - Per-person permission grants and denies.
  - Effective permission calculation.
  - Audit logging for role, permission, assignment, and override changes.

- Added a new Administration page:
  - `Roles & Permissions`
  - Role library.
  - Permission matrix.
  - Custom role creation.
  - Employee role assignment panel.
  - Individual grant/deny override workflow.
  - Effective permissions preview.

- Updated session security context:
  - `get_session_context()` now returns effective permissions for the signed-in user.
  - MFA remains required for sensitive, critical, and administrative access.
  - Trusted device behavior still flows through `public.has_mfa()`.

- Updated navigation and route protection:
  - Sidebar items can now be shown by effective permission.
  - Existing role checks remain as a safe fallback while the rest of the app is progressively moved to permission-based checks.

### Important behavior

- Primary employee role still exists and remains the baseline access group.
- Custom roles are layered on top of that baseline.
- Individual grants add permissions directly to a person.
- Individual denies remove permissions directly from a person.
- Denies win over grants.
- Protected Admin safety permissions cannot be removed from the protected Admin role.
- A user cannot deny their own critical Admin security permissions.
- Every person-specific override requires an audit reason.

### QA completed

- TypeScript check passed.
- Lint check passed.
- Unit test suite passed: 23 files, 79 tests.
- Production build passed.
- Supabase migration applied successfully.
- Supabase schema cache refreshed.
- Database verification confirmed:
  - 41 permissions.
  - 6 baseline system roles.

### Production note

This update introduces the access-control foundation and the Admin GUI for managing it. Some older operational RPCs still contain legacy hardcoded role checks for safety. Navigation and new access-control surfaces now understand effective permissions; remaining module-level backend checks should be migrated carefully as each module is touched so we do not accidentally loosen production security.
