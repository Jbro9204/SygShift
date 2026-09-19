# SygSphere Communications Stage 1/2 Closed Coordinator Foundation

**Contract:** 1.0.0-draft.2 / protocol 1
**State:** Source complete and closed by default; not deployed and not exposed to browsers.

## What exists

- Command-specific Zod and JSON schemas for all 20 protocol commands. Commands reject browser-supplied tenant, actor, permission, feature-gate, replay, and provider authority.
- A server-only authorization shape which derives the authenticated account, employee, tenant, permissions, and required permission for each command. Room or assignment membership is intentionally not yet considered satisfied.
- A separately versioned SQLite Durable Object coordinator with persisted idempotency and rate-window state. It exposes no fetch handler, socket, or browser route.
- A provider registry that is statically disabled and contains no endpoint, credential, application identifier, session, or media operation.
- A forward-only, **unapplied** Supabase migration for private release-gate, provider-registry, command-ledger, history, audit, and daily-usage records. Daily usage reserves a feature key, estimated received bytes, telemetry status, estimate version, and reconciliation metadata so a later 1,000 GB / $0.05 estimate can be reported honestly as unavailable, estimated, or reconciled. Every relation has forced RLS; command/history/audit ledgers are append-only, with only a service-only, 30-day, bounded retention procedure for expired command replay records.

## Intentionally blocked

- SYGSHIFT_SYGSPHERE_COMMS_RUNTIME_ENABLED is false in the worker configuration.
- The database release gate defaults closed and cannot enable runtime unless all evidence fields are true. The protected authorization procedure still returns authorized false until a future reviewed scope-membership policy exists.
- The Worker has no /api/comms/v1 or other communications route. No Sygilant proxy target is callable yet.
- There are no communications role grants, employee overrides, provider credentials, browser media APIs, CSP relaxations, WebSockets, or customer-visible controls.

## Required evidence before protected service ingress

1. Apply the migration in controlled non-production and run supabase/tests/sygsphere_communications_coordinator_foundation_regression.sql as a rollback-only test.
2. Prove the complete two-device provider matrix, including forced closure and TCP/TLS TURN fallback.
3. Add and negative-test a server-owned scope/membership resolver; never accept it from Sygilant or a browser.
4. Publish SygShift’s canonical contract digest and obtain an independent Sygilant consumer compatibility result.
5. Approve a narrow, authenticated SygShift ingress. It must call the service-only database authorization procedure, resolve the deterministic TENANT_COMMS object name on the server, and never proxy provider credentials or browser-selected identity.
6. Review rollback, logs, audit projection, rate limits, and emergency disable behavior before enabling any runtime or role grant.

## Quality gates

Run these checks before proposing a later activation change:

```powershell
pnpm check:sygsphere-comms-stage12
pnpm check:sygsphere-comms-stage45
pnpm check:sygsphere-comms-stage67
```

These checks prove the source remains closed. They do not authorize a deployment or feature enablement.
