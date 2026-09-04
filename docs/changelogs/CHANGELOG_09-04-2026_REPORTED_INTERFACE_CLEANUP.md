# Reported interface cleanup

Date: 09/04/2026

## Outcome

Completed the full 24-image interface review as one coordinated release. The Schedule, Action Center, Directory, Client Directory, Sites & Posts, HR employee records, Document Studio, Time Review, Payroll, Patrol, and Administration surfaces now use more deliberate spacing, clearer responsive layouts, and visible interaction state. The two reported functional issues were also repaired: Patrol Operations has a direct route, and the payroll period shortcuts visibly confirm which period is selected.

## Root causes

- The Dispatch phone-duty badge shared one flex row with the full time range and could squeeze the time down to a few characters per line in a narrow calendar column.
- Several modal form families were direct children of the shared dialog but were not included in its presentation-gutter rules.
- Action Center completion reporting inherited a generic minimum panel height intended for larger dashboard panels.
- The Time Review summary used the default three-column metric grid even though it contains four equally important metrics.
- Payroll period actions changed the dates but did not expose a persistent selected state, making **Current open period** appear inactive.
- Patrol Operations existed only as component state inside `/patrol`; a direct `/patrol/operations` visit therefore had no matching route.
- User Accounts and Roles & Permissions appeared as separate Administration menu entries even though they belong to one access-management area.

## What changed

- Rebuilt the Dispatch card heading as a compact two-row grid so the time retains the available width and the Dispatch label wraps intentionally.
- Added shared responsive modal gutters for Client Contacts, Link Existing Site, Client document uploads, Employee Record and Employment editors, supervisor assignment, employment dates, contact/emergency details, pay-rate dialogs, and Document Studio creation/signature/policy forms.
- Retained and verified the already purpose-padded Missing Clock-In, MFA identity verification, Sites & Posts management, and HRIS Employment Dates dialogs; their surrounding actions and mobile widths now align with the same presentation system.
- Increased Add Shift/Event form rhythm without changing the Scheduler workflow or data.
- Changed Review Queue to a balanced four-column desktop summary, two columns at constrained widths, and one column on phones.
- Removed Action Center's inherited empty vertical space and presented its three completion totals as compact report cards.
- Made Directory profile snapshot cards auto-fit at readable widths and protected long email text from character-by-character wrapping.
- Refined the Client Directory search shell, Site management gutters, role-library scrollbar clearance, HR Previous/Next controls, Payroll Status and blocker actions, and responsive full-width action treatment.
- Added selected-state styling and `aria-pressed` semantics to **Last completed pay period** and **Current open period** in both Payroll and Time Review.
- Added protected `/patrol/:patrolTab` routing and URL-backed Patrol tabs, including `/patrol/operations`, while preserving each tab's existing permission checks.
- Consolidated the Administration sidebar into one **Users & Roles** destination. Its landing page exposes User Accounts and/or Roles & Permissions only when the signed-in user has the corresponding existing permission; the protected workspaces remain separate behind it.

## Files changed

- `src/App.css`
- `src/app/RouteElements.tsx`
- `src/app/accessPolicy.ts`
- `src/app/accessPolicy.test.ts`
- `src/app/navigation.ts`
- `src/app/router.tsx`
- `src/pages/AdministrationAccessPage.tsx`
- `src/pages/PatrolPage.tsx`
- `src/pages/SchedulePage.tsx`
- `src/time/TimeExceptionsPage.tsx`
- `src/time/TimePayrollPage.tsx`
- `src/reportedInterfaceCleanupGuard.test.ts`
- `tests/e2e/reported-interface-cleanup.spec.ts`

## Verification

- Focused source and access-policy validation passed: 2 files / 17 tests.
- Focused affected-surface browser validation passed: 20 desktop/mobile checks.
- Rendered desktop and phone inspection confirmed readable Dispatch time, balanced report and review cards, visible payroll selection, consistent modal gutters, responsive Users & Roles cards, and no page-level horizontal overflow.
- Full `pnpm check` passed: TypeScript, zero-warning application lint, 164 test files / 792 tests, and both production builds.
- Full Playwright validation passed: 110 desktop/mobile checks.

## Data, migration, and access status

- No database migration was required.
- No employee, client, site, post, schedule, assignment, patrol, punch, payroll, role, permission, document, or audit record was changed.
- Existing direct User Accounts and Roles & Permissions routes remain protected by their exact permissions. The consolidated landing page does not grant or combine authority.

## Git and deployment status

- Implementation commit `4fde2dc` was pushed to `origin/main`.
- Cloudflare Worker version `0233b737-e319-49d1-b13b-6fc927cc2d69` was deployed to the primary custom domain and Worker fallback.
- Primary and fallback health/readiness returned HTTP 200 and reported ready.
- Direct `/patrol/operations` and `/administration/access` requests returned HTTP 200.
- Cache-busted deployed-asset inspection confirmed the Dispatch layout rule, compact Action Center reporting, the new Administration route, and parameterized Patrol routing.

## Remaining scope

- This release addresses the reported presentation and routing defects. It does not change payroll calculations, timekeeping authority, role definitions, or any underlying business records.
