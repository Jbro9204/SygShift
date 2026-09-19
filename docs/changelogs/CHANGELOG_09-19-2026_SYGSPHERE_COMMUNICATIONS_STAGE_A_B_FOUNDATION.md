# SygShift Changelog — 09/19/2026

## SygSphere Communications Stage A/B Staging Gate and Authorization Foundation

### Outcome

Added and released the smallest SygShift-owned tenant and server-only communications authorization foundation. No media application, browser-held TURN credential, Worker route, Durable Object binding, browser control, role grant, feature flag, or production provider traffic was enabled.

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
- Added service-only `public.service_get_sygsphere_communications_context(uuid)` so a later coordinator derives tenant, identity, account status, and exact effective permissions on the server; browser input cannot authoritatively select an employee or tenant. Its boundary is explicit execute grants/revocations rather than the deprecated `auth.role()` helper.
- RLS is enabled and forced for the private tenant table; all direct public, anonymous, and authenticated table/function access is revoked.
- Added a rollback-only SQL regression that verifies the singleton, private-table denial, exact catalog/MFA split, zero role grants, service-only execution, fixed search path, canonical active-account guard, and absence of the deprecated role helper.
- Rehearsed the complete migration and regression against the production schema inside one transaction with one `BEGIN`, no `COMMIT`, and a final `ROLLBACK`. The rehearsal caught and corrected the unsupported `high` risk label before release; the catalog now uses its established `sensitive` and `critical` vocabulary.
- Applied and recorded only migration `20260919170000_sygsphere_communications_tenant_authorization_foundation.sql` through an isolated workspace containing placeholders for the 260 already-applied remote migrations. The dry run named exactly this one migration; no seed, role, vault, repair, or historical replay was included.

### Rollback and verification

- Rollback checkpoint: `rollback/pre-sygsphere-communications-stageb-20260919`, created from `7b39ecd820f5e4c3e0a17f38e575ad651afb530a`.
- `pnpm check:sygsphere-comms-spike` passed in safe `not-executed` mode when staging secrets were absent; the separately controlled provider run returned `turn-credential-validated` with two credential-bearing ICE entries while omitting those credentials from recorded output.
- The focused Stage B guard passed 4 tests. The complete repository gate passed strict TypeScript, zero-warning lint, 270 test files / 1,367 tests, and both production builds.
- The required actual-component Time Clock preservation matrix passed all 42 desktop/mobile checks.
- Production postflight passed the rollback-only database regression and confirmed one canonical tenant, 14 active permissions split across seven `sensitive` and seven `critical` entries, zero role grants, zero employee overrides, and a recorded migration ledger entry.
- The database foundation is live but dormant. A later forward-only withdrawal may revoke and remove these objects after dependency review; production media and user-facing communications remain disabled.
