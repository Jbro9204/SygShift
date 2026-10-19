# Automatic Scheduled Recovery and Release Safety

Date: 10/19/2026
Status: Released and verified in production

## Problem and user impact

The October 19 Supabase data-plane incident was the second secure-access interruption associated with release-day operations. SygShift's existing scheduled circuit correctly stopped the remainder of each failed cron cycle, but it existed only in that invocation. The next minute trigger forgot the outage and retried the first database operation.

This did not establish that a SygShift release caused the provider outage. The provider-internal trigger remains unverified. It did establish two reliability gaps:

- scheduled containment did not persist across minute invocations; and
- the normal production command did not provide an explicit candidate, exact-version promotion, post-promotion classification, and verified rollback sequence.

## Verified root-cause boundary

During the incident, keyed Supabase Auth, REST, Storage, secure-session, and scheduled RPC paths were unavailable while Cloudflare continued serving the application. Nine cron cycles stopped on the first `service_run_timekeeping_automation` timeout, so the existing per-run circuit prevented downstream fanout. Because the circuit state was not durable, the first operation was retried by every later minute invocation.

The exact provider-internal cause of the Supabase interruption is still unknown. This update does not claim otherwise and does not add a blind automatic Supabase restart.

## Intended behavior after release

- A singleton Durable Object persists scheduler circuit and recovery state across minute invocations.
- A renewable, expiring lease permits only one scheduled cycle at a time.
- A transient upstream failure opens the persisted circuit and causes later cooldown invocations to skip before any database call.
- Recovery runs only a read-only maintenance-status probe; no timekeeping, notification, patrol, document, HR, push, or other mutating scheduled lane runs while the circuit is half-open.
- Two successful read-only recovery cycles are required before a later, separately leased invocation may resume the full scheduled pipeline.
- `/api/v1/ready` reports the coordinator binding, runtime freshness, and `open`/`recovering` degradation without creating another Supabase probe.
- The production release gate verifies baseline Worker/upstream health, exact Git source, the local quality gate, mandatory Time Clock browser checks, and a fresh production build.
- One candidate Worker version is uploaded and checked through its Version URL when Cloudflare provides one, then the exact candidate is promoted and verified repeatedly.
- A bad Worker release is rolled back to the exact recorded prior version when upstream services remain healthy. A provider outage is classified separately instead of triggering an unrelated Worker rollback.
- New Durable Object or configuration lifecycle state is introduced in a separate bootstrap release before dependent scheduler behavior, preserving a safe rollback floor.

## Files in scope

- `worker/scheduledRuntimeCoordinator.ts`
- `worker/index.ts`
- `worker-configuration.d.ts`
- `wrangler.jsonc`
- `src/data/systemStatus.ts`
- `src/data/systemStatus.test.ts`
- `src/scheduledRuntimeCoordinator.test.ts`
- `src/worker.test.ts`
- `tools/production-release-core.mjs`
- `tools/production-release-core.test.mjs`
- `tools/release-production.mjs`
- `tools/lifecycle-bootstrap-core.mjs`
- `tools/lifecycle-bootstrap-core.test.mjs`
- `tools/deploy-lifecycle-bootstrap.mjs`
- `package.json`
- `docs/runbooks/SCHEDULED_RUNTIME_RECOVERY.md`
- `docs/BUILD_AND_HANDOFF_GUIDE.md`
- `DEVLOG.md`
- this changelog

## Preservation and security

- No Supabase schema or data migration is planned for this update.
- Recovery checks do not edit source punches, adjustments, schedules, payroll, identities, employee records, messages, notification history, or audit history.
- The scheduler remains fail-closed when its coordinator cannot be reached.
- Release canary credentials remain operator-side secrets and must not enter logs, source, the client bundle, or child build/test environments.
- The release gate does not submit payroll, alter pay rates, or restart Supabase.

## Verification record

Targeted scheduler/worker/status tests: 95 passed

Full Vitest suite: 2,204 passed, 1 skipped across 379 files

TypeScript and zero-warning lint: Passed

Release-gate tests: 74 passed

`pnpm check`: Passed

Mandatory `tests/e2e/time-clock-workflow.spec.ts`: Passed in both production gates

Fresh production build after browser tests: Passed in both production gates; static-asset contract passed

Independent review: No remaining P0/P1 findings after scheduler and release-control red-team reviews

## Lifecycle and deployment record

Supabase migration: None

Cloudflare Durable Object bootstrap source commit: `ec91c8ef055744c6eaeb540bb02d7ddd5f2b0e24`

Cloudflare Durable Object bootstrap version: `2b0604e3-ec49-4ad2-a581-a72e616208e2`

Cloudflare Durable Object bootstrap deployment: `263033fe-3e02-4236-b59b-3c051340cb55`

Operational implementation commit: `54d021cd85e137739d5db33c9cf7418b613bf4d0`

Git push to `origin/main`: Verified for both release source commits

Operational Cloudflare Worker version: `b7393269-4ee0-4efa-b1e1-32605579a864`

Operational Cloudflare deployment: `41dda212-5220-4619-a1b6-9df826430cd0`

Candidate Version URL available: No; Wrangler did not provide one for this Durable Object Worker

Prior rollback version: `2b0604e3-ec49-4ad2-a581-a72e616208e2`

Production root/login verification: HTTP 200; updated client shell served

Production `/api/v1/health`: HTTP 200, `status: ok`

Production `/api/v1/ready`: HTTP 200, `ready: true`, scheduler `closed`

Authenticated workspace: Refreshed, secure-access verification completed, and the signed-in operations workspace rendered

Scheduled full-cycle verification: `2026-10-19T16:13:58.560Z`, owned by commit `54d021cd85e137739d5db33c9cf7418b613bf4d0`

Release outcome: Promoted successfully; no rollback required

## Remaining limitations

- The coordinator contains scheduler traffic and controls safe resumption; it cannot make Supabase Auth, REST, or Storage available during a provider outage.
- The provider-internal cause of the October 19 data-plane interruption is unknown because usable pre-restart provider logs were unavailable.
- A blind automatic provider restart is intentionally excluded. Any future external watchdog would require separately held credentials, multi-service evidence, strict cooldowns, audit logging, and an explicit operational approval.
- Cloudflare may not expose a candidate Version URL for a Worker that uses Durable Objects. When unavailable, the release gate must disclose that fact and rely on exact-version promotion, post-promotion verification, and exact rollback.

## Operator reference

See `docs/runbooks/SCHEDULED_RUNTIME_RECOVERY.md` for state behavior, failure containment, the two-step Durable Object/config lifecycle rule, release commands, recovery decisions, and the final verification checklist.
