# Scheduled Runtime Recovery and Safe Release Runbook

Date: 10/19/2026
Implementation status: Pending final verification and production release

## Purpose

This runbook covers two related safeguards:

1. The scheduled-runtime coordinator prevents SygShift's minute-triggered background work from repeatedly adding load while the data service is unavailable.
2. The production release gate verifies the existing production boundary, the intended source commit, the release candidate when Cloudflare exposes a candidate URL, the promoted release, and the exact rollback target.

These safeguards protect availability and records. They do not bypass authentication, rewrite employee data, submit payroll, or silently restart an external provider.

## Incident boundary

The October 19 incident was a project-wide Supabase data-plane interruption. Cloudflare continued to serve the application and its basic health endpoint, but keyed Auth, REST, Storage, secure-session checks, and the first scheduled database operation stopped responding normally. The existing per-invocation circuit prevented downstream scheduled fanout, but each new minute invocation forgot the previous failure and retried the first database call.

The persistent coordinator closes that cross-minute gap. It does not claim to repair a provider outage. Its job is to contain retries, test recovery safely, and resume normal scheduled work only after repeated successful evidence.

## Runtime states

| State | Meaning | Scheduled behavior |
| --- | --- | --- |
| `closed` | Normal operation is allowed. | A serialized full scheduled cycle may run. |
| `open` | A transient upstream failure was recorded. | Full work is suppressed during the persisted cooldown. |
| `recovering` | One recovery cycle succeeded, but recovery is not yet confirmed. | Full work remains suppressed and another bounded recovery cycle is required. |

State is stored in the `ScheduledRuntimeCoordinator` Durable Object. It survives the end of one cron invocation, so the next minute does not forget the active cooldown or recovery progress.

## Serialized leases

Before any scheduled database work begins, the Worker must acquire the singleton coordinator lease.

- Only the holder of the active lease may run scheduled work.
- A second invocation skips without contacting Supabase when a live lease already exists.
- The active invocation renews its lease while work is progressing.
- Completion, containment, and cleanup release the matching lease.
- An abandoned lease expires, allowing a later invocation to recover without a permanent lock.
- Lease identifiers are validated and are not returned through the public readiness payload.

If the coordinator cannot be reached, scheduled work fails closed. SygShift must not fall back to uncoordinated background fanout.

## Failure containment

When a transient scheduled database operation times out or returns a retryable failure:

1. The active cycle stops at the failed operation.
2. The failure, operation, status, timeout flag, and recovery timing are persisted in the coordinator.
3. The circuit moves to `open`.
4. Minute triggers that arrive during the cooldown skip before doing database work.
5. Structured `scheduled_work_contained` and `scheduled_work_skipped` events preserve the operational reason without exposing secrets.

The coordinator applies bounded cooldowns between recovery attempts. The implementation constants are authoritative; do not change the cadence without updating the coordinator tests and this runbook.

## Read-only recovery probe and safe resumption

When the persisted cooldown expires, the coordinator permits one recovery cycle rather than the complete scheduled pipeline.

The recovery cycle:

1. Calls only the read-only maintenance-status check.
2. Does not run timekeeping automation, notification delivery, patrol, document, HR, push, or any other mutating scheduled lane.
3. Records recovery success only after the bounded read-only probe completes.

One successful recovery cycle moves the circuit to `recovering`; it does not immediately restore the full pipeline. A second successful read-only recovery cycle is required before the circuit returns to `closed`. The next separately leased minute invocation may then run the normal full pipeline. A later failure returns the circuit to `open` and preserves the escalation history. Repeated healthy full cycles eventually reset the prior failure escalation.

This progression prevents one brief response from releasing every scheduled lane at once.

## Readiness behavior

`/api/v1/health` answers whether the Worker is serving. `/api/v1/ready` answers whether the release is configured and the scheduled runtime is ready for normal work.

Readiness is degraded when any of the following is true:

