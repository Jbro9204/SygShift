# Overnight Database Stabilization and Recovery

Date: 10/19/2026

Status: Controlled maintenance in progress. This document distinguishes deployed database repairs from staged application work; the full work order is not complete.

## Recovery and ownership

Captured a protected 72,869,685-byte native application database backup containing public/private application records, authentication, storage metadata, and the migration ledger. Verified the complete archive can be read and restored it successfully into an isolated local PostgreSQL 18 database. Recorded production function, trigger, policy, table, column, grant, and 366-entry migration snapshots. Production runs PostgreSQL 17.6; local functional tests complement hosted definition/security rehearsals.

Sygilant's client-email tenant trigger was repaired and deployed from its owning Sygilant repository as migration `20261019225937`, source `db1292a239a98c67a665a75d38360a9b8cadf935`. The 18-table tenant matrix, real outbox insert/update/claim rollback controls, owner/grants/search path, and zero retained test records passed. No client message was replayed or sent as a test.

## Timekeeping and stored procedures

Prepared migrations `20261019230425` and `20261019230743` to materialize candidate priority once and accumulate identical review rows without repeatedly copying JSON arrays. The original maximum 46-day review exceeded its existing eight-second ceiling; the hosted rollback candidate completed in 6.77 seconds. Exact payload/order equality, both payroll periods, older history, empty/future data, all four payroll SQL suites, and forward recovery passed on the isolated restored copy. Payroll calculations, timestamps, punch evidence, and timeout configuration are unchanged.

Prepared migration `20261019230418` for seven genuine HR/import defects: JSON extraction precedence, missing escalation alias, scoped draft/import identifiers, talent-update column qualification, and the actual import `created_at` column. Hosted static/functional and isolated positive draft/escalation/import tests passed. The eighth lint finding is contextual noise from an intentionally transient table; its exact temporary row shape produces zero lint errors without calling the executor or opening the production backfill gate.

Exact deployment status, source commits and after-state will be recorded in the final work-order report; preparation is not deployment.

## Notification and release gates

The notification candidate introduces explicit terminal outcomes, protected evidence, distinct provider-suppression audit status, idempotent retry generations, and compatible browser/Worker behavior. Hosted rollback rehearsals preserved all 930 original queue-row hashes; focused and desktop/mobile rendering checks passed. Its database reader and application must release together: the older deployed browser rejects the new states. It remains staged while production readiness is degraded by the approved maintenance window.

The active 23:00 UTC–11:00 UTC read-only maintenance window correctly blocks scheduled timekeeping writes, making the scheduler freshness readiness check return HTTP 503. Cron remains enabled and database health is normal. No gate or maintenance protection is bypassed. Production application deployment is not authorized by passing isolated tests alone.

## Verification

- Full `pnpm check`: 379 files passed / one skipped; 2,213 tests passed / one skipped, strict TypeScript, zero-warning lint, 74 release tests, build and static-asset contract passed.
- Mandatory actual-component Time Clock workflow and fresh post-browser production build: results recorded in final report.
- No payroll submission, pay-rate edit, identity correction, production reset, or applied-history rewrite.
- Missing migration sources were recovered from owning source trees; unresolved ledger/source equivalence is explicitly retained rather than marked applied.

The complete stage-by-stage morning report is saved under `docs/work-orders/2026-10-19-overnight/`. Windows shutdown requires Jordan's new explicit approval after completion and the final report.
