# Required-Action Checkpoint Resilience

Date: 10/23/2026  
Status: Released and independently verified in production
Database migration: None  
Cloudflare lifecycle/configuration change: None

## Incident and verified cause

Cloudflare continued serving SygShift and `/api/v1/health`, but intermittent Supabase Auth/REST latency exceeded the existing five- and eight-second Worker deadlines. The scheduled-runtime circuit correctly contained the background failures and recovered automatically. The same upstream interruption also caused shared-session and required-action requests to fail.

The application had a separate, older design flaw: `AppShell` treated every required-action detail-query error as proof of a real blocking checkpoint. A temporary network, pool, or provider failure could therefore replace the entire verified workspace with **Required actions could not be verified**. The query also had no cancellation signal or deadline, so it could hold the initial **Checking required actions** state indefinitely.

Scheduler readiness did not directly lock the browser. The scheduler and browser request were independent consumers of the intermittently failing Supabase data plane.

## Root repair

- Required-action blocking is now based only on successfully returned authoritative checkpoint data where `blocking` is true. An unknown transport result is no longer converted into a positive policy decision.
- A failed refresh keeps the already verified workspace mounted and shows a clear warning with a manual Retry action while automatic polling continues.
- Authentication, shared-session verification, MFA, effective permissions, route authorization, and protected database/Worker operations remain fail-closed.
- Server-computed effective permissions remain authoritative. A real required-action checkpoint continues to strip protected permissions at the database boundary and redirect the employee to the Action Center.
- Previously cached `blocking: true` data remains active if a background refresh fails; a transient error cannot erase a verified block.
- The required-action RPC now receives React Query cancellation and is bounded by an eight-second application deadline instead of being allowed to stall indefinitely.
- Required-action cache entries are now cleared with other employee-scoped data on sign-out or account change, preventing stale checkpoint state or private action details from carrying into a later browser session.

## Preserved boundaries

- No employee, identity, required-action, schedule, punch, payroll, notification, message, permission, or audit record was edited.
- No database function, RLS policy, role grant, Worker binding, Durable Object, cron trigger, or release configuration changed.
- A cold-start authentication or session-context failure still withholds the protected workspace. This repair does not pretend that an unavailable identity provider has verified a user.
- The scheduler circuit, recovery probes, fencing, and degraded readiness behavior remain unchanged.

## Regression coverage

- Verified workspace remains available with warning and Retry when required-action details are temporarily unavailable.
- Retry recovery removes the warning without remounting or signing out the employee.
- A real blocking checkpoint still redirects to the Action Center.
- Cached blocking data remains enforced after a refetch failure.
- A stalled checkpoint request is aborted at the bounded deadline and degrades to the verified workspace.
- Supabase receives the request cancellation signal.
- Required-action cache data is purged on session teardown.
- Existing secure-session timeout tests continue to prove that unverified authentication remains fail-closed.

## Verification and release record

- Focused checkpoint, lifecycle, cancellation, cache, and static guard suite: 42 passed.
- Strict TypeScript: passed.
- Zero-warning application and Worker lint: passed.
- Full `pnpm check`: passed with 381 test files and 2,221 tests, plus one intentional skipped file/test; all 174 release-governance tests and the production builds/static-asset contract passed.
- Mandatory desktop/mobile Time Clock release workflow: passed, 42 of 42 tests.
- Full `pnpm release:verify`: passed, including a fresh production build and static-asset validation.
- The production release gate correctly refused a stale 379-entry migration baseline. Seven subsequent Sygilant
  migrations were reconciled read-only against clean Sygilant source `f9dc221e3281ee5c503579c13cc92e09124cc4a3`;
  the replacement 386-entry baseline records only those expected additions and authorizes no migration replay.
- Exact pushed source `6070d5e49daac7854fd8c97c331c87fd97c8f03d` passed GitHub workflow
  `39986304707`: the Exact candidate quality gate and CodeQL JavaScript and TypeScript both succeeded.
- The rollback-safe production release revalidated the fresh 386-entry migration ledger, reran the complete
  local release gate and mandatory Time Clock workflow, and promoted exact Cloudflare Worker version
  `75910843-52c3-433f-b70b-676e790714dd` at 100 percent. The prior version was retained for rollback and no
  rollback was required.
- Cloudflare did not provide a candidate Version URL, so candidate-only HTTP smoke was reported as unavailable
  rather than passed. No dedicated authenticated release-canary credentials were present in the approved
  operator environment; the documented anonymous boundary probe was used for the automated release boundary,
  followed by an independent signed-in browser verification.
- Three independent production samples returned `/api/v1/health` healthy and `/api/v1/ready` ready with the
  scheduler closed, zero consecutive failures, fresh runtime evidence, and source commit
  `6070d5e49daac7854fd8c97c331c87fd97c8f03d`. A natural full scheduled-runtime cycle completed on the new
  source at `2026-10-23T16:35:11.556Z`.
- The production HTML referenced the new entry bundle `assets/index-dldzzek7.js`. A signed-in owner-session
  refresh visibly progressed through **Checking required actions...** and reopened the normal Operations
  workspace without showing the false verification lockout.

## Remaining limitation

SygShift cannot make Supabase Auth or the data API available during a provider outage. A user whose identity and session have not yet been verified must still wait for secure-access recovery. This repair removes the false whole-workspace block caused by the secondary required-action detail request without weakening that security boundary.
