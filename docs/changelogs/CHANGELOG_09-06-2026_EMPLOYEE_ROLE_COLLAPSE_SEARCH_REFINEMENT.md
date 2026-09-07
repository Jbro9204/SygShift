# Employee Role Collapse and Search Refinement

Date: 09/06/2026
Area: Administration / User Accounts / Manage User
Status: Released to production and verified

## Outcome

The employee-role library is now collapsed by default so it does not occupy the Manage User form until needed. Its compact summary shows the number of assigned roles and identifies the role controlling scheduling and timekeeping. Expanding or collapsing the section does not change any assignment.

## Interface changes

- Added `Manage roles` and `Collapse roles` controls with an explicit expanded state and directional indicator.
- Preserved a compact assigned-role count and schedule/timekeeping-default summary while collapsed.
- Rounded the role search field to match SygShift forms.
- Increased the search field's left inset so its text cannot overlap the magnifying-glass icon.
- Added bottom cushion beneath MFA and scheduling-default pills.
- Kept the complete two-column desktop and single-column mobile role-card layouts when expanded.
- Automatically expands the section when role validation needs the administrator's attention.

## Safety

- No role IDs, assignments, permissions, MFA rules, employee records, schedules, time records, Worker code, or database objects changed.
- No database migration is included.
- Collapsing and expanding are presentation-only actions and never submit the employee form.

## Verification

- `pnpm check` passed type checking, lint, 183 test files, 901 tests, and production compilation.
- The required role-interface and Time & Attendance browser gate passed all 44 desktop/mobile checks.
- Collapse, reopen, selected-role summary, search, confirmation, and save behavior passed in both light and dark mode.
- Automated accessibility and horizontal-containment checks passed.
- Collapsed and expanded screenshots were inspected at desktop and mobile sizes.

## Deployment

- Released from commit `1338124` on branch `release/unified-employee-roles`.
- Cloudflare deployment ID: `0120b4f9-fa34-42de-8197-86bc221b9434`.
- Worker version: `d3b887dc-5153-4888-9701-30d5b42e2036`.
- Production health returned `ok` and readiness returned `ready` after deployment.
- The live User Accounts bundle is `UserAdminPage-CE3UVJXk.js` and contains the new compact summary, `Manage roles`, and `Collapse roles` interface.
