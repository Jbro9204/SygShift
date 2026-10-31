# Shared database retry safety and report workload isolation — 2026-10-31

## Verified cause and scope

The overnight incident was a shared-resource failure, not a rejected password:
deterministic report conflicts used PostgreSQL SQLSTATE `40001`. PostgREST 14.5
retried those transactions indefinitely. Correct authentication remained
fail-closed while the shared database became saturated.

The two offending report guards were repaired during the morning incident.
A fresh catalog audit subsequently inspected 101 candidate function definitions
and identified another 46 functions containing 75 explicitly raised,
deterministic application conflicts: seven SygShift functions and 39 Sygilant
functions. Each condition was reviewed; genuine engine serialization/deadlock
handling was not replaced.

## Database correction (applied)

- Changed only the reviewed rejection tokens to `PT409`, preserving conditions,
  messages, locking, business writes, ownership, grants and function settings.
- Applied three forward-only migrations atomically after a rollback rehearsal:
  `20261031183447`, `20261031183448`, and the service-only read-only runtime-budget
  diagnostic `20261031183920`.
- Every target was fenced by its exact before/after definition and non-body
  catalog metadata fingerprints. Existing migration history was not rewritten.
- The ledger advanced from 436 to 439, with all 436 earlier entries unchanged.
  The selected incident report, versions, decisions and audit hashes were
  unchanged. No employee, payroll, punch, schedule, identity, permission or
  licensing records were edited by these migrations.
- Actual PostgREST service-role measurement reported an eight-second statement
  timeout and eight-second lock timeout. Neither setting was changed.
- Postflight found no remaining explicitly raised retry errors in the inspected
  catalog; all 46 target definitions and security fingerprints matched.

## Application prevention

- Sygilant serializes report saves, takes the authoritative version from the
  server, stops queued successors after failure and preserves the draft.
  Uncertain saves are not automatically replayed with a new operation key.
- Header and body reads have cancellation-aware deadlines. Explicit bounded
  callers retain their existing longer deadline where applicable.
- A separate, additive Durable Object coordinates only report workload. It is
  behavior-neutral until explicitly bound and enabled in Sygilant. Authentication,
  timekeeping and payroll retain their existing authorization and paths.
- The report admission limit is not a claim of dedicated database capacity.
  The applications still share PostgreSQL/PostgREST. Provider failures and
  workloads outside this lane remain separate operational risks.
- Mandatory release checks now reject newly introduced explicit transaction-
  retry errors, inspect effective production definitions, and test actual
  PostgREST behavior in a disposable synthetic database.

## Verification and release controls

The local PostgreSQL 18.3 / PostgREST 14.5 test completed 60 conflict requests
with exactly 60 rollbacks while 20 access probes succeeded, with no lingering
requests or synthetic source changes. This proves transport/error behavior,
not every business workflow in the 46-function set.
The disposable server explicitly disables Unix sockets, so Linux package
defaults cannot make it depend on a protected system socket directory. Startup
failures retain their server diagnostic log; process shutdown is bounded.

Source delivery still requires the full exact-candidate release gate, desktop
and mobile Time Clock matrix, GitHub checks, behavior-neutral lifecycle
bootstrap, controlled Pages binding activation and post-deployment checks.
Production version identifiers and final rollout results belong in the release
execution record; source changes alone are not proof of deployment.

The refreshed ownership baseline retains the earlier documented reconciliation
exceptions. It verifies non-drift; it does not declare old unresolved migrations
equivalent or authorize a bulk replay. The six intervening Sygilant migrations
match their statement arrays exactly. The two morning hotfixes match their
single-element whole-source ledger envelopes exactly.

## Safe fallback

Report admission can be disabled without bypassing authentication. An application
rollback must retain the installed retry-safe database definitions; restoring
the unsafe `40001` business guards would recreate the incident. Correct any
new database discrepancy with a reviewed forward migration, not history edits.

Private incident and deployment artifacts are retained locally under
`tmp/incident-20261031` and `tmp/reliability-20261031`; they are not public source.
