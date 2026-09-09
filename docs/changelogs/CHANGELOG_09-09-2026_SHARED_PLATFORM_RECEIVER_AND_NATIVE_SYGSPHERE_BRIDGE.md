# Shared Platform Receiver And Native SygSphere Bridge

Date: 09/09/2026

## Outcome

SygShift remains the sole employee identity, role, permission, MFA, FIDO2, trusted-device, and
SygSphere data authority. Its shared-identity receiver now supports two explicit, non-interchangeable
destinations: a full SygShift platform session and a SygSphere-only session used by Sygilant's native
messaging workspace.

## Implementation

- Added exact `platform` and `sygsphere` shared-session scopes. The receiver binds the assertion's
  signed destination to the issued scope and rejects unknown or mismatched destinations.
- Added a critical, locked, MFA-required `apps.sygshift.access` entitlement and assigned it only to the
  canonical `system_admin` role. Sygilant cannot manufacture or widen this permission.
- Kept the shared access and refresh tokens inside an encrypted, HttpOnly Worker session. The browser
  uses a dedicated memory-only Supabase client with automatic token refresh disabled.
- Made the Worker the sole refresh owner and added credential-free browser-tab synchronization.
- Confined SygSphere-scoped sessions to `/sygsphere`; attempts to navigate elsewhere clear the shared
  session and return to native SygShift sign-in. Platform-scoped sessions retain normal SygShift routing.
- Added a direct native-login fallback when a handoff is unavailable or invalid.
- Added database binding from active Sygilant shared sessions to the canonical SygSphere session gate.
  Tokens remain hashed at rest, are never returned by SQL, and are revoked when the originating
  Sygilant session expires or is revoked.
- Preserved SygShift's existing account, scheduling, timekeeping, HR, report, and communication logic.

## Database

- Applied and recorded `20260909064652_sygshift_platform_shared_launches.sql`.
- Applied and recorded `20260910040000_scope_shared_identity_platform.sql`.
- Applied and recorded `20260910050000_bind_sygilant_sessions_to_sygsphere.sql`.
- Verified forced row-level security on the platform launch ledger, a required constrained session
  scope, the enabled Sygilant binding trigger, zero unbound active Sygilant sessions, and the exact
  `system_admin` entitlement assignment.
- Supabase Security Advisor reported no errors after the migration sequence.

## Verification

- `pnpm check` passed TypeScript, zero-warning lint, 214 test files / 1,074 tests, Worker build, and
  client production build.
- Mounted AppShell lifecycle tests passed platform routing, SygSphere confinement, internal-route
  rejection, native-login fallback, and Worker-driven revocation behavior.
- The mandatory Time Clock Playwright workflow passed 38/38 desktop and mobile checks, including
  clock-in, break, resume, clock-out, early-clock acknowledgement, ambiguous assignments, failure
  recovery, role boundaries, and duplicate-submit protection.

## Rollback

- Source baseline: `rollback/sygilant-main-platform-provider-pre-release-20260909`.
- The database changes are additive. A rollback must first disable Sygilant's outbound launch flags,
  deploy the prior SygShift Worker, revoke active shared sessions, and then use a reviewed forward
  migration to remove the new trigger, scope, entitlement, and ledger objects.

## Release Evidence

The receiver source is verified locally and the database changes are live. Worker deployment and live
cross-application acceptance evidence will be appended after the receiver release is complete.
