# SygTasks Communication Navigation Removal

Date: 09/09/2026

Status: Production deployed and verified

## Outcome

Removed the duplicate **SygTasks** menu item from the **Communication** navigation group. SygTasks remains available from its permanent branded launcher in the lower sidebar platform stack, where it was intentionally placed as a first-class SygShift workspace.

The Communication group now contains only **Announcements**, **Notifications**, and **Reports**. The `/tasks` route, authorization policy, SygTasks workspace, task data, notification behavior, and permanent launcher were not changed.

## Implementation

- Removed the `/tasks` item from the Communication navigation definition.
- Removed the now-unused `ClipboardList` navigation import.
- Added a regression assertion proving `/tasks` is absent from Communication while the route remains accessible through the existing authorization policy.
- Preserved the permanent SygTasks launcher, including its expanded and collapsed sidebar presentations.
- Made no database, migration, permission, timekeeping, payroll, scheduling, ticket, HR, SygSphere, environment-variable, or secret change.

## Verification

- Focused navigation and launcher tests: 2 files / 18 tests passed.
- `pnpm check`: TypeScript, zero-warning lint, 224 test files / 1,127 tests, Worker build, and client production build passed.
- Actual-component preservation matrix: 54/54 passed on desktop and mobile after release. This covered launcher order, collapsed presentation, short-height and 200% reachability, Early Clock-In acknowledgement, real clock-in/break/clock-out/return behavior, multiple-shift selection, duplicate-submit protection, and guard/Admin/Dispatcher/Supervisor controls.
- Independent source audit confirmed Communication contains only Announcements, Notifications, and Reports; the permanent launcher, `/tasks` route, and access policy remain in place.
- Primary and Worker-fallback application and `/tasks` routes returned HTTP 200.
- Primary and Worker-fallback `/api/v1/health` returned HTTP 200 with `status: ok`.
- Primary and Worker-fallback `/api/v1/ready` returned HTTP 200 with `ready: true` and every configured dependency healthy.
- The live entry JavaScript/CSS and SygTasks JavaScript/CSS matched the verified local production build byte-for-byte by SHA-256 on both domains.

## Release and rollback

- Source commit: `0f1fa0d` (`fix: remove duplicate SygTasks navigation item`).
- Cloudflare Worker version: `d10c2ef1-b32d-40bf-a96b-c3daef064e03`.
- Cloudflare deployment ID: `433e18ab-b5ae-45ad-8186-c685d3f67427`.
- Deployment time: `2026-09-09T22:14:14.969915Z`.
- Pre-release fallback tag: `rollback/remove-communication-sygtasks-pre-release-20260909`, pushed to origin at source baseline `a4ecf66`.

If a presentation rollback is required, deploy the fallback tag. No database rollback is required because this release contains no database change.

Remaining acceptance: none for this release.
