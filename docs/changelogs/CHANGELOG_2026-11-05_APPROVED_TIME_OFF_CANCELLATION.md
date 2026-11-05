# Approved Time Off Cancellation

Date: 11/05/2026
Status: Database activation verified; exact-commit application release pending

## Problem and cause

SygShift already supports an employee withdrawing their own pending request.
Once approved, however, the request had no authorized cancellation action and
continued to block overlapping schedule assignments. The existing scheduling
guard correctly checks only approved leave; the missing lifecycle transition,
not the overlap rule, caused the employee to remain unavailable.

## Narrow repair

- A different active reviewer with effective `requests.manage` and MFA can
  cancel future, unused approved hourly/flex leave with a recorded reason.
- Original submission, approval identity/time/note, affected-shift evidence,
  and decision snapshots remain unchanged. A separate append-only private
  cancellation receipt records the new action.
- Existing employee-schedule locking serializes cancellation with assignment.
  A canceled request no longer supplies an approved-leave conflict; a scheduler
  must deliberately assign the employee. No shift is assigned automatically.
- Requests already started, linked HR leave cases, or overlapping locked payroll
  exports are refused with explicit reconciliation guidance.
- Salary cancellation remains held for HR/Payroll reconciliation. The installed
  payroll base reads approved salary leave when deriving salary-default hours;
  this repair does not invent or reverse payroll treatment.
- Pending self-withdrawal remains unchanged. Employees cannot cancel their own
  approved leave through the new management action.
- The request center shows cancellation evidence separately from the original
  approval and refreshes request, schedule, availability and staffing queries
  without resetting historical date selections.

## Database and data preservation

Forward migration: `20261105185646_approved_time_off_cancellation.sql`.
It adds one forced-RLS private receipt relation, its indexes/append-only trigger,
one cancellation RPC and one versioned read wrapper. Existing canonical request
reads, approval/withdrawal functions, scheduling guards, payroll functions,
permissions and authentication functions are not replaced.

The new read wrapper invokes the canonical bounded/permission-scoped payload
once and enriches only already-visible requests. No direct browser or service
table access is granted to the private evidence relation.

A read-only production catalog check on 11/05/2026 confirmed the only payroll
consumer of `time_off_requests` is the salary-only branch in
`private.get_timekeeping_review_base(date,date)` (definition MD5
`0195e21d5ad48ef1fa7e3cae24d75fd2`). No UPT/sick/leave balance-ledger relation
was found; no balance or accrual is inferred by this repair.

## Verification

- Focused data/component tests: 32/32 passed.
- Isolated native PostgreSQL lifecycle/concurrency checks: 35 passed, using the
  actual unchanged assignment guard and time-off interval/withdrawal functions.
- Actual-component browser checks: 8/8 passed, including cancellation at
  390x844 and 320x480, original approval retention, request withdrawal, manager
  queues, deep links, error recovery and horizontal-overflow checks.
- Strict TypeScript and zero-warning application/Worker lint passed.
- The isolated cancellation-only clone passed `pnpm release:verify`: 404 files /
  2,519 tests plus one intentional skip, release governance, TypeScript,
  zero-warning lint, all 42 mandatory desktop/mobile Time Clock checks, and
  fresh production builds/static-asset validation. Production dependency audit
  reports no known vulnerabilities.
- The normal pre-push isolated exact-commit gate and hosted quality results
  remain required before production release.

The native SQL suite proves independent permission/MFA/disabled-account denies,
self-cancellation refusal, started/salary/HR/locked-export holds, a 25-hour DST
day, exact/concurrent retry deduplication, protected original approval, and no
changes to synthetic published shifts, punches, payroll or HR leave cases.
It has no production connection mode and creates no real requests or punches.

## Release separation and remaining limitations

The source checkout also contains unrelated unfinished own-time-label changes.
They are excluded. After the managed worktree tool failed without creating a
registered worktree, the authorized ordinary clone/setup workflow prepared
`C:/Users/Jordan/Projects/SygShift-time-off-release-20261105` from the verified
HTTPS origin on clean `main` at `5d9f3cb`. Only the 13 reviewed cancellation
paths were transferred; no unrelated label diff or source evidence was copied.
The normal hooks, complete gate and forward-migration procedure remain required.

No production time-off request has been canceled or altered during development.
No salary, accrued balance, used leave, HR leave treatment, payroll export,
permission, account, punch or published schedule has been changed. The existing
100-record bounded management history remains unchanged.

## Reviewed database activation

On 11/05/2026 at approximately 20:09 UTC, the exact migration was activated
atomically with its ordered 17-statement ledger entry after a successful
production rollback-only rehearsal and independent readback. The ledger moved
from 446 to 447; every prior row remained exact. No operational record was
written. All 1,405 prior full function/ACL contracts, 556 existing triggers and
six protected relation contracts remained unchanged. Both new RPCs have the
reviewed authenticated-only grants; the new evidence relation is empty,
forced-RLS and deny-by-default.

The separate reviewed baseline
`docs/reliability/migration-ownership-2026-11-05-time-off-v2.json` records the
447-version stage. All 442 entries and 574 owning sources in the prior November
2 baseline remain unchanged. The five additions are exactly the four separately
reviewed Sygilant migrations and this SygShift migration; every new applied
statement array matches its owning source. Existing reconciliation debt remains
unchanged; this baseline does not authorize bulk migration replay.

The isolated activation-wrapper suite passed 467 assertions, including explicit
refusal/rollback for ledger, permission and operational-write faults. Database
rollback means aborting the activation transaction before commit. After a
successful commit, application rollback uses the exact previous Worker version;
the additive database objects and append-only evidence are retained, not removed
or rewritten.

Application source was committed separately as `88d540a`. The final clean-main
hook, exact GitHub quality results, Cloudflare deployment, live health/readiness,
signed-in confirmation and matching Desktop changelog copy remain pending and
must be recorded before closeout. No real request is canceled merely to test.
