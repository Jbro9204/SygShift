# Unified Syg Platform Launchers

**Released:** September 9, 2026  
**Status:** Production

## Outcome

The SygTasks, Sygilant, and SygSphere launchers in the shared SygShift sidebar now use one consistent component treatment in expanded and collapsed navigation. Their routes, secure handoff behavior, loading states, unread state, and active-state behavior were preserved.

## Visual system

- Centralized launcher styling in `src/styles/platform-launchers.css`.
- Standardized expanded controls at 64 pixels high and collapsed controls at 48 by 48 pixels.
- Standardized internal padding, corner radius, border weight, depth, hover lift, pressed state, keyboard focus, icon frame, typography, and subtitle alignment.
- Matched the SygTasks and SygSphere metallic-gold palette exactly.
- Preserved Sygilant's distinct champagne-gold identity while applying the same dimensions and interaction treatment.
- Optically balanced all three logos in both navigation modes.
- Kept the SygSphere unread badge and Sygilant loading indicator as non-shifting overlays.

## Behavior and security preserved

- SygTasks continues to open the existing `/tasks` route and indicate its active state.
- Sygilant continues to use the existing authenticated secure-handoff workflow.
- SygSphere continues to open the existing `/sygsphere` route and display unread counts.
- Existing accessible names, keyboard navigation, tooltips, error fallback, permissions, and session behavior remain unchanged.
- No database schema, Worker endpoint, permission, or operational workflow was changed.

## Verification

- `pnpm check`: passed — 226 test files and 1,133 tests, TypeScript, zero-warning lint, Worker build, and client production build.
- Platform-launcher browser suite: passed — 12 of 12 Chromium checks and 6 of 6 Firefox checks, including expanded, collapsed, responsive, 200-percent effective viewport, keyboard, and accessibility coverage.
- Required Time Clock browser suite: passed — 42 of 42 desktop and mobile checks.
- Signed-in production inspection: passed in expanded and collapsed navigation.
- Production health: `status: ok`.
- Production readiness: `ready: true`.
- Live production CSS and JavaScript hashes match the final local production build.

## Release record

- Implementation commits: `9eae83b`, `6a8ef3c`
- Cloudflare Worker version: `a676d61e-831d-4daa-8119-32c830bd855c`
- Production URL: `https://app.sygilant.us`
- Rollback tag: `rollback/unified-platform-launchers-pre-release-20260909`
