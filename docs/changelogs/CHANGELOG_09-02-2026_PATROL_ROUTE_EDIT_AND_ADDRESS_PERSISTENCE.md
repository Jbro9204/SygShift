+# Patrol Route Edit and Address Persistence Repair

Date: 09/02/2026

## Outcome

Existing Patrol routes can now be edited and saved normally. Stop addresses, city, state, postal code, route settings, evidence options, instructions, and hit requirements are persisted into the next immutable route version instead of the save failing.

No route, stop, address, assignment, hit, evidence, or audit record was changed during diagnosis or verification.

## Root cause

The existing-route branch of `public.save_patrol_route(jsonb)` used `route_id` as both a PL/pgSQL variable and a database column name. PostgreSQL could not resolve the version lookup and rejected every attempted update to an existing route with error `42702` before the new version or its stop details could be inserted.

New-route creation was not affected. The issue was broader than addresses: every edit to an already-created route was blocked by the same database ambiguity.

## Repair

- Added forward migration `20260902214839_patrol_route_update_persistence.sql`.
- Renamed the local route identifier to `resolved_route_id` and qualified the route-version table alias.
- Preserved the existing function signature, permission checks, fixed search path, security-definer boundary, audit event, immutable route-version model, and browser execute grant.
- Added a regression guard that requires the unambiguous lookup and confirms address fields remain part of the persisted stop payload.

## Verification

- Rehearsed the corrected function against an existing production route inside an explicit rollback transaction.
- Verified that the rehearsal created the next route version and read back the complete test address: street, city, state, and postal code.
- Repeated the same rollback-only save after the production migration was applied.
- Confirmed the transaction left production unchanged: 2 routes, 2 route versions, 11 current stops, and 0 populated current stop addresses.
- Confirmed the deployed function contains the distinct route variable and the migration marker is recorded.
- Full application validation passed: TypeScript, zero-warning lint, 151 test files / 734 tests, and both Worker and client production builds.

## Release status

- Migration: `20260902214839_patrol_route_update_persistence.sql` applied and recorded after a successful rollback rehearsal.
- Git: implementation commit `7d3eabf` pushed to `origin/main`.
- Cloudflare: Worker version `a0bf6721-4fc6-458d-bf7e-61c1beda9e0f` deployed.
- Primary and fallback login, health, and readiness endpoints returned HTTP 200; readiness reported all required bindings available.

## Existing addresses

The repair does not invent or backfill addresses. The current production patrol stops still have no stored addresses because the earlier failed saves never committed them. Management can now re-enter each real address once and save the route; that save will create the next auditable route version and retain the address.

## Rollback

This is a forward-only function correction. If another correction is needed, replace the function through a new forward migration. Do not delete route versions or rewrite patrol history.

