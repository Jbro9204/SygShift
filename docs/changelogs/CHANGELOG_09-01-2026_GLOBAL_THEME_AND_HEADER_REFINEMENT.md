# Global Theme and Header Refinement

Date: 09/01/2026
Status: Released to production

## Outcome

SygShift now has one coordinated global appearance release: a complete dark theme matching the approved black, charcoal, and gold direction, plus a compact authenticated utility bar that owns appearance selection, employee identity, My Account access, and Sign Out. The existing light presentation remains available and operational workflows are unchanged.

## Theme behavior

- Light and dark appearance controls live in the single shared authenticated `AppShell` and apply across authenticated workspaces.
- The explicit selection persists in local browser storage. Without an explicit selection, SygShift starts from the operating-system preference.
- A same-origin bootstrap script applies the selected theme before React and the main stylesheet paint, preventing a bright theme flash during dark-mode startup.
- Dark mode includes the signed-out login and security surfaces in addition to authenticated pages.
- Shared tokens and restrained layered surfaces cover page backgrounds, cards, forms, tables, modals, buttons, alerts, status treatments, and supporting text without changing component or workflow behavior.
- Accessibility state uses `aria-pressed`; appearance is not communicated by color alone.

## Header refinement

- The left utility area now shows only the Mountain calendar date in the established `MM/DD/YYYY` format.
- The redundant **Mountain Time is the operational default** sentence was removed from the utility bar. Mountain remains explicitly identified by the existing **Operational default** badge in the four-clock row.
- The right utility controls appear in the approved order: Light, Dark, divider, unified employee profile/My Account control, and icon-only Sign Out.
- The profile control reuses the existing protected account source for legal name, primary role, permanent username, and current profile photo, with initials as the safe fallback.
- The existing Sign Out handler remains the only logout path.
- Four-zone clock timing, dynamic DST abbreviations, server anchoring, alert behavior, navigation, inactivity handling, and all application permissions remain unchanged.

## Responsive and accessibility behavior

- All utility actions retain at least a 44-pixel touch target while their visible circular controls remain compact.
- Role and username hide before the employee name; compact widths reduce the profile to the avatar without removing My Account access.
- The clock strip remains four columns on wider layouts and two-by-two on narrow layouts.
- Keyboard focus, tooltips, accessible labels, reduced-motion behavior, and horizontal containment are preserved.
- Automated accessibility analysis passes for the layered header in light and dark modes and for representative dark cards, controls, tables, statuses, and modals.

## Verification

- Type checking passed.
- Lint passed with zero warnings.
- 135 test files and 663 tests passed.
- Worker and client production builds passed.
- All 38 Playwright checks passed across desktop and mobile projects.
- Responsive header checks passed at 1920, 1440, 1280, 1024, 768, 390, and 320 pixels.
- Expanded and collapsed navigation, four-zone ordering, alert placement, reduced motion, theme state, dark-surface contrast, modal presentation, horizontal containment, and automated accessibility checks passed.
- No database migration was required. No employee, access, schedule, timekeeping, payroll, licensing, HR, document, or audit record changed.

## Release

- Source commit `e521e54` was pushed to `origin/main` before deployment.
- Wrangler 4.106.0 dry run passed with the existing production bindings and dormant HRIS release gates preserved.
- Cloudflare Worker version `b06bf981-bd42-4148-99d2-49be0968c254` is active on the primary custom domain and Worker fallback domain.
- Worker startup time was 32 ms.
- The primary app, login, theme bootstrap, health, and readiness endpoints returned HTTP 200.
- Readiness reported `ready: true` and confirmed the asset binding and all required Supabase configuration.
- Live production login rendering was verified in both explicit light and dark modes at 1440 pixels. Both applied the requested theme before interaction, produced zero browser console errors, and passed automated accessibility analysis with zero violations.
- An unauthenticated production request to `/users` redirected safely to `/login`.
- The live page loads the same-origin theme bootstrap before the React module. The live script contains both appearance controls and the unified profile control, omits the removed Mountain utility sentence, and the live stylesheet contains the dark tokens, profile controls, clock treatment, and responsive rules.
