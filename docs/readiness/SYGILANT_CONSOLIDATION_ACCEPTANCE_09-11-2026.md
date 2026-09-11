# Sygilant Consolidation Acceptance

Date: 2026-09-11

Decision: **Side-by-side merger accepted; Sygilant-hosted cutover remains gated**

## Accepted now

- SygShift and Sygilant both serve their production root and health endpoints successfully.
- The reciprocal shared-identity contract uses exact HTTPS origins, a 60-second signed assertion, server-side authorization, current-role and MFA revalidation, one-time consumption, and private audit ledgers.
- All 10 approved employee roles hold the exact launch entitlement in both directions. No unapproved role holds SygShift return access.
- All 37 active, activated, enabled employee accounts evaluated by the production audit have effective Sygilant launch permission.
- Guard AAL1 remains limited to active canonical Guards whose effective policy does not require MFA. All other roles remain MFA protected.
- SygSphere continues to use one canonical data and Realtime service; no credential, employee, message, or permission store was copied.
- Direct SygShift sign-in, password recovery, and emergency access remain available as the operational fallback.

## Production evidence captured

- SygShift root, health, and readiness: HTTP 200.
- Sygilant root and health: HTTP 200.
- Sygilant incoming shared-launch GET boundary: HTTP 405.
- Empty/hostile incoming launch and anonymous outgoing launch requests: HTTP 403.
- Outgoing launch ledger: 42 total, 41 consumed, 0 unconsumed and unexpired, 0 invalid issuer/audience/destination rows.
- Incoming shared sessions: 59 total across the approved `platform` and `sygsphere` scopes; 0 invalid scopes.
- Permission postflight: 10 approved grants in each direction, 0 approved-employee permission failures, 0 unapproved return grants, and 0 invalid incoming or outgoing AAL1 records.
- Focused shared-identity verification: 10 files, 79 tests passed.

## Gates that remain closed

Direct SygShift login must not be retired until management approves a fresh user-present acceptance run covering entry from Sygilant, deep links, logout propagation, password recovery from both products, role revocation, MFA changes, support ownership, monitoring alerts, outage behavior, and rollback. The current side-by-side state is the safe production state until that approval exists.

