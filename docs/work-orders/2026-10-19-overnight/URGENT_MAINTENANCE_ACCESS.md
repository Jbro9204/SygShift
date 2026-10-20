# Employee urgent access during maintenance

Prepared and independently rehearsed October 19–20, 2026. This document records the candidate and evidence before production activation. It does not authorize COMMIT, close a maintenance window, bypass readiness, or claim email delivery. The separate notification DB/browser/Worker rollout remains held under its own gates.

## Root cause and complete request chain

The active full-database maintenance window protects `time_attendance`. `private.enforce_maintenance_feature_write()` applies a blanket rejection to inserts/updates on attendance events, their creation history, call-off reports and call-off actions. The deployed employee form uses `report_attendance_accountability_event`, which legitimately writes all four relations; an active employee's own urgent sick/call-off report is therefore rejected during maintenance.

After that employee RPC returns, the deployed Worker sends its audited Dispatch email and calls `service_mark_attendance_accountability_dispatch_result` in a separate service RPC. That marker updates the same protected attendance table. Repairing only the first RPC would permit an email followed by a database error and could defeat the existing already-notified retry check. Both transaction boundaries must work.

No Worker or product UI source change is required for this repair. The actual employee MyTime and Requests components remain accessible and their sick/call-off controls work under the current full read-only notice; separate component and desktop/mobile browser evidence is described below.

## Narrow exception and preserved boundaries

The candidate introduces a real private security capability table, not a compatibility table. It is sealed from PUBLIC, anonymous, authenticated and service roles, with RLS and FORCE RLS. Only the existing trusted definer RPCs issue a capability after their existing validation. Capabilities bind the backend PID, full transaction ID (`xid8`), scope, exact employee, event/occurrence and, for an employee request, the authenticated user. Caller-controlled GUCs confer no authority.

The employee capability begins only after active-account, self-assignment, allowed event-type, note and date validation. It permits only:

- Self-originated `reported` sick/call-off event INSERT, with no reviewer/decision/duplicate fields.
- That event's exact `created` action, actor, reason, timestamp and complete after-snapshot.
- Self-reported call-off INSERT for the validated shift, with self as receiver/reporter and no acknowledgment, resolution, cancellation or announcement fields.
- The matching `created` call-off action and exact report snapshot.
- Linking the exact own canonical attendance event to its same-occurrence own call-off report, changing only the link and timestamp. An existing canonical no-call/no-show may receive that link; the employee cannot create or reclassify a no-call/no-show.

The separate existing service-only Dispatch marker issues a second scope for the exact target event and intended delivery-result values. It permits only `dispatch_notified_at`, `dispatch_notification_error` and `updated_at`. Eligibility is independently checked by the issuer and trigger helper: an employee-created sick/call-off, or an existing absence/canonical no-call/no-show linked to a report whose receiver and reporter are that same employee and whose occurrence matches. Nonurgent service-generated/manager records remain maintenance-blocked. Outside maintenance, the original marker's supported behavior and service EXECUTE ACL remain unchanged, including its original role-check expression, missing-target result, error truncation, and preservation of an accepted timestamp on a later failed result.

Both RPCs delete their capabilities before returning and unwind them on errors. A deferred constraint trigger rejects any capability that survives transaction end, so a missed cleanup cannot commit a reusable capability. No capability row is retained as history. Existing audit, action, queue and absence records retain their ordinary behavior and ownership.

All other feature/table/operation checks still use the original maintenance rejection. There is no table-wide exemption, new browser grant, new service table grant, manager-on-behalf exemption, payroll/schedule allowance, maintenance-window edit, MFA bypass, or time-clock policy change. The existing three function OIDs, signatures/defaults, owners, ACLs, language, volatility, strictness and search paths are checked before and after the patch.

## Exact sources and recovery

The Supabase CLI reserved these names in an isolated temporary work directory. Their source files remain staged outside active migration discovery until the parent approves and activates them:

- `20261019235642_preserve_employee_urgent_maintenance_access.sql`
- `20261019235644_recover_employee_urgent_maintenance_functions.sql`

Final release source SHA-256: `b8635550ce7afd568f197c8789cb023fb56eef5d96020254cbbb94c022c924b2`.
Exact atomic release batch SHA-256: `8d6e61c970989e78da07ead46a61b028f999469cda4cd9c6a6548a389ddb8058` (20 reviewed statements).
Forward recovery source SHA-256: `635730e7242f2684d7020f5508f93e3048e24de3bbd36f9b04248bbf375c242a`.
Exact recovery batch SHA-256: `dee4144df90083430262c97b3b7f8cfe4ae301a92abd6f717fcb58a9bf64e6bd` (11 reviewed statements).

| Existing function | Before definition MD5 | Repaired definition MD5 |
| --- | --- | --- |
| `private.enforce_maintenance_feature_write()` | `d106be2e7bedaa79fd5b82974776c206` | `2a893b7f73a06d69a84b0c0b080eeb44` |
| `report_attendance_accountability_event(uuid,text,date,text)` | `715493f11dd929cc34ab18b7fccfcea6` | `d48f2e61b1c97c996a75c6bb372f0980` |
| `service_mark_attendance_accountability_dispatch_result(uuid,boolean,text)` | `3498accbc8f4fab591a0e0ff757d622f` | `846ac90691ca7e1aee614eb99b3c8d05` |

New private helper MD5s are `a781d8f5f2f9038596307aaa4d21e08e` and `0d95939f9a8c36811d8f419193b19ba2`; both are owned by postgres, SECURITY DEFINER, empty search path, and postgres-only EXECUTE. The new table has postgres-only ACL and schema fingerprint `60c186937a0985594c121895745dbc6d`, covering columns, checks, indexes, RLS flags and cleanup trigger.

