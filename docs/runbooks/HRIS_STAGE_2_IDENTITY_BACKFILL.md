# HRIS Stage 2 Identity Backfill Runbook

## Purpose

This runbook governs the one-time creation of protected HR person and worker identifiers for existing SygShift employees. It does not create employee accounts, change roles or permissions, alter schedules, rewrite timekeeping or payroll, modify licensing records, or remove historical employees.

## Release prerequisites

All prerequisites are mandatory:

1. Every target employee has an authoritative hire date recorded through the Employment Data Readiness workspace.
2. Every separated target employee has an authoritative separation date.
3. The reconciliation proposal has zero blockers.
4. A successful isolated restore drill has current, unexpired evidence in the protected recovery-evidence table.
5. The administrator authorizing the operation has `hr.people.manage`, a verified MFA session, and a written audit reason.
6. The service executor has captured a fresh operational preservation snapshot.

Dates must never be inferred from account creation, schedule history, time punches, licensing dates, or file timestamps.

## Controlled canary

1. Select one to three unmapped employees whose authoritative dates are complete.
2. Open the protected gate with a written reason.
3. Create a single-use canary authorization. It expires after 15 minutes.
4. Execute the authorization through the service-only executor.
5. Confirm that the gate closed automatically.
6. Produce an independent verification artifact and SHA-256 digest.
7. Run the service-only canary verifier. It must prove:
   - every expected person and worker identifier is exact;
   - the execution preserved all protected operational counts;
   - the reconciliation proposal has no blocker for any canary employee;
   - the same current recovery evidence supports the canary and the later full authorization.

Failure at any step stops the release. Do not reopen the gate until the failure is understood and the recovery decision is documented.

## Full rollout

1. Review the append-only canary verification and confirm it matches the current recovery evidence.
2. Reopen the gate with a new reason and verified MFA session.
3. Create a new full authorization. The database rejects it if the canary is absent, unverified, or tied to different recovery evidence.
4. Execute through the service-only executor within 15 minutes.
5. Confirm that the gate closed automatically.
6. Run `tools/sql/verify-hris-stage2-backfill-release.sql` and retain the output with the release evidence.
7. Compare employee, access, schedule, timekeeping, licensing, payroll, and historical-record counts with the approved pre-release evidence.

## Rollback and recovery

The executor is transactional: a mapping or preservation failure rolls back the entire attempted execution. If a completed canary later fails independent review, keep the gate closed and restore the protected identity tables only through the approved isolated recovery procedure. Never delete or rewrite operational employee, schedule, time, payroll, licensing, or access records to reverse an HR identity mapping.

## Current production state

The production identity backfill has not run. The release remains blocked until authoritative effective dates and current isolated-restore evidence are supplied. This is an intentional safety state, not an application outage.
