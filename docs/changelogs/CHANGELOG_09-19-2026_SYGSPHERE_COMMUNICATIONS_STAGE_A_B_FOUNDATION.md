# SygShift Changelog — 09/19/2026

## SygSphere Communications Stage A/B Staging Gate and Authorization Foundation

### Outcome

Added the smallest SygShift-owned tenant and server-only communications authorization foundation. No media application, TURN credential, Worker route, Durable Object binding, browser control, role grant, feature flag, or production provider traffic was enabled.

### Stage A — staging provider evidence

- Added the isolated staging evidence checklist for Cloudflare Realtime SFU/TURN and Account Analytics.
- Isolated staging resources now exist: SFU app `sygsphere-communications-staging` (`643a90a9acbeacb7b85d3da18ddf1bb7`) and a protected TURN key (`f800b6bc2cb66e5a406f62496758abdb`). No secret value is recorded here.
- The fail-closed preflight ran through the protected staging secret store and returned `turn-credential-validated` with two ICE server entries.
- A disposable local-only, server-secret SFU probe received HTTP `201` for a synthetic video offer and established a browser WebRTC transport; it was removed immediately afterward. This validates only the staging API and transport path, not a real call or media path.
- SFU and TURN Account Analytics are accessible, with no recent usage yet expected before physical-device testing and normal ingestion delay.
- Account Analytics and the two-physical-device matrix remain **not executed**. No audio, forced closure, idle rebuild, track reuse, TLS TURN, camera, screen share, or revocation behavior is claimed validated.

### Stage B — canonical authority

- Added private `sygsphere_tenants` with exactly one active `sygshift-primary` tenant, separate from operational client records.
- Added `private.current_sygsphere_tenant_id()` and `private.sygsphere_comms_permissions(uuid)`, available only to the service role.
- Added the complete v1 communications permission vocabulary to the existing permission catalog but deliberately created **no** role grants. Guard-appropriate baseline capabilities (`use`, PTT listen/transmit, and direct call start/receive) remain usable at AAL1 when later granted; priority, monitoring, moderation, configuration, usage, and other elevated capabilities remain MFA-protected.
- Added service-only `public.service_get_sygsphere_communications_context(uuid)` so a later coordinator derives tenant, identity, account status, and exact effective permissions on the server; browser input cannot authoritatively select an employee or tenant.
- RLS is enabled and forced for the private tenant table; all direct public, anonymous, and authenticated table/function access is revoked.

### Rollback and verification

- Rollback checkpoint: `rollback/pre-sygsphere-communications-stageb-20260919`, created from `7b39ecd820f5e4c3e0a17f38e575ad651afb530a`.
- `pnpm check:sygsphere-comms-spike` passed in safe `not-executed` mode. Focused Stage B guard execution is recorded separately with the release result; no database migration or provider run is claimed from local static checks.
- This change is an additive, reviewable migration only. Apply it only through the normal tested migration release path after the SQL regression is run against a non-production database.
