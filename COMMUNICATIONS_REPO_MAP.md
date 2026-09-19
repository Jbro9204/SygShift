# SygSphere Communications Repository Map

**Checkpoint:** `bbd43d2dff6a79a870f63897ee2ff141e7170f43`
**Recorded:** 09/19/2026
**Scope:** Stage 0 discovery, Stage B tenant authorization, and the closed Stage 1/2 coordinator foundation. This document does not enable communications features or claim that provider media has been validated.

## Authority map

| Area | Canonical authority and verified integration point | Communications rule |
| --- | --- | --- |
| Identity | `public.get_session_context()`; browser access in `src/data/auth.ts`; employee/account mapping in `public.employees` and `private.employee_accounts` | Derive employee and auth-user identity server-side. Do not accept either from a browser command as authority. |
| Effective permissions | `private.employee_effective_permissions(uuid)`, `public.get_effective_permissions()`, and `public.has_effective_permission(text)` in `supabase/migrations/20260727203000_access_control_center.sql` | Add communications capabilities only through this existing resolver and its role/grant projection. |
| MFA and shared Sygilant sessions | `private.shared_identity_sessions`; SygSphere-scoped handoff migrations `20260908183000_shared_sygsphere_session_bridge.sql`, `20260910010000_scope_shared_identity_to_sygsphere.sql`, and `20260910050000_bind_sygilant_sessions_to_sygsphere.sql` | Preserve a limited SygSphere scope. Communications must not upgrade a shared session to full SygShift access. |
| Conversation membership and history | Private SygSphere records and `public.sygsphere_request(...)` from `20260907023825_sygsphere_messaging_foundation.sql`; browser adapter `src/data/sygsphere.ts` | Direct calls and meetings use existing conversation membership. Do not create another member directory or room-membership authority. |
| SygSphere live invalidation | Private Realtime topic `sygsphere:<auth_user_id>` from the messaging foundation; runtime subscription in `src/components/SygSphereLauncher.tsx` | Use it for invitation/history invalidation only, not high-frequency media control or SDP. |
| Presence | `private.platform_presence_sessions`, `public.record_platform_presence(...)`, and `public.get_platform_presence_directory()` from `20260916132452_cross_platform_presence_and_read_receipts.sql` | Reuse approximate cross-platform presence as display context only. It cannot grant a call, room, or floor. |
| Notifications | `public.employee_notifications` and the private notification delivery/outbox path, beginning with `20260906133034_employee_notification_center.sql` | Calls may create canonical invitations/outcomes through the existing delivery boundary. They must not create a parallel bell or email system. |
| Operations scope | Existing shifts, assignments, sites/posts, Dispatch, accountability, and incidents in the SygShift database and protected Worker routes | PTT eligibility is derived from current assignment/shift policy plus explicit Dispatch or supervisor exceptions; it is never inferred from a client role label. |
| Browser shell and cache | `src/components/AppShell.tsx`, `src/pages/SygSpherePage.tsx`, TanStack Query data adapters under `src/data/` | A later runtime is application-shell scoped so internal navigation can retain a call. Account change and sign-out must tear it down. |
| Worker | worker/index.ts, worker/sygilantSharedIdentity.ts, worker/sharedIdentity.ts, and protected SygSphere file routes | SygShift will own protected /api/comms/v1 ingress, server-only provider credentials, request validation, and coordinator routing. No communications route exists in this checkpoint. |
| Durable Objects | wrangler.jsonc, worker/index.ts, and worker/comms/tenantCommsDurableObject.ts | A separate SQLite-backed TenantCommsDurableObject source binding is declared with the runtime flag set to false; it has no fetch handler or public ingress. The existing scanner migration is untouched. |
| Database migration and tests | `supabase/migrations/`, `supabase/tests/`, and repository guard tests under `src/` | SygShift is the sole migration owner. Every future change is additive, forward-only, RLS-reviewed, and accompanied by allow/deny tests. |
| System Operations | `src/pages/SystemOperationsPage.tsx` and `src/data/maintenance.ts` | Communications usage gets a separate `admin.system_metrics.view` boundary. It must not inherit `admin.maintenance.manage`. |

## Tenant-routing decision

No canonical `tenant_id`, `organization_id`, or platform `company_id` currently exists. `public.clients` represents operational customers and is not a tenancy authority.

Stage B added the smallest SygShift-owned extension: the private singleton private.sygsphere_tenants registry and server-only private.current_sygsphere_tenant_id() resolver. The tracked, unapplied Stage 1/2 migration adds closed release-gate, disabled-provider-registry, replay, history, audit, and usage records. All communications authority and coordinator records remain tenant-addressed; browser and Sygilant requests may carry an opaque route address, but never a tenant identity trusted for authorization.

## Shared-contract ownership

SygShift owns `shared/sygsphere-communications/v1/`. Sygilant consumes the exact generated artifacts and SHA-256 digest; it does not create a competing contract or schema fork. The current wire compatibility revision is `1.0.0-draft.2` with `protocolVersion: 1`. The shared inventory includes every transitively imported artifact, including the closed activation gate used by the presentation profile. The same package also owns the `1.0.0-draft.1` shared presentation profile, including the employee-safe state wording and hold-to-talk interaction model. A changed digest requires coordinated SygShift/Sygilant compatibility evidence before either application can mount communications.

## Future implementation ownership

| Owner | Planned path | Responsibility |
| --- | --- | --- |
| SygShift database | New timestamped files in `supabase/migrations/` plus `supabase/tests/` | Tenant registry, capability catalog/projection, communications records, RLS, idempotent ingestion, audit and usage projections. |
| SygShift Worker | worker/comms/tenantCoordinatorCore.ts, tenantCommsDurableObject.ts, and providerRegistry.ts | Closed coordinator command validation, replay/rate-limit persistence, and a disabled provider registry. A future reviewed ingress may add /api/comms/v1; no route, provider adapter, or secret binding exists now. |
| SygShift runtime | Future shell-owned modules under `src/communications/` | Capture lifecycle, media negotiation queue, recovery, PTT/call controllers, and a bounded telemetry sampler. |
| Sygilant | Its existing SygSphere bridge, adapter, CSP/header, and presentation layers | Consume the exact shared contract and canonical SygShift responses without becoming an identity, permission, history, or provider authority. |

## Feature state and release gate

All communications runtime feature flags remain disabled. The additive Stage B tenant/authorization migration is applied; the Stage 1/2 persistence migration is tracked but unapplied. The source-only Durable Object binding has no route or provider adapter, and SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED is statically false. The current production headers intentionally disable camera and microphone; any later change must update both public/_headers and worker/index.ts with matching security tests and only the exact reviewed provider origin.

## Provider-spike status

The provider spike is prepared by `docs/operations/SYGSPHERE_COMMUNICATIONS_PROVIDER_SPIKE.md` and `tools/validate-sygsphere-communications-provider-spike.mjs`. The Stage A staging TURN preflight and disposable server-side SFU transport probe are recorded in `docs/operations/SYGSPHERE_COMMUNICATIONS_STAGE_A_STAGING_EVIDENCE.md`; the two-device matrix remains unvalidated. The tool performs no network request unless the explicit staging-only execution switch and every required secret are present.

## Rollback

rollback/pre-sygsphere-communications-stage0-20260919 identifies the source checkpoint at bbd43d2dff6a79a870f63897ee2ff141e7170f43. The Stage 1/2 migration is additive and has not been applied; rollback is therefore a source rollback only. It does not delete conversation, identity, presence, notification, or operational history.
