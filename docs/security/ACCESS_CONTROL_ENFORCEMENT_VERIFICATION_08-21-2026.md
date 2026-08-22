# Access-Control Enforcement Verification — 08/21/2026

## Outcome

SygShift now treats effective permissions as the authorization source for navigation, direct routes, protected page actions, Worker endpoints, public RPC functions, and row-level database policies. Fixed role names remain available for role labels, default permission bundles, operational targeting, and protected Admin-role safety rules; they no longer grant an undocumented authorization bypass.

## Production access preservation

The production before-state and after-state were compared using the same deterministic projection of active employees, primary roles, additional role assignments, person-specific overrides, role definitions, and permission grants.

- Active employees: 47 before / 47 after
- Roles: 6 before / 6 after
- Permission definitions: 64 before / 64 after
- Additional employee-role assignments: 0 before / 0 after
- Person-specific overrides: 0 before / 0 after
- Access fingerprint: `2faadcd0bbdddf1d6ecf45655682f4f5ab7f58a3364be8a0d5b7be4e83161c9e`
- Preservation result: exact match

No employee role, role permission grant, employment status, individual override, or MFA requirement was changed by this enforcement update.

### Preserved role baseline

| Role | Active employees | Granted permissions | MFA required |
| --- | ---: | ---: | --- |
| Admin | 2 | 64 | Yes |
| Dispatcher | 3 | 22 | Yes |
| Guard | 35 | 13 | No |
| Recruiting & Licensing | 1 | 18 | Yes |
| Scheduler | 1 | 42 | Yes |
| Supervisor | 5 | 46 | Yes |

## Enforcement boundaries

- Central permission policies cover every authenticated application route.
- Sidebar entries use the same permission policy as direct route access.
- Page actions that formerly used role-name fallbacks now use the signed-in employee's effective permissions.
- Worker administration and notification processing require an applicable effective permission and MFA.
- Protected database functions use effective-permission checks at the execution boundary.
- All 50 current row-level security policies were inspected; zero retain role-name authorization checks.
- Execution on every function in the `private` schema is revoked from `public`, `anon`, and `authenticated`.
- Sensitive public administration/session RPCs are not executable by anonymous users.

The live catalog still contains 19 function definitions matching the broad role-reference search. Each remaining match is used for non-authorizing behavior such as display labels, audience/recipient targeting, scheduling eligibility semantics, compatibility helper names, or protected role-change safety. Current row-level policies contain no remaining role-reference matches.

## Fail-closed safeguards

- Migration `20260821203000_permission_enforcement_integrity.sql` snapshots access assignments inside its transaction and raises an exception if any protected access data changes.
- Every dynamic function replacement asserts the reviewed production fragment exists. Schema drift aborts the migration instead of silently weakening authorization.
- Unknown authenticated routes are denied by default.
- An automated guard checks route coverage, permission-only navigation, Worker enforcement, and migration integrity.
- `tools/verify-production-access-preservation.mjs` fails if a future before/after snapshot changes employee access or role definitions.
- `tools/capture-production-role-boundaries.mjs` audits the live function and policy catalog for role-based authorization remnants.

## Recovery

The frozen before-state remains in the local controlled output set used by the verification scripts. Because the enforcement migration does not modify access assignments, recovery from an application deployment consists of rolling back the application build. Any database authorization rollback must be implemented through a reviewed forward-only migration; production migration history must not be rewritten.

## Release verification

- Type checking and lint passed.
- All 295 automated tests passed across 56 test files.
- The production build completed successfully.
- The application and health endpoint returned HTTP 200 after deployment.
- Deployed Cloudflare Worker version: `abaa7292-382c-4c6d-b861-7bc1d5ed63e4`.
