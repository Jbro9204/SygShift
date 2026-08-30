# HRIS Stage 2 Controlled Backfill Architecture

Date: 08/29/2026

## Purpose

Stage 2 Run 3 adds a dormant, server-controlled path for connecting each permanent SygShift employee UUID to the private HR person and worker identifiers established in Run 1. It does not create a second directory, duplicate names or contact details, change authentication identity, or activate an HR workspace.

## Control sequence

1. An authorized HR administrator with recent MFA records verified hire and, when applicable, separation dates from an authoritative source.
2. A service operator records current evidence from an isolated restore test. Recovery evidence is append-only and expires.
3. An authorized HR administrator explicitly opens the protected gate with a reason. The gate refuses to open while any required date or recovery evidence is missing.
4. The administrator creates a single-use authorization for either one to three canary employees or the full proposal. The authorization expires after 15 minutes and captures the protected operational snapshot.
5. Only the server service role can execute the authorization. Execution refuses expired, reused, stale, blocked, oversized, or incomplete targets.
6. The transaction creates only missing private HR person and worker identifiers, verifies every mapping, rechecks protected operational counts, records the execution, and rolls back on any mismatch.
7. The gate is closed after the controlled operation. HR features, role mapping, and browser access remain separate release decisions.

## Preserved domains

The authorization and execution snapshots cover employees, employee accounts, credentials, access memberships, role permissions, individual overrides, schedules, shifts, assignments, time events, time-off requests, and payroll export batches and rows. The executor is allowed to add only the planned private HR person and worker identifiers.

## Deliberate stop condition

The control plane is installed closed. Production execution is not authorized until authoritative effective dates and isolated recovery evidence exist. Missing evidence is a release blocker, not a value to infer.

## Recovery

No destructive rollback is used. A failed execution rolls back its database transaction. A later defect is corrected with a forward-only migration. Do not delete an applied migration, repair historical migration entries blindly, or rewrite an existing protected HR identifier.
