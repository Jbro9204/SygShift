# Hardening evidence and controlled next changes — 10/19/2026

The approved work order permits analysis of follow-on hardening and production changes only after independent validation. No audit or job history was deleted, partitioned in place, or assigned an invented retention period.

## Audit growth

At 23:22 UTC the append-only audit contained 313,694 records and occupied 577,871,872 bytes (551.1 MiB). Of 1,012 shift UPDATE audit records in the preceding 24 hours, 471 changed only `updated_at`. The earlier audit's 5,800 count used a different window and must not be presented as this run's measurement.

The narrow writer repair is installed as `20261019232727` from source `257eda82378b44e80f60bee5eb4c59c5b9b63f73`. The existing `private.write_audit_event` returns NEW only for public.shifts UPDATE rows whose timestamp differs and whose complete OLD/NEW JSON values are identical after removing `updated_at`. It retains every material column change, INSERT, DELETE, actor and prior audit record. Exact 23-business-column, future JSON, NULL timestamp, other-table and real draft-shift rollback regressions passed; hosted metadata/lint/drift-refusal/recovery checks passed. All 104 attachments and security metadata remain exact; immediate before/after audit and shift counts match. See `SHIFT_AUDIT_TIMESTAMP_REPAIR.md` for fingerprints and preservation limits.

Monthly partition/archive work needs a separately rehearsed copy-and-compare migration because moving a populated append-only relation can change primary-key, dependency, trigger and query behavior. Keep the original relation readable; copy only to protected storage; compare row counts and ordered checksums; verify retrieval and isolated restoration before redirecting any read. There is no approved deletion date or legal-hold policy in the recovered order, so all evidence remains retained. An in-place rewrite is not justified by current capacity.

## Targeted indexes

Four installed query-structure repairs removed repeated aggregates, growing JSON copies and category-map expansion. Measured residual work still performed 51,041 shift heap lookups. The independently tested nonunique partial covering index `20261020001516` was installed concurrently at 00:35:26 UTC after full source/quality/fresh-ledger gates. Existing primary key, all rows, all old indexes, RLS and formulas remain intact.

Two installed maximum reviews now pass 5.370/5.149 seconds and current review 2.034 seconds under the unchanged eight-second limit. The actual production plan performs 30,981 heap fetches, about 39.3% fewer than the previous lookup path. The fixture's 98% reduction was not projected onto production. All 13 fresh protected-table count/full-row SHA-256 comparisons and six source/security checks passed. Eight payroll/scheduling suites, five full payload comparisons, clock/idempotency, 100-row draft-write restoration and 17 concurrent lifecycle/refusal/recovery checks passed. The 4.28 MiB index adds measured write cost; bounded probes do not guarantee all future loads. See `TIMEKEEPING_COVERING_INDEX.md`.

The historical 738 foreign-key notices remain a workload-review backlog; no bulk index set was installed. Further candidates require actual plans, call count, relation size, write cost, lock budget and result equality. No retention or autovacuum policy was invented.

## Job retention

The timekeeping run ledger contained 85,161 records and occupied 14,729,216 bytes. `public.timekeeping_operational_exceptions.job_run_id` references it with ON DELETE RESTRICT. A prune job would therefore either fail or destroy required explanatory links. Keep all referenced/failed runs, define the actual operational retention and legal-hold policy, then design an archive/rollup preserving original identifiers and exact retrieval. No DELETE, CASCADE, retention cron, or new external storage credential was installed.

## Authorization

Manual tracing of the 35-function screen identified three concrete issues, now repaired by installed `20261019233625` from pushed source `7f867dc630105d42f7ea472f3febb11d9198b017`. Source preview now enforces the existing import-admin boundary; direct credential predicates honor existing self/Licensing RLS through SECURITY INVOKER; support's elevated Admin branches require existing verified MFA. Nine restored-fixture groups, five hosted groups, exact release/forward recovery and drift-refusal checks passed; installed hashes, owners, ACLs, configurations and protected counts match. No production role or employee permission was changed or broad grant introduced. See `AUTHORIZATION_REVIEW.md` and `AUTHORIZATION_CANDIDATE.md` for original evidence, installed fingerprints and remaining review limits.

