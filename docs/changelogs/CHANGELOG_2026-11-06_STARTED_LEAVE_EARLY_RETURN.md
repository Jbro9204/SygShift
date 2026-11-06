# End approved leave now

Date: 11/06/2026
Status: Verified source candidate; production activation and application release recorded separately below.

## Cause and repair

The future-cancellation workflow rejected every approved request once its first
instant passed. This prevented returning to work during a multi-day unpaid
absence even when there was no HR case or locked payroll. Removing the whole
request would incorrectly erase the already-used leave interval.

The Time Off workspace now separates two explicit actions:

- **Cancel approved time off** for eligible future requests.
- **End leave now** for eligible in-progress unpaid hourly/flex requests.

The second action records an append-only early-return receipt using the server
clock after the employee scheduling lock is obtained. It retains the original
request, dates, status, submission and approval exactly. The used prefix remains
approved leave; only the remaining half-open interval becomes available for
scheduling. A scheduler must still assign the employee deliberately.

The server determines action eligibility. Independent review permission and MFA
remain required. Self-review, salary or unknown classifications, paid or
policy-managed leave, missing authoritative timezone, linked HR cases and
locked payroll exports remain protected. Repeated identical requests return
the existing receipt without moving the return time or duplicating the audit.

## Connected behavior and preservation

The canonical effective interval is used by assignment validation, week-copy
eligibility, overlapping new leave requests, salary shift-presence eligibility
and attendance-event projection. Unaffected attendance records retain their
previous date-only rendering. Request, schedule, availability and attendance
caches refresh after success without resetting selected date ranges.

No login, MFA policy, employee identity, permission, punch, payroll calculation,
pay rate, leave balance or published schedule is changed. The salary financial
reader and existing future-cancellation RPC remain unchanged. Original request
history in the separate Sygilant Admin preview is intentionally not rewritten.

## Verification and release controls

- Focused data/component tests, actual-component phone layouts, failure/retry
  behavior, independent database review and native PostgreSQL lifecycle tests
  are required before release; exact counts are recorded in the final receipt.
- A production rollback-only rehearsal must preserve the existing 450-entry
  whole-row ledger, function security metadata, all non-rewritten functions,
  relations, existing triggers, Auth metadata and permission catalogs.
- The new 451-entry ownership baseline represents only the exact rehearsed
  candidate. The deployment gate must independently match the actual ledger
  after the one reviewed migration is activated.
- The full SygShift release check includes existing clock-in, clock-out, break,
  protected-access and desktop/mobile regressions, plus exact-commit hosted CI.
- The employee's real early return is a separate authorized operational action,
  not a test fixture or a consequence of installing the migration.

Completed candidate verification: 75 new native PostgreSQL checks, 35 existing
cancellation checks, 43 focused data/component tests, 11 actual-component
browser scenarios and six repeat runs passed. Phone layouts at 390x844 and
320x480 were visually checked, including the dark theme. The full local
application suite passed 2,530 tests (one intentional skip), and all 42 mandatory
desktop/mobile clock checks passed. The exact production rollback rehearsal
and subsequent read-only rollback verification preserved the existing
450-entry ledger, Auth metadata, permissions and all non-targeted catalog
objects. Hosted CI and the final production build remain separate release gates.

## Rollback and limitations

Before any early-return receipt exists, the additive database layer can safely
remain while the application bundle is rolled back. After a receipt exists,
retain the effective-interval readers and receipt history; reverting to raw
original-date readers would incorrectly block the released remainder again.
Use a reviewed forward fix rather than deleting evidence.

The native suite executes the real assignment, submission and attendance
consumers. Full week-copy execution is source-contract checked rather than
simulated end to end. Real unpaid leave release is not payroll reconciliation:
paid, salary, HR-linked and locked-payroll changes still require their separate
authorized workflow.
