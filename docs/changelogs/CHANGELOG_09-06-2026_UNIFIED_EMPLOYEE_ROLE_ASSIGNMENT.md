# Unified Employee Role Assignment

Date: 09/06/2026
Area: Administration / User Accounts
Status: Isolated release verification passed; production deployment pending

## Outcome

User Accounts > Manage User now presents one searchable **Roles** list instead of separate Workforce Role and specialized-access controls. Every available role appears once. Multiple roles remain supported, selected roles appear first, and the operational role that supplies scheduling and timekeeping defaults is identified in the same list.

## Safety and data preservation

- The database authorization model and existing role RPCs are unchanged.
- Profile-only saves omit access-role IDs and therefore preserve existing memberships exactly.
- Role additions and removals require a review step before submission.
- Removing the last operational role is blocked; the system never silently assigns Guard or another hidden replacement.
- Individual permission grants and denials, MFA enrollment, schedules, punches, payroll, history, and audit evidence are not rewritten.
- When the complete role library is unavailable, role controls remain unavailable while unrelated permitted profile changes can still be saved without touching memberships.
- No production employee account was modified during testing.

## Interface behavior

- One searchable role checklist with selected roles first.
- Clear role descriptions, MFA indicators, and scheduling-default label.
- Compact scroll region with consistent padding rather than an excessively tall modal.
- Explicit control for choosing the scheduling default when more than one operational role is selected.
- Confirmation summarizes added roles, removed roles, the scheduling default, and MFA impact.
- Light and dark mode, desktop and mobile layouts use the existing SygShift design system.

## Verification

- Role selection and serialization tests cover no-op/profile-only preservation, addition, removal, cancellation, operational-role replacement, department-only rejection, unavailable assignments, limited editors, and Admin transitions.
- Actual EmployeeForm tests cover normal save, atomic access-role RPC selection, protected-server denial, loading state, failed catalog behavior, and late-arriving catalog data.
- Rendered Playwright checks cover light and dark themes on desktop and mobile, live search/selection/confirmation, accessibility, and horizontal containment.
- `pnpm check` passed: 183 test files and 901 tests, plus type checking, lint, and production compilation.
- The required Time & Attendance and role-interface browser gate passed all 44 desktop/mobile checks.

## Database and deployment

- Migration: None.
- Production role/data mutations: None.
- Deployment: Pending production build and Cloudflare release.
