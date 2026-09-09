# Reciprocal SygSphere Launch Repair — September 9, 2026

## Reported failure

- Chrome displayed `ERR_BLOCKED_BY_CLIENT` while opening SygSphere from Sygilant.
- A separate browser error reported HTTP 404 at `https://app.sygilant.us/`.

## Confirmed cause

- The public SygShift root, login, password-recovery, health, and readiness routes were healthy during the investigation; the root returned the current SPA in repeated uncached checks.
- The exact reciprocal Sygilant-to-SygSphere launch was reproduced in production. The initial protected POST reached SygShift and returned HTTP 303, but the redirected completion request returned HTTP 503.
- The reciprocal receiver still rejected every upstream redirect at the fetch layer. A trusted same-origin canonical redirect therefore interrupted completion and surfaced as Chrome's blocked/error page instead of opening SygSphere.

## Repair

- Added a protected upstream redirect handler to the reciprocal shared-identity receiver.
- It follows at most one redirect and only when the destination remains HTTPS and on the exact same origin.
- The protected method, authorization header, and replayable JSON body are preserved for the trusted redirect.
- Missing, malformed, cross-origin, downgraded, or repeated redirects remain fail-closed and do not receive protected credentials.
- Applied the protected handler consistently across the reciprocal bridge's Sygilant introspection and Supabase verification, refresh, user, session, and service-RPC calls.
- Added sanitized failure diagnostics containing only fixed categories, route path, request identifier, status, and error code. Tokens, cookies, headers, bodies, email addresses, and secrets are not logged.
- Added regression coverage for a trusted canonical redirect and for rejection of a cross-origin credential-collection redirect.

## Safety and regression verification

- Full SygShift quality gate: 209 test files / 1,049 tests passed.
- TypeScript, lint, Worker build, and client production build passed.
- Shared-identity focused suite: 5 files / 59 tests passed.
- Desktop and mobile browser regression suite: 88/88 passed, covering the time clock, early-clock-in modal, password recovery, SygSphere, and platform-launcher layout.
- Production root smoke: 20/20 uncached requests returned the current SygShift application.
- Production routes returned HTTP 200 for SygShift root, login, password recovery, health, and readiness, plus Sygilant root, dashboard, and health.
- Authenticated production Chrome verification completed the full round trip: Sygilant opened SygSphere at `app.sygilant.us/sygsphere`, and the SygShift launcher returned to the Sygilant dashboard.

## Release and rollback

- SygShift source commit: `284ffe7` (`fix: restore reciprocal SygSphere launch`).
- SygShift Worker version: `3095b673-7e17-4533-b571-847f1854e6e6`.
- Pre-release rollback tag: `rollback/sygsphere-reciprocal-launch-pre-fix-20260909`.
- No timekeeping, password-recovery, employee-access, ticket, notification, or SygSphere messaging behavior was removed or relaxed.
