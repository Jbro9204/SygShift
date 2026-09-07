# Role Library and Patrol Operations Repair

Date: 09/07/2026

## Changes

- Repaired the Roles & Permissions library so every role card retains its own permission and employee-count badges. Cards now use content-sized grid rows, consistent internal spacing, a cushioned scroll gutter, and clear separation from the Create role action.
- Corrected the Manage Employee role search field so the search icon and entered text cannot overlap inside the shared modal styling.
- Added dependable lower spacing beneath MFA-required badges and prevented role rows from being compressed by their scroll grid on desktop or mobile.
- Repaired the Patrol workspace date/time formatter. The former `Intl.DateTimeFormat` option combination was invalid and could crash the Operations experience before it rendered.
- Made Patrol schedule linking identify both the shift and the assigned employee. Two employees attached to the same shift can no longer resolve to the wrong person.
- Replaced the blanket “In progress” label with schedule- and requirement-aware states: Scheduled, In progress, Completed, Needs review, and No requirements. Added an Operations status filter.
- Enforced existing Patrol capabilities in the interface. View-only Operations users can review assignments and exception status but do not receive route-linking or makeup-assignment controls.

## Scope protection

- No database migration was required.
- No employee, role membership, permission, shift, punch, payroll, patrol assignment, route, hit, or evidence record was changed.
- Existing role assignments and permission calculations remain unchanged; this release corrects presentation, selection identity, truthful status display, and capability-bound controls.

## Validation and release status

- `pnpm check` passed: type checking, zero-warning lint, 189 test files / 931 tests, and the production build.
- Targeted real-component Patrol tests cover the actual page formatter, duplicate shift IDs across different employees, all five operational states, and view-only capability boundaries.
- Fourteen desktop/mobile light/dark browser checks passed for the Role Library, Manage Employee role assignment, sensitive permission review, and Patrol layout.
- All 38 required desktop/mobile Time Clock workflow checks passed without changes to timekeeping behavior.
- Release commit `8db9e0e` was pushed to `origin/main` and deployed as Cloudflare Worker version `18e0cfd5-6db7-4fda-ae9d-51805d6bdcad`.
- Production health and readiness returned HTTP 200 / ready. The live main JavaScript, global stylesheet, and Patrol page bundle match the tested release files byte-for-byte by SHA-256; the live Patrol bundle contains the new status filter and state labels.
- The available browser session was signed out at `/login`, so no authenticated production data or workflow was altered for a visual walkthrough. Actual component behavior and authenticated boundaries are covered by the automated Patrol tests and existing data-layer contracts.
