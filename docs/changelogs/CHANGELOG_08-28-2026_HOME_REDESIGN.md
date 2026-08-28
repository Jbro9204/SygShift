# SygShift Release — Role-Aware Home Redesign

**Release date:** 08/28/2026

**Production URL:** https://app.sygilant.us

**Cloudflare version:** `4928a460-05bc-4d06-80cf-a8ecb38f5b37`

**Rollback commit:** `dffac10`

## Outcome

SygShift now opens to a focused Home experience based on the signed-in employee's primary role and effective permissions. Employees see their workday and personal actions first. Administrators and Supervisors see a concise operational command view while retaining their own schedule, time, and request tools.

## Employee Home

- Uses the employee's preferred name when available and falls back safely to their legal first name or username.
- Shows a Mountain Time-aware greeting and current work status.
- Reuses the production timekeeping service for clock-in, clock-out, start-break, and end-break actions.
- Keeps the employee's next shift, personal schedule, time-card access, time-change request, time-off request, shift pool, and call-off workflow easy to reach.
- Shows an eligible opportunity only when one exists.
- Limits normal Home announcements to three concise items so the page does not become a feed of operational noise.
- Keeps company-wide urgent notices in the global banner without repeating them inside the Home announcement card.

## Operations Home

- Applies to the Administrator and Supervisor primary roles, including custom access calculated through SygShift's existing effective-permission system.
- Presents permission-filtered operational metrics for payroll readiness, currently clocked-in staff, current coverage, time-off requests, and pending time corrections.
- Includes a bounded priority queue so the landing page remains actionable instead of becoming another full work list.
- Shows today's coverage summary and no more than three priority coverage gaps.
- Exposes operational workspace links only when the user's effective permissions allow the destination route.
- Retains personal clock, break, schedule, time-off, and call-off controls for operational employees.

## Navigation and communication

- Moved **Time-Off Requests** from Workforce into **HR & Finance** to match the approved information architecture.
- Kept sidebar and direct-route access governed by the existing route-permission system.
- Separated urgent global notices from normal Home announcements to prevent duplicate messages.

## Shared logic and services

- Added `src/pages/homeModel.ts` for deterministic Home-role selection, greetings, Sunday week boundaries, bounded previews, and coverage summaries.
- Reused the existing session, effective-permission, route-access, timekeeping, schedule, request, announcement, and payroll services.
- No replacement authentication, scheduling, payroll, or timekeeping engine was introduced.
- No production database records or role assignments were changed by this release.

## Permissions and security

- Primary role selects the default Home composition; effective permissions determine every protected metric, link, and workspace action.
- Custom roles and individual grants or denials continue to flow through the existing effective-permission calculation.
- Guards retain their personal Home experience and do not receive company-wide schedule, payroll, user-account, or administrative controls unless separately authorized.
- Administrators and Supervisors retain their existing access; this release does not rewrite role memberships.

## Responsive and accessibility work

- Added dedicated desktop, tablet, narrow-mobile, and small-phone layouts.
- Prevented action rows, metric cards, and Home modules from overlapping or forcing unreadable text.
- Kept touch targets, visible focus behavior, semantic buttons and links, readable labels, and status messages.
- Avoided decorative text shadows and dense decorative effects that reduce legibility.

## Regression protection

- Added `src/pages/homeModel.test.ts` for role mapping, greeting fallbacks, Sunday week boundaries, preview limits, and coverage summaries.
- Added `src/homeRedesignGuard.test.ts` for employee/operations composition, permission filtering, personal controls, time-clock states, canonical actions, responsive layouts, announcement separation, and navigation placement.
- Updated existing application and employee-overview guards to reflect the approved Home behavior.

## Validation

- Type checking passed.
- Linting passed.
- The complete automated suite passed: 93 test files and 472 tests.
- The production Vite build passed.
- Wrangler dry-run validation passed using the production Worker configuration.
- The committed release was pushed to `main` before deployment.
- Cloudflare deployed version `4928a460-05bc-4d06-80cf-a8ecb38f5b37` to the Worker and custom domain.

## Migration result

All applicable Home actions were migrated to the new composition. No existing Home workflow was discarded or duplicated. Full operational lists remain in their established workspaces; Home intentionally provides only the concise information and actions needed to begin work.
