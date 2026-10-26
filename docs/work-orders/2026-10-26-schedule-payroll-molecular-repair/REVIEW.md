# SygShift Schedule and Payroll Molecular Repair

Date: 10/26/2026  
Status: clean preview and local release verification complete; production release pending  
Application boundary: SygShift only

## Incident scope

Two authenticated SygShift workflows returned PostgreSQL `57014` statement timeouts on 10/26/2026:

- opening or preparing an edit for a published schedule block;
- loading payroll/time-correction exception review.

The same visible error does not make these one query. Each path has its own data model and must pass its own preservation and performance gates.

## Verified production evidence

- `authenticated` and `authenticator` retain the intended eight-second statement timeout. This repair does not raise or disable it.
- Production restarted at `2026-10-26T13:32:36.804670Z`; post-restart statistics therefore describe only the new statistics interval.
- `ensure_schedule_draft(date)` completed once in 3,519.83 ms during that interval.
- `get_timekeeping_review(date,date)` completed 12 times with 3,099.04 ms mean and 4,227.25 ms maximum execution time.
- The separate payroll-category request completed 22 times with 1,229.18 ms mean and 2,357.23 ms maximum execution time even though the authoritative review payload already contains payroll category results.
- `schedule_assignment_overrides` has 9,145 rows and no index beginning with its `shift_id` foreign key. Since the restart it recorded 3,124 sequential scans and 28,540,547 rows read.
- The minute scheduled lane is also material database load: `service_run_timekeeping_automation(uuid)` recorded 190 calls, 807.67 ms mean, 1,870.58 ms maximum and 153,457.83 ms cumulative execution time.
- The reported Supabase CPU alert occurred at approximately 02:00 America/Denver, the configured daily full-reconciliation boundary. This is a correlation requiring workload-plan confirmation, not by itself proof of causation.
- Current application health and readiness returned HTTP 200 with `ready=true` and `consecutiveFailures=0` before the candidate was applied.

## Root invariants

### Schedule

1. Opening an editor is a read operation. It must not create a revision, clone a week, write audit rows, or alter coverage.
2. Saving one edit is one idempotent, atomic command. The command either creates the required draft state and applies the exact change, or commits nothing.
3. Published revisions remain immutable. Draft behavior must retain qualification, availability, overlap, armed-override, overtime, dispatch, capacity, permission, MFA and audit enforcement.
4. A retry must not clone a second week or duplicate assignments/overrides.
5. Publishing must still produce one complete versioned schedule and preserve the prior revision.

### Timekeeping and payroll

1. Effective punches, approved corrections, operational occurrence ownership, payroll-week allocation, category allocation and overtime remain separate explicit stages.
2. One authoritative review request computes each stage once for the requested bounded range and its required Sunday-boundary context.
3. Overview, employee detail, exception review, breakdown and export consume the same canonical minutes and classifications.
4. Overnight pairs are completed before workday/payroll slicing. Incomplete pairs remain explicit blockers.
5. Source punches, corrections, locked payroll, audit rows and configured payroll policy are immutable during this repair.
6. SQLSTATE `57014`, authorization failures and validation failures are not automatically retried as generic transient reads.

### Runtime workload

1. Interactive schedule and payroll queries must not compete with repeated unbounded reconciliation scans.
2. Recurring work must be bounded, idempotent and indexed by its actual candidate predicates.
3. Full reconciliation remains a safety net, not the primary per-minute processing path.

## Release gates

- Execute database regressions in one rollback-only transaction against an isolated production-compatible database.
- Compare ordered payloads before and after, excluding only intentionally variable server timestamps.
- Verify original and candidate owner, ACL, `SECURITY DEFINER`, `search_path`, volatility and grants.
- Verify AAL1 denial, AAL2/effective-permission authorization and unauthorized direct-RPC denial.
- Cover adjacent pay periods, Sunday midnight, overnight shifts, DST, breaks, adjustments, incomplete pairs, mixed payroll categories, locked payroll and retry/idempotency.
- Capture before/after timings for representative current, prior and maximum supported ranges under serial and bounded concurrent load.
- Prove schedule editor open performs no database mutation.
- Prove authorized saves by readback and prove failed saves leave no partial revision.
- Run focused tests, `pnpm check`, the mandatory time-clock browser regression, a fresh production build and `pnpm release:verify`.
- Apply migrations in reviewed order, verify ledgers and protected fingerprints, deploy the exact verified commit, and confirm health/readiness plus authenticated workflow behavior.

## Rollback boundary

