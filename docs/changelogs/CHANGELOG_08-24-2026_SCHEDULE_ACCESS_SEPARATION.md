# SygShift Schedule Access Separation

Date: 08/24/2026

## Outcome

Every active employee can view their own published schedule by default. Company-wide schedule visibility is now a separate elevated permission, enforced by both the application and the production database.

## Access model

- `View own schedule` (`schedule.self.view`) is a locked baseline permission granted through every system role.
- `View all schedules` (`schedule.view`) is the elevated company-wide permission and requires MFA.
- Guards and Recruiting & Licensing employees receive only their own published assignments unless an administrator deliberately grants broader access.
- Dispatchers, Schedulers, Supervisors, and Administrators retain company-wide schedule access through their existing system roles.
- Zachary Ward receives his own schedule through the Recruiting & Licensing role. No person-specific exception was required.

## Enforcement

- The Schedule route and navigation accept either personal or company-wide schedule access.
- The Schedule page selects the personal employee view when the user lacks a team-view permission.
- The production `get_weekly_schedule_payload` database function limits personal-only users to shifts assigned to their employee record.
- Draft schedules remain limited to authorized company-wide schedule roles and permissions.
- Direct employee permission grants and all unrelated role permissions were preserved.

## Validation

- Verified the production role matrix after migration.
- Verified Zachary Ward retained his Recruiting & Licensing permissions and gained only the personal schedule baseline.
- Full release validation passed: type checking, lint, 66 test files / 337 tests, and the production build.
- Applied targeted production migration `20260824113000_schedule_self_view_permission.sql`.
- Deployed Cloudflare Worker version `cc3cecf7-a3c9-4565-a43b-ac5514bb1e8c`.
- Production API health returned `ok`; readiness returned `ready` with required assets and Supabase configuration present.

## Administrator guidance

Do not assign `View all schedules` merely so an employee can see their own shifts. Personal schedule access is automatic. Grant `View all schedules` only when the employee's duties require company-wide coverage visibility; the elevated access becomes effective only in an MFA-verified session.
