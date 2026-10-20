# Targeted timekeeping covering index

Date: 10/19/2026 maintenance run; prepared 10/20/2026 UTC.

Status: reviewed source and recovery prepared; production activation pending the source/baseline gates. The full application quality gate passed. Four prior query optimizations remain installed. Their slowest maximum-range pass leaves only 460ms under the unchanged eight-second review ceiling.

Version `20261020001516` adds one nonunique partial covering B-tree on shift ID, including existing start/end/schedule fields where canceled_at IS NULL. It preserves the primary key, all rows, calculations, access rules and existing indexes. Frozen LF-only source SHA-256 `8375774382342cd457ae39cece2f1eac8a4ae8e5351c0839f5171242f9d6d75d` matches Git's clean bytes. Separately reserved forward recovery `20261020002135` removes only that exact index and retains the original applied ledger row.

Local evidence: 51,041 heap lookups become index-only probes with 916 heap fetches; one complete review pair improved from 1,380.124 to 1,242.081ms. Production visibility preflight is 64.32%, so the local 98% heap reduction is not a production promise. Four payroll and four scheduling SQL suites, five exact ordered review payloads, complete effective-event equality, actual authenticated clock/break/out and idempotency, and 100-row draft-shift write/restoration checks passed. The extra B-tree has measured write cost; HOT eligibility is unchanged.

Seventeen native lifecycle/refusal/recovery checks passed, including real canceled build/drop states and exact guarded resumption, duplicate/changed-source/wrong-index/unrelated-invalid refusal, forward recovery and ambiguous completed-drop ledger resumption. The isolated clone's original definitions/security/ledger/index state was restored.

Production native read-only preflight passed with exact installed function/security/type/PK/RLS guards, 15 connections and no blockers/old transactions. Pinned verified TLS is required. The native protocol uses a separate 30-second DDL budget and two-second lock budget; the authenticated RPC ceiling remains eight seconds. Concurrent DDL is executed outside a transaction; its exact complete source text is ledgered only after valid exact-index verification. No transaction-wrapping bulk migration push is permitted. Credentials are transient, protected and removed after each invocation.

Full source, evidence limits, protocol hashes and fallback steps: `docs/work-orders/2026-10-19-overnight/TIMEKEEPING_COVERING_INDEX.md`. Installed timings, plan, integrity and activation identifiers must be recorded after the production gate passes; preparation alone is not completion. No application deployment or maintenance override is part of this change.