Recovery is forward-only. No applied migration is edited or removed. Every schema/function change has a reviewed inverse template that must be placed in a fresh migration version before use. Source punches, schedules, payroll rows, identity, permissions and audit history are never deleted to recover this release.

## Verified repair

### Schedule editor

- Editor open is now read-only. It does not create a draft, clone a schedule, write an audit event or change coverage.
- The first Save performs draft materialization, source-to-draft lineage and the exact shift update in one atomic command.
- An optimistic version token rejects stale browser state instead of overwriting a newer edit.
- The missing assignment-override lookup index is built online before the function release.
- Rollback-only regression proves authorized save/readback, no mutation on open, stale-edit rejection, MFA denial, retry idempotency and no partial revision after failure.

### Timekeeping review

- The browser now calls one MFA-protected canonical review RPC instead of issuing three overlapping review/category/work-type requests.
- Effective punch reconstruction is routed through a trigger-maintained derived projection with the original punches and correction ledgers left authoritative and unchanged.
- The bounded resolver completes an occurrence across the requested edge before payroll slicing. Incomplete pairs remain explicit exceptions.
- Mid-week salary and carried-overtime behavior is preserved by using the original exact bounded calculation for partial-week and maximum supported ranges.
- SQLSTATE `57014` is not retried automatically; the browser presents a clear no-write failure.

### Runtime workload

- Per-minute automation materializes due shifts before joining assignments and effective event history.
- Stable `statement_timestamp()` bounds make the due indexes sargable; wall-clock audit/job timestamps remain unchanged.
- Full attendance reconciliation stays at 02:00 America/Denver. The separate operational-alert full pass moves to 02:10, with the normal 02:15 recovery pass preserved.

## Clean preview evidence

The exact eight-phase release bundle was applied in order to a fresh production-shaped Supabase branch. Three online indexes were installed outside transactions and each was validated before its exact migration source was entered in the ledger.

- Pre-change cold current-period review: 7,120.393 ms, 133 rows.
- Post-change cold current-period review: 4,932.896 ms, 133 rows.
- Post-change warm current-period review: 788.683, 822.055 and 808.011 ms.
- Three simultaneous current-period reviews: 981.162, 1,388.916 and 1,398.651 ms.
- Every serial and concurrent call returned the same stable payload digest.
- Maximum 46-day candidate range: 3,098.093 ms in the clean preview. This path intentionally retains the exact correctness fallback and therefore has less headroom than a normal pay period.
- Effective-range plan: `timekeeping_effective_projection_at_idx`, index-only range scan, 463 rows, 0.221 ms.
- Prior-close plan: `timekeeping_effective_projection_open_close_idx`, index-only range scan, 0.209 ms.
- Full bounded effective-event resolver: 547 rows, 81.056 ms.
- Runtime due-end plan: `shifts_timekeeping_due_end_idx` with an actual index condition, 2.121 ms.
- Runtime start boundary: indexed range plan with an actual index condition, 2.707 ms.
- Full runtime service cycle under a deliberate rollback: 177.287 ms; the probe job ID had zero persisted rows afterward.
- Projection backfill reconciled 2,776 source events to 2,776 derived rows with both maintenance triggers installed.
- Authenticated statement timeout remained eight seconds.

All new regressions passed, together with event classification, payroll-week elapsed allocation, payroll categories, row collection, DST and overnight attendance suites. The release was then reversed in dependency order on the disposable database. Original schedule/runtime function hashes were restored, all three online indexes and the projection/v2/atomic-RPC boundaries were removed, and authoritative row counts remained exactly unchanged. The preview branch was deleted after proof.

## Local release gates

- Independent security and migration audit: no release-blocking finding.
- Fresh cross-repository ownership review captured the current 388-entry production ledger and the clean Sygilant source tree; the reviewed expected post-activation manifest preserves those entries and appends only the ten exact release identities. See `DATABASE_BASELINE_REVIEW.md`.
- `pnpm check`: pass; 2,501 tests passed and one skipped, 207 release tests passed, typecheck/lint/build/static-asset validation passed.
- `pnpm release:verify`: pass; repeated full check passed, 42/42 desktop/mobile Time Clock browser tests passed, final production build passed.
- `git diff --check`: pass.

## Operational cautions

- Resume an interrupted online-index release at its ledger-validation phase after the raw index succeeded; do not blindly rerun the raw phase.
- Full schedule recovery uses the coupled `20261026151000` inverse for both schedule migrations. The partial-only `20261026142017` recovery must not run afterward.
- Production remains unchanged until the exact commit passes repository CI and the reviewed release sequence is explicitly applied.
