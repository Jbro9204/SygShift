# Overnight Database Stabilization and Recovery

Date: 10/19/2026

Status: Partial completion. Ten forward database repairs are installed and independently validated. The notification application release and historical migration reconciliation remain blocked; the full work order is not complete.

## Installed repairs and recovery

Captured a protected 72,869,685-byte native production archive, full definitions/security metadata, 366-version ledger and source bundle. A complete isolated restore succeeded. Production PostgreSQL 17.6 and local PostgreSQL 18 differences were covered by hosted definition/security and rollback rehearsals. No credentials or employee exports were committed.

Sygilant's 18-table client-email trigger repair `20261019225937` was deployed from its separate owning source tree. Existing scheduled drainage recovered six eligible missed communications, accepted once each; no manual replay or test message occurred.

SygShift installed HR/import correction `20261019230418` fixes seven genuine PL/pgSQL errors. Raw lint is eight findings before versus one afterward; the remaining temporary-table context finding produces zero errors under its exact empty temporary row shape. The backfill executor was never called and its production gate stays closed.

Timekeeping versions `20261019230425`, `20261019230743`, `20261019234005` and `20261019235117` remove repeated priority computation, growing JSON copies, repeated category scans and occurrence-gap rescans. Exact ordered payloads, payroll, historical/current/future ranges and recovery tests passed. An intermediate release failed one controlled eight-second maximum probe; the later installed state passed maximum probes at 7.540/6.436 seconds and historical review at 3.217 seconds. That pre-index slowest pass had only 460ms headroom. The targeted covering index 20261020001516 was then installed concurrently from a9bccf6; latest maximum probes pass 5.370/5.149 seconds, current 2.034 seconds, and actual heap visits decrease39.3%. All 13 fresh protected-table fingerprints pass. The eight-second RPC ceiling and payroll formulas remain unchanged; separate bounded online DDL uses 30 seconds/two-second lock.

Audit version `20261019232727` suppresses only shift UPDATE audit records whose sole difference is updated_at. All business fields, other tables, INSERT/DELETE and existing history remain preserved. Authorization version `20261019233625` enforces the existing import-review permission, credential RLS and support-admin MFA. All original function owners/ACLs and RLS policies remain intact.

Urgent-access version `20261019235642` preserves employee sick/call-off and the separate Dispatch-result marker during read-only maintenance through scoped, sealed transaction capabilities. Nine local groups, six hosted rehearsal groups, six installed groups, four rendered desktop/mobile tests and three component tests passed. Fresh cleanup confirmed zero capability/test records and unchanged before/after counts. Other maintenance barriers remain active and Time Clock remains excluded.

## Preservation and release controls

The ledger now has 376 versions. The final reviewed v2 baseline and real fresh 376-version nondrift gate pass; strict history reconciliation still refuses 38 known gaps. No applied history was rewritten. Original missing sources and exact divergent SQL capsules were recovered under their correct owners. Twenty timestamp differences and eighteen NULL/empty historical statement arrays remain unproven. A tracked v2 ownership manifest and fresh-production nondrift gate are mandatory for normal releases; strict history reconciliation still rejects those 38 cases and does not authorize bulk push.

The notification candidate preserves all 930 original queue rows under rollback and has terminal immutability, provider-code suppression and linked retry-generation tests. Its versioned old-client compatibility bridge is tested and pushed on a separate review branch. Production activation remains held for exact pending-provider outcomes, a fresh hosted/source gate and normal readiness/authenticated canaries. Read-only provider evidence confirms 29 intended deliveries but one remaining target-specific outcome is unavailable; no replay occurred. No Worker or Pages application deployment occurred.

Approved maintenance runs 23:00-11:00 UTC. Readiness remains 503 because scheduled writes are intentionally blocked, with runtime failure count zero; health and app roots return 200. No window, readiness result, provider session or release gate was overridden. A normal full cycle after authorized maintenance expiry/closure is still required.

## Validation and handoff

- Main full gate: 2,204 tests / 378 files passed, one skipped each; TypeScript, zero-warning lint, all 95 release-control tests, build/static assets passed.
- Actual Time Clock matrix: 42/42 desktop/mobile checks. Urgent UI: four browser and three component checks. Fresh production build passed after browser tests.
- Sygilant full suite: 2,181 tests passed. The final held notification branch `42e69c3` passed 2,241 tests / 381 files, 97 focused tests and 95 release controls; 42 Time Clock browser checks and a fresh production build passed again. Its future-only accepted provider-ID capture and audit-failure handling remain undeployed.
- Twenty-five selected protected workforce/payroll/client/licensing table fingerprints matched the restored baseline at their recorded checkpoints. Normal later live activity is reconciled separately; rollback-only fixtures leave no persistent records.
- Final catalog comparison: exactly 21 intended function definitions changed, two private helpers and one sealed capability table/constraint trigger added; zero removed objects, owner/ACL changes, changed policies or changed pre-existing columns/triggers.
- No payroll submission, pay-rate edit, production reset, history deletion or compatibility table was performed.

The complete stage report, migration/deployment identifiers, hashes, test receipts, limitations and next actions are saved in `docs/work-orders/2026-10-19-overnight/MORNING_REPORT.md`. Follow-on retention/partition designs require approved preservation and retention rules before destructive activation.

Jordan's latest instruction revokes automatic shutdown because the computer is in use. No shutdown is queued. Leave Windows running.