The separately discovered full-maintenance restriction on employee sick/call-off writes has a narrow transaction-bound capability repair, including the deployed Worker's separate Dispatch result-marker transaction. Its nine local groups, six hosted rollback groups and four desktop/mobile plus three component UI tests passed. Activation and installed validation are reported in `MORNING_REPORT.md`; these checks do not clear maintenance or authorize manager/payroll writes or the held notification release.

## Migration release enforcement

The normal `pnpm deploy` entry requires a fresh read-only database gate before its existing release controls, including dry runs. The standalone `pnpm database:release:gate` uses the same committed reviewed v2 baseline, separate owning-source root and pinned official CLI ledger capture. Dirty or staged baseline changes, exact statement-array drift (including NULL versus empty), applied identity changes and owning-source checksum drift fail closed without a force option. Ninety-five release-control tests pass. Real fresh-ledger checks passed against committed stage snapshots before reviewed activations; the final376-version v2 manifest is committed in f1193df and its real fresh-ledger gate passed. All 366 original ledger rows remain exact. Twenty historical timestamp/name differences and eighteen NULL/empty statement arrays remain unreconciled; an exact nondrift baseline does not permit bulk database push.

## Signature monitoring

`tools/sql/database-maintenance-signatures.sql` is an eight-second, read-only aggregate monitor. It emits stable classes, occurrence counts, first/last seen, and actionable status without addresses, raw failure text, or employee identifiers. Intentional blocked-domain and exact structured provider suppressions are separate classes. Planned maintenance blocks are expected; unclassified legacy delivery failures stay actionable until evidence supports classification. It performs no send, alert subscription, provider call, or data mutation.

Cloudflare's existing telemetry independently confirms minute cron execution and `scheduled_runtime_full_success_withheld` with failed lane timekeeping_automation solely because the approved read-only window rejects its writes. The correct response is to preserve the maintenance/readiness boundary and verify a normal full cycle after an authorized close or expiry; do not relabel that stale full-success timestamp as healthy. No additional automation or alert destination was created.

## Validation status

The native production backup was restored successfully. Counts and full-row multiset SHA-256 matched on thirteen workforce/payroll and twelve client/licensing relations (twenty-five selected protected tables) at the recorded 23:54:36/23:59:23 UTC checkpoints. The later operational punch and matching audit addition are reconciled in `LIVE_ACTIVITY_INTEGRITY.md`; all 2,568 original punch rows retain their exact baseline hash. Hosted security/performance advisors reported zero error-level findings after the trigger repair. No invalid application indexes or unvalidated application constraints were introduced. A provider-owned NOT VALID check on realtime.messages is outside application ownership and was left untouched. The notification candidate remains undeployed because its coordinated application/database release gates have not passed; monitoring and preservation designs do not override those gates.

Closing preservation at 00:36–00:38 UTC: all 13 workforce/payroll relations match the fresh pre-index snapshot including the legitimate clock-out, while all 12 client/licensing relations still match the original restored baseline. The original 2,568 punch rows are independently unchanged. Final health has 19/60 connections and zero blocked/idle/deadlocked sessions or invalid application objects. These are selected-table and sampled-health proofs, not all-database or continuous-availability claims.

## Final disposition

The 00:48 UTC HTTP recheck still returns health/login/Sygilant 200 and readiness 503 solely for scheduled-runtime freshness, with zero consecutive failures and unchanged deployment identities. The bounded signature query was executed successfully; it is not a continuous alert subscription. Audit partition/archive and job retention remain deferred until approved retention/legal-hold rules and reader/retrieval/restore contracts are proven. No deletion or cleanup cron was installed. The isolated restored PostgreSQL fixture was cleanly stopped at 00:42:32 UTC and its private data secured. Windows remains running under the latest direct human shutdown revocation.
