# Secure Access and Scheduled Work Containment

Date: 10/11/2026
Status: Released to production

## Incident

Production users could not finish the `Checking Secure Access...` step because the shared-session endpoint was
waiting on Supabase/PostgREST connection-pool capacity and returning retryable failures. The minute-triggered
Worker was starting several independent scheduled branches concurrently. When database calls slowed into
multi-minute failures, later minute triggers overlapped the unfinished invocations and amplified the pool pressure.

The browser's original secure-access path could also wait indefinitely for shared-session restoration, Supabase
session activation, or employee session-context loading. That made a recoverable backend incident look like a
permanent loading screen.

## Immediate containment and recovery

- Temporarily removed the production cron trigger so new scheduled invocations would stop adding database work
  while the incident was contained.
- Restarted the Supabase project after the overlapping work was contained, restoring PostgREST and database pool
  availability.
- Confirmed the production application, health endpoint, readiness endpoint, and shared-session endpoint responded
  normally after recovery.
- Preserved the intended minute cron schedule in source. Production reactivation is part of the pending validated
  Worker release, not a separate unreviewed trigger change.
- Made no database migration, schema change, data repair, or destructive record operation. Employee, schedule,
  timekeeping, payroll, notification, audit, and active clock-in records were not rewritten or deleted.

## Secure-access hardening

- Added a 12-second hard deadline around shared-session restoration, shared Supabase activation, local session
  lookup, and employee session-context loading.
- Replaced the indefinite verification screen with an explicit secure-access recovery state and Retry action.
  Transient failures preserve the protected shared cookie and current sign-in instead of falsely treating the
  employee as signed out.
- Continue to fail closed: only a confirmed invalid, expired, or revoked credential can clear the protected shared
  session; an unavailable or malformed service response does not grant access.
- Added abort and session-generation invalidation so a delayed response cannot remount an obsolete session after
  logout, cross-tab clearing, or a newer authentication attempt.
- Isolated shared-session activation in a candidate Supabase client and promote it only after successful
  activation. Failed, cancelled, or late candidates are retired without replacing the working persistent client.
- Commit a successful shared client before best-effort native-session cleanup and ignore authentication events
  emitted by inactive clients, preventing a cleanup `SIGNED_OUT` event from cancelling the completed handoff.

## Scheduled-work containment

- Replaced parallel scheduled branches with one coordinated Worker pipeline and one `waitUntil` owner.
- Run the critical timekeeping automation first, followed immediately by the timekeeping notification lane, before
  patrol, document, HR, general-email, push, or recovery work.
- Serialize Supabase work, including push completion calls, so one cron invocation does not create its own database
  fanout.
- Enforce an 8-second deadline per scheduled RPC and a 45-second database-work budget for the complete invocation.
- Open a per-run circuit breaker on transient pool, network, reset, timeout, or upstream `5xx` failures. Once open,
  the invocation stops starting additional noncritical database work.
- Pass the scheduled-run abort signal into object-storage cleanup and recovery work so those paths honor the same
  containment deadline.
- Preserve signature objects when finalization has an ambiguous commit timeout, and record accepted email delivery
  before best-effort audit logging so an audit outage cannot cause an already accepted message to be resent.
- Move availability recovery to a 15-minute cadence in bounded batches while retaining the minute cadence required
  for critical timekeeping.

## Security and data boundary

- No access token, refresh token, service key, or protected employee data was added to browser persistence, logs, or
  release documentation.
- Authorization and employee-context checks remain required before the application mounts a protected workspace.
- The scheduler changes bound and order existing service work; they do not weaken database authorization or create
  a second source of operational truth.
- No migration is included in this release candidate.

## Verification status

Final source validation passed before release:

- focused authentication/session regressions: 68/68 passed;
- focused scheduler and push regressions: 72/72 passed;
- release-guard regressions: 16/16 passed;
- full `pnpm check`: 370 test files passed, 1 intentionally skipped; 2,135 tests passed, 1 intentionally skipped;
- mandatory desktop/mobile `tests/e2e/time-clock-workflow.spec.ts`: 42/42 passed;
- strict TypeScript, zero-warning lint, production Worker/client build, and static-asset contract: passed;
- fresh production build completed after the last browser test; and
- independent final authentication/session review found no remaining P0, P1, or P2 blocker.

Source commit `265e9d4` was promoted to `origin/main` and deployed through Cloudflare deployment
`5d9aab38-3672-4f71-820e-a5b9a5c1ee00` as Worker version
`db86f26d-7bec-4528-8007-027fc88ae53c`. The intended `* * * * *` trigger was restored as part of that deployment.

Post-deployment verification passed:

- production root, `/login`, `/api/v1/health`, and `/api/v1/ready` returned `200`;
- an unauthenticated, same-origin shared-session check returned the expected `204` without delay;
- all six production entry assets matched the final local build byte-for-byte;
- the clean production login rendered its complete username/password form in the browser; and
- four consecutive coordinated scheduled cycles, including the five-minute attendance safety cycle, completed in
  approximately 3.8 to 4.9 seconds with `outcome: ok`, no exception, and no overlapping multi-minute work.

## Release and rollback boundary

The backend recovery and source hardening are live. Because this change has no migration or data rewrite, rollback
does not require restoring database data or reversing schema state. If the scheduler regresses, the minute trigger
can be contained independently while the production application remains available.
