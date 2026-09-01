# Scheduler Overtime Override Repair

Date: 09/01/2026
Status: Released to production

## Outcome

The new-coverage workflow now explains an overtime warning before a scheduler saves the shift and provides the approval-note field required to continue. Schedulers can see the employee's existing scheduled hours, the hours being added, the resulting weekly total, the overtime amount, and the exact active shifts included in the calculation.

## Corrected behavior

- Added a server-authorized overtime preview for proposed coverage assignments.
- Added a bounded, expandable list of the exact shifts counted toward the employee's weekly total.
- Excluded canceled shifts and canceled assignments from both new-coverage and assignment-update overtime calculations.
- Added a dedicated required approval-note field whenever the proposed assignment exceeds 40 scheduled hours.
- Preserved the existing audited overtime override record and now supplies its approval note from the coverage form.
- Made coverage creation and assignment atomic so a failed overtime approval cannot leave behind a partially created shift.
- Applied the same protection to employee-local-time coverage creation.
- Prevented saving while the preview is loading, unavailable, or awaiting a required approval note.

## Data safety

- No existing schedule, assignment, punch, payroll, employee, permission, or audit record was changed or migrated.
- Existing approval authority remains enforced by the database.
- The release added only preview and versioned coverage-creation functions and tightened canceled-assignment filtering.

## Verification

- Type checking passed.
- Lint passed with zero warnings.
- 137 test files and 671 tests passed.
- Worker and client production builds passed.
- Production migration `20260901233000_scheduler_new_coverage_overtime_override.sql` applied successfully and appears in the migration ledger.
- Production health, readiness, and login checks returned HTTP 200; readiness reported healthy.
- The deployed Schedule asset contains the new approval interface and all three new RPC contracts.
- An authenticated browser session was not available for a final manual scheduler submission, so the live release was verified through automated tests, successful database compilation, deployed-asset inspection, and production health checks.

## Release

- Cloudflare Worker version `d7c72a80-c078-4977-b9ac-a7720be6b0b4` is active in production.