Forward recovery rejects drift from all five repaired/new function fingerprints and exact owners/ACL/configuration, the exact table schema and ACL, and any surviving capability. It restores the exact three original definitions, preserving their contracts, and retains the new sealed, empty capability objects. It never drops employee data, deletes history, or rewrites an applied ledger row. Because the original guard blocks urgent access again, recovery is a last-verified-state fallback for a genuine regression rather than a routine cleanup action.

## Tests and preservation evidence

The final frozen source passed nine restored-fixture groups in `supabase/tests/employee_urgent_maintenance_local_regression.sql`, under one outer BEGIN/final ROLLBACK and the cloned active production maintenance feature set:

1. Full employee AAL1 sick, call-off and date-only flows, real linked action/history/alert records, and idempotent replay.
2. Existing canonical no-call/no-show linkage through the self-service path, without creating/reclassifying that manager-owned event type.
3. Separate service simulated failure/acceptance/late-failure results; accepted timestamp retained and Worker retry observes already-notified.
4. Nonurgent marker, employee marker calls, manager-on-behalf, direct attendance/call-off writes, schedule edits and deletes remain denied by maintenance or existing append-only protection.
5. Forged GUCs, mismatched backend/transaction/auth/employee, wrong event/shift/operation/table/business fields all fail closed.
6. Exact created-action and report snapshots are preserved; service results cannot modify business fields.
7. Disabled/unlinked actors and manager-only employee event types cannot issue authority.
8. Forced downstream employee and service-marker failures unwind writes and leave no capability.
9. Deferred cleanup rejects an intentionally leaked capability; sealed ACLs and normal clock input-validation boundary remain intact.

The restored PostgreSQL 18 fixture substitutes its `codex_task` owner/grantor for hosted postgres. The final exact metadata/schema gates also passed there. Its missing hosted Realtime schema produces deferred-live-update warnings; no delivery verification is inferred from those warnings.

Six bounded hosted groups passed on PostgreSQL 17 under one inspected BEGIN/final ROLLBACK, including one minimal new absence and all four table/history/alert/supervisor-queue effects, actual authenticated/service role ACLs, unlinked denial, ordinary direct-write denial, nonurgent marker denial, idempotency and the separate simulated Dispatch result/retry contract. No production maintenance window was edited and no provider was called. The exact atomic release batch, including absent-ledger guard and exact ordered statement-array insert, passed those same groups again. Exact release plus guarded forward recovery also passed under one final ROLLBACK, restoring original fingerprints, retaining sealed empty objects, and recording two distinct forward ledger rows only inside the transaction.

Fresh read-only checks after those rollbacks confirmed zero candidate ledger rows, no capability relation, all three original definitions, zero rehearsal absences, 46 attendance events and 21 call-off reports. All 2,568 time-event rows, 90 employee rows, three maintenance-window rows and the selected assigned shift retained their complete-row hashes. The original 660 outbox rows retained hash `43d6b686f6e27a90a1f1fb78cda85cc0`, also matching the native restored baseline when both sessions use UTC. There was no committed test punch, payroll operation, identity edit, absence, notification or audit history.

Candidate/recovery negative tests separately injected function configuration and table-RLS drift; each was rejected and the connection's transaction rolled back. Relevant evidence is under `tmp/overnight-authorization`: `urgent-local-regression-result.txt`, `urgent-hosted-preflight-result.json`, `urgent-trigger-effects.json`, `urgent-exact-release-rollback-result.json`, `urgent-exact-release-recovery-rollback-result.json`, `urgent-post-rollback-result.json`, and `urgent-release-fingerprints.json`.

## Transport and rendered workflow proof

A conservative closure trace inspected 94 function overloads and 19 written tables across the four tables and all downstream triggers. The application closure has no dynamic SQL and no synchronous provider call. The only transport APIs are the existing `realtime.send` and `net.http_post`; cryptographic `extensions.digest` calls are not transports. The actual hosted `realtime.send` body was captured: it inserts into `realtime.messages`. Supabase documents that rolled-back broadcast insertions are not sent. `pg_net` documents that HTTP requests start only after COMMIT; the rehearsal also sets the existing push-wake coalescing flag so that wake request is skipped. Queued application notifications remain transaction-bound. See [Supabase Broadcast](https://supabase.com/docs/guides/realtime/broadcast), [pg_net API](https://supabase.github.io/pg_net/api/), and [PostgreSQL NOTIFY transaction semantics](https://www.postgresql.org/docs/17/sql-notify.html). No hook secret value or private recipient content was read or returned.

Independent UI evidence uses the real MyTimePage and RequestsPage with isolated data transports: `tests/e2e/urgent-maintenance-access.spec.ts` passed four desktop/Pixel7 tests with a visible full read-only MaintenanceNotice. The real forms/data parsers send one mocked attendance POST for sick/call-off; an employee has no manager Review coverage action. Three real AppShell component tests separately prove the Time outlet and report/review/confirm controls remain available. The relevant deployed product-source files are unchanged. Browser transports are mocked and prove the rendered contract; the hosted SQL groups independently prove the actual database contract. No email provider or production browser session was exercised.

## Activation gate

At this report's preparation, the candidate is verified and awaiting the parent's exact release review, intentional commit/source reconciliation gate, normal required preservation checks, and post-install validation. Only the parent may activate the reviewed COMMIT batch. Normal readiness and maintenance state remain authoritative; this repair does not clear the maintenance window or authorize the held notification Worker/browser release.