- the coordinator binding is missing or unavailable;
- the circuit is `open` or `recovering`;
- the last successful scheduled confirmation is stale;
- another required Worker binding or public/server-side configuration check fails.

The readiness endpoint reads coordinator state. It does not add another direct Supabase probe during an outage. This avoids turning health monitoring into a new source of provider traffic.

A degraded readiness response is actionable evidence, not permission to rewrite data or repeatedly redeploy. Determine whether the coordinator is containing an upstream failure or whether the Worker release itself is unhealthy.

## Normal release gate

Use the repository release command only after the Durable Object lifecycle bootstrap described below is live and verified.

Preferred command with a dedicated read-only release canary configured in the shell environment:

```powershell
pnpm deploy -- --tag=<release-tag> --message="<release summary>" --rollback-safe
```

The approved secret source supplies `SYGSHIFT_RELEASE_CANARY_EMAIL` and `SYGSHIFT_RELEASE_CANARY_PASSWORD`; `SYGSHIFT_RELEASE_CANARY_USERNAME` may bind the result to the expected account. Never place their values in this file, a command transcript, source control, or a client-exposed variable.

If a release canary is not configured, the operator must explicitly accept the weaker anonymous boundary probe:

```powershell
pnpm deploy -- --tag=<release-tag> --message="<release summary>" --rollback-safe --allow-boundary-probe
```

The gate must:

1. Confirm the existing production Worker and upstream Auth, Storage, and secure-access boundary are healthy before changing traffic.
2. Fetch `origin/main`, require a clean working tree, and require local `HEAD` to equal `origin/main` exactly.
3. Record the exact prior Cloudflare Worker version.
4. Run `pnpm check` and the mandatory Time Clock browser workflow.
5. Run a fresh production build after browser testing.
6. Upload one candidate Worker version without changing production traffic.
7. Run read-only Worker checks against the candidate Version URL when Cloudflare supplies one.
8. Reconfirm that production still points to the recorded prior version before promotion.
9. Promote that exact candidate to 100 percent.
10. Require consecutive healthy production and upstream checks.
11. If the promoted Worker remains unhealthy while upstream services are healthy, roll back the exact recorded prior version and verify the rollback.

Workers that use Durable Objects may not receive a candidate Version URL. In that case, the release result must say that candidate URL verification was unavailable. The gate must rely on the baseline checks, exact-version promotion, repeated post-promotion checks, and exact rollback. Do not describe an unavailable candidate check as passed.

If the upstream provider becomes unavailable during post-promotion verification, stop and classify the event as a provider outage. Do not automatically roll back a healthy Worker merely because an independent provider is down; a Worker rollback does not repair Supabase.

Release-only canary credentials are server/operator inputs. They must never be printed, committed, embedded in the client bundle, or forwarded unnecessarily to child build and test processes.

## Two-step rule for Durable Object and configuration lifecycle changes

Do not combine a new Durable Object class/binding/migration or another Worker lifecycle/configuration change with the behavior that depends on it in one rollback-sensitive release.

Cloudflare version upload/promotion is not a substitute for applying Durable Object migrations, trigger changes, or every `wrangler.jsonc` lifecycle change. A rollback to a version from before a new Durable Object class existed may also be unsafe after that migration has been applied.

Use two separately committed and verified releases:

### Step A: infrastructure bootstrap

