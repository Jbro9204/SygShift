# Access-Control Inventory

Date: 08/21/2026

## Purpose

Established the verified before-state for the Full Permission Enforcement and Access-Control Integrity initiative. This phase documents how access works today so later enforcement changes can be reviewed, tested, and compared without unintended access drift.

## Changes completed

- Added a repeatable repository scanner for application routes, navigation, UI role checks, Worker endpoints, client RPC usage, database functions, and RLS policies.
- Added a production baseline capture tool for the linked Supabase project.
- Captured the current six-role, 64-permission production matrix.
- Captured effective access for all 47 active employees without storing employee-level access data in Git.
- Confirmed there are currently no active extra-role assignments and no active person-specific permission overrides.
- Confirmed all 136 RPC names called by the application exist in the live database.
- Inspected 302 live database function signatures, 50 RLS policies, 60 public/storage tables, function grants, table grants, schema privileges, and migration state.
- Confirmed all inspected public tables have RLS enabled.
- Created a 16-item prioritized access-control gap register.
- Documented the distinction between authorization fallbacks that must be removed and role-aware presentation or safety logic that may remain.
- Added package commands for repeatable static and production inventory checks.

## Principal findings

- 13 of 17 navigation items still accept a legacy role after a permission check fails.
- Nine Time deep links do not use the shared exact-route gate and depend on fragmented page and RPC checks.
- Several client and Worker actions still use fixed-role authorization fallbacks.
- 29 live database functions and 39 live RLS policies contain role references without an effective-permission helper and require individual classification.
- Four protected public RPCs have unnecessary explicit anonymous execute grants, although their internal authorization checks prevent anonymous administrative access.
- Permission-level MFA metadata exists, but some enforcement paths still infer MFA requirements from a role.
- The current production matrix contains high-impact assignments that require business confirmation before enforcement behavior is changed.

## Files added

- `docs/security/ACCESS_CONTROL_INVENTORY_08-21-2026.md`
- `docs/security/ACCESS_CONTROL_GAP_REGISTER_08-21-2026.csv`
- `docs/security/ACCESS_CONTROL_CURRENT_ROLE_MATRIX_08-21-2026.csv`
- `tools/access-control-inventory.mjs`
- `tools/capture-production-access-baseline.mjs`

## Commands added

- `pnpm inventory:access`
- `pnpm inventory:access:production -- 08-21-2026`

## Validation

- Static inventory completed successfully.
- Production baseline completed successfully against the linked Supabase project.
- The production fingerprint was verified as stable across consecutive captures when production access data did not change.
- The complete employee-level production snapshot remains local and excluded from Git because it contains sensitive access details.
- Full repository type checking, lint, tests, and production build were run before publication.

## Production impact

No permissions, roles, MFA requirements, routes, Worker authorization, database functions, RLS policies, grants, or employee access records were changed in this inventory phase. No application deployment was required.

## Next controlled phase

Business owners review and approve the current role matrix and protected safety rules. Enforcement changes should then proceed by layer with positive and negative tests proving that grants and revocations work through navigation, direct URLs, UI actions, Worker APIs, RPCs, and RLS.
