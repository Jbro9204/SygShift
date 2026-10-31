# Time-correction effective-permission repair

Date: 10/31/2026. Scope: SygShift database authorization only.

## Cause and correction

The September replacement of `supervisor_correct_time_event_details` restored a primary-role check that August's permission-integrity migration had already replaced. Assigned access profiles could permit the Time Maintenance interface while the correction RPC rejected the same authorized actor. Repeated sign-ins could not overcome the primary-role rejection.

Forward migration `20261031224853_time_correction_effective_permission_repair.sql` restores effective `time.manage` or `time.manual_entry.edit` authorization with mandatory MFA. Both predicates fail closed on NULL. Direct permission denies retain their existing per-permission behavior. No employee-specific exception, role change, additional grant, global role-helper change or MFA bypass is included.

Exact before/after definition fingerprints fence replacement of only the authorization condition and its denial message. The active-account check, correction validation, row lock, pending-request decisions, original punch preservation and append-only maintenance/correction audit remain unchanged. Function OID, owner, ACL, search path, defaults, volatility and security-definer metadata are preserved.

## Verification and deployment

- An isolated native PostgreSQL 18 fixture reproduced the exact production before fingerprint and the original assigned-role failure. The repaired function passes the authorized/denied correction and void matrix, original-history and audit assertions, metadata preservation and migration idempotency checks. Synthetic records are rolled back; no production connection is used by the fixture.
- The exact production rollback-only rehearsal passed, then a separate read confirmed the original function and all 440 migration entries were restored. The reviewed atomic activation subsequently installed only this repair and its exact three-statement ledger record. The old 440 entries remained unchanged; the live ledger is now 441.
- A read-only installed-function probe with synthetic claims for an existing authorized account reached the expected NULL-event validation after MFA; the low-assurance context was denied. It supplied no real punch identifier and made no timecard change. This is not a signed-in browser acceptance test.
- Health and readiness remain 200/ready with zero scheduled-runtime consecutive failures. No browser/Worker deployment is required: the existing correction RPC uses the installed function immediately, and the deployed DST application remains unchanged.
- Focused source/UI regression checks pass. The reconciled source candidate must also pass the full application/release gate, mandatory 42 desktop/mobile clock tests, fresh build and exact-SHA GitHub quality checks. Final execution status is recorded separately from this source-candidate snapshot.
- The reviewed shared-database ownership baseline advances only for this migration. Existing historical reconciliation exceptions and retry-safety function fingerprints are not relabeled or rewritten.

## Preservation and fallback

No production employee, account, session, permission assignment, punch, correction, schedule, rate, payroll export or existing audit row was changed by the repair or its probes. A real authorized correction remains the user's operational action, not a test submission.

If containment is required, use a new fingerprint-gated forward migration against the exact installed after definition. Preserve all subsequently accepted corrections and audit history. Do not delete the new ledger entry, edit applied SQL, restore old employee data, globally broaden roles or bypass MFA. Restoring the old guard also restores the access failure and is not a preferred operational fix.