1. Add only the new Durable Object class export, binding, migration, generated Worker types, and their isolated tests.
2. Do not enable the scheduler behavior that depends on the new coordinator.
3. Push the clean bootstrap commit to `origin/main`.
4. Apply the lifecycle/configuration release through the explicitly reviewed gate below. The gate itself reruns the complete quality gate, mandatory browser checks, and final production build. The full source tag is mandatory so Step B can prove which lifecycle configuration is actually deployed.

   ```powershell
   pnpm deploy:lifecycle-bootstrap -- --confirm-lifecycle-bootstrap --message="Bootstrap scheduled runtime coordinator"
   ```

   The script checks a clean worktree and exact `HEAD == origin/main` before validation. It runs `pnpm check`, the required Time Clock browser workflow, and a fresh production build after that browser test. It then fetches and checks cleanliness and the exact commit again immediately before a single strict `wrangler deploy`, which applies the lifecycle configuration and Worker source together using `source-<full commit>` and a matching `SYGSHIFT_SOURCE_COMMIT` value. It refuses to deploy if generated output, another process, a newly pushed `origin/main`, or a conflicting remote Worker change breaks that source boundary. A reviewed no-change rehearsal may append `--dry-run`.

   Never run this deployment while Step B exists as unstaged or untracked work in the same checkout. Stash it safely or use a separate clean bootstrap worktree first. Do not bypass the gate with a hand-written Wrangler command.
5. Verify root, login, health, readiness, existing scheduled behavior, and Cloudflare migration/deployment status.
6. Record the deployed bootstrap version. It becomes the rollback floor for Step B.

### Step B: operational behavior

1. Add the scheduler integration, readiness degradation, and release-gate behavior in a later commit.
2. Run the full gate again and push the exact commit to `origin/main`.
3. Use the normal candidate/promotion release command.
4. If the operational release fails while upstream services remain healthy, roll back only to the verified Step A version, which already contains the Durable Object lifecycle state.

Do not use a raw deployment as a routine shortcut. The lifecycle path is reserved for an explicitly reviewed configuration bootstrap and must be recorded in the changelog.

## Recovery decision table

| Evidence | Action | Do not do |
| --- | --- | --- |
| Circuit is open/recovering and upstream is failing | Allow persisted cooldown and recovery probes; investigate provider health. | Repeatedly invoke full scheduled work or edit employee records. |
| Coordinator binding is unavailable | Restore the binding/configuration through the reviewed lifecycle path. | Run the scheduler without coordination. |
| Candidate check fails before promotion | Leave production on the prior version and investigate the candidate. | Promote it. |
| Promoted Worker fails while upstream is repeatedly healthy | Automatically roll back the exact prior verified version and verify it. | Guess at another version or redeploy unrelated changes. |
| Upstream fails during post-promotion checks | Stop and classify the provider outage; preserve the recorded versions and evidence. | Claim a Worker rollback will repair the provider. |
| Provider remains unavailable beyond bounded recovery | Escalate through the provider incident process; an authorized operator may pause the cron if containment itself cannot be verified. | Blindly restart services from the user-facing application. |

## Verification checklist

- [ ] Coordinator state persists across separate minute invocations.
- [ ] Concurrent invocations produce one lease holder and zero uncoordinated database calls.
- [ ] Cooldown skips do not contact Supabase.
- [ ] An expired lease can be recovered safely.
- [ ] Recovery performs only the read-only probe and starts no mutating scheduled lane.
- [ ] Two successful recovery cycles are required before full work resumes.
- [ ] A failed recovery returns the circuit to `open`.
- [ ] Readiness reports degraded state without directly probing Supabase.
- [ ] Normal full cycles still run in the established serialized order.
- [ ] Production release requires a clean, pushed, exact `origin/main` commit.
- [ ] Browser tests are followed by a fresh production build.
- [ ] Candidate URL availability is reported accurately.
- [ ] Post-promotion checks distinguish a bad Worker from an upstream outage.
- [ ] Automatic rollback targets and verifies the exact prior Worker version.
- [ ] Durable Object/config lifecycle bootstrap and dependent behavior are separate releases.
- [ ] No employee, schedule, punch, payroll, identity, notification, message, or audit record is rewritten by recovery checks.

## Current release record

Implementation commit: Pending

Bootstrap commit: Pending

Cloudflare bootstrap version/deployment: Pending

Cloudflare operational version/deployment: Pending

Automated test results: Pending

Live root/login/health/readiness verification: Pending
Observed recovery-cycle verification: Pending

Do not replace these fields with estimates. Record exact identifiers and results only after the corresponding step has completed.
