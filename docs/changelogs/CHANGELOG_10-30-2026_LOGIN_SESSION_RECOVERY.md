# SygShift Login Session Recovery

Date: 10/30/2026
Application: SygShift
Status: release candidate verified locally; production deployment pending

## Outcome

Prepared the SygShift companion repair for the 10/29/2026 emergency-access rollout. A temporary central-service, session-context, version-compatibility, or platform-registration failure now closes the workspace and retries without destroying an otherwise healthy native or shared-identity login. An explicit centralized suspension or revocation still signs the employee out and clears protected state.

## Root cause

The post-login shell treated every non-transient context or emergency platform-session registration failure as proof that the employee identity was invalid. It immediately cleared shared-identity state or called Supabase sign-out. Schema rollout differences, access-generation races, permission responses, and registry contract failures could therefore turn one dependency failure into an avoidable login loop.

## Changes

- Added explicit revocation classification to the session-context client.
- Added explicit `access_revoked` classification to the emergency platform-session client.
- Limited destructive sign-out to a positively classified centralized suspension or revocation.
- Kept the application workspace fail-closed during every unverified state.
- Preserved the employee's native or shared session during dependency, timeout, compatibility, registry, or generation mismatch failures.
- Retained automatic recovery plus the existing **Retry secure access** action.
- Left the private forced-logout listener and exact revocation acknowledgement unchanged.
- Reconciled the repair with the newer canonical legacy-host entry correction on current `origin/main`.

## Security and data protection

- Preserving the Auth session does not open the workspace. Protected queries and routes remain unavailable until central context and platform registration both succeed.
- Explicit central revocation still clears protected caches, ends native/shared sessions, and returns the browser to login.
- The global database gate continues to deny suspended accounts independently of browser state.
- No employment, role, permission, schedule, punch, payroll, licensing, document, message, or audit record changes.

## Database and migration status

SygShift adds no migration for this companion repair. The shared canonical database repair is owned by Sygilant migration `20261030120000_emergency_access_login_admission_repair.sql`. SygShift must be released against that repaired central contract; it does not create another authority.

## Verification

- Focused context, registration, shell-lifecycle, and central-bridge regression suite: 4 files and 61 tests passed on exact Node.js 24.19.0 and pnpm 11.25.0 after reconciling with current main.
- TypeScript: passed.
- Zero-warning lint: passed.
- Diff validation: passed.
- The complete `pnpm release:verify`, exact-main GitHub workflow, production Worker release, health/readiness, and authenticated login check remain required before production recovery is claimed.

## Release status

Production deployment is pending the complete release gate, exact `origin/main` workflow, and coordinated database activation. This record will be updated with the exact source and Worker version after release.

## Rollback plan

If the application release must be rolled back, use the previous reviewed Worker version without changing central access state. Never restore the former behavior that treats an unclassified dependency failure as revocation. Keep suspended accounts fail-closed and repair any compatibility issue through a reviewed forward application release.

## Remaining limitation

The controlled multi-platform zero-access acceptance ceremony remains separate. This repair addresses ordinary login continuity and does not claim that final emergency-revocation exercise is complete.
