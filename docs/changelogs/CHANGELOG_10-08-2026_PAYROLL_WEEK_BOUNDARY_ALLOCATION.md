# Payroll Week-Boundary Allocation Without Timekeeping Rewrite

Date: 10/08/2026  
Status: Released to production

## Outcome

SygShift now separates **when a shift belongs on the schedule** from **which payroll week owns each paid minute**.
The schedule and timekeeping system continue to retain one shift, one operational work date, one punch/event chain,
and one worked occurrence. A versioned payroll-only allocation layer divides that occurrence only when it crosses
the configured payroll workweek boundary.

This resolves employee-facing and payroll totals for overnight Saturday shifts without changing scheduling,
attendance, clocking, internal operations, or historical locked payroll records.

## Exact behavior

The active payroll workweek remains Sunday 12:00 AM through Saturday 11:59:59 PM in `America/Denver`.

For a Saturday 10:00 PM–Sunday 6:00 AM occurrence:

- the schedule still shows one Saturday shift from 10:00 PM to 6:00 AM;
- the employee still has one canonical timecard and one occurrence;
- the punch/event chain is not duplicated or rewritten;
- payroll allocates 2 elapsed hours to the ending week and 6 elapsed hours to the new week; and
- a 30-minute break that straddles midnight is attributed by its actual elapsed interval, producing 105 paid
  minutes in the ending week and 345 paid minutes in the new week.

Weekly overtime is then calculated inside each actual payroll week. Daily overtime and operational-day behavior
continue to use the canonical occurrence and existing rules.

## Canonical timekeeping preserved

This update does not split, duplicate, move, or rewrite:

- schedule assignments or their displayed start day;
- punch/time-event rows;
- the authoritative worked occurrence;
- call-off, attendance, salaried-shift, or accountability records;
- operational **Today** behavior;
- Site/Post, employee, classification, or assignment history; or
- an existing locked payroll batch or row.

The payroll allocation is derived from the existing authoritative occurrence. Its allocation keys identify bounded
week slices while retaining the same canonical occurrence key for audit and reconciliation.

## Versioned payroll policy

- Added policy `elapsed_time_boundary_split` under calculation contract `payroll-batch-v2`.
- Advanced the payroll configuration to version 2 with an effective date of 10/08/2026.
- New open payroll periods use v2 allocation evidence.
- Existing locked `payroll-batch-v1` history remains immutable and continues to own each complete legacy occurrence.
- A legacy locked occurrence cannot be reallocated into a v2 batch.
- Distinct week allocations from one v2 occurrence can be locked in adjacent payroll batches, but the same allocation
  cannot be locked twice.
- Matching lock retries remain idempotent; conflicting or incomplete allocation evidence fails closed.

## Payroll totals, review, and export

- My Time payroll/week/pay-period totals use the allocation that overlaps the selected payroll range while retaining
  one visible full canonical timecard.
- Weekly overtime is computed from actual Sunday-boundary allocations, including the required prior-week context
  for a partial selected range.
- Payroll review and employee detail show the complete occurrence with a clear allocation explanation.
- Scheduled-versus-actual comparisons clip scheduled intervals to the exact requested range and split them at the
  same payroll boundary.
- Detailed CSV output preserves its original first 24 columns for downstream compatibility, then appends the
  canonical occurrence key, allocation key, and complete occurrence gross, break, gap, and paid totals.
- XLSX weekly detail, employee summaries, Site summaries, and payroll-category totals consume the same allocation
  evidence as the review screen.
- Official locked workbooks derive their policy, payroll week, and timezone from their stored rows rather than the
  latest live rule.
- Zero-paid allocation slices remain visible to review and reconciliation but are excluded from payable exports,
  worked-detail rows, and paid-occurrence counts.
- Existing salary-default behavior is unchanged.

## Breaks, daylight saving time, and rounding

- Break minutes are assigned to the week in which each part of the break actually elapsed rather than being charged
  wholly to the shift's start day.
- Allocation operates on elapsed instants and is covered across both spring-forward and fall-back daylight-saving
  transitions.
- JavaScript and PostgreSQL use matching largest-remainder rounding so displayed, exported, reconciled, and locked
  minute totals remain identical.
- The allocation slices always reconcile to the canonical occurrence totals; a mismatch blocks official lock.

## Locking and reconciliation safeguards

- Payroll lock rejects a row when allocation paid minutes do not reconcile to the canonical occurrence.
- Open occurrences from the prior operational day are included in blocker detection when they could affect the
  selected payroll range.
- Mixed, unresolved, or unclassified EP/TRUEP/Regular category evidence remains a blocking reconciliation failure.
- Corrected payroll-week assignments remain audited whole-occurrence exceptions; the correction is not silently
  inferred from a punch or schedule display.
- The same transaction-safe occurrence/category protections remain in force when allocation rows are reviewed or
  locked.

## Historical immutability and baseline evidence

Before the change, the linked production baseline contained:

- 60,798 shifts;
- 2,201 time events;
- 3 locked payroll batches;
- 13 locked payroll rows;
- 7 payroll week-assignment history rows; and
- 0 v2 allocation rows.

The rollback-only production rehearsal ended with those counts unchanged. It also reproduced the exact original
hashes for shifts, time events, locked batch payloads, locked row payloads, and payroll week-assignment history.
No existing locked row was backfilled or rewritten.

## Validation

- [x] The migration and new payroll allocation regression ran against the linked production schema inside one outer
  transaction and rolled back completely.
- [x] The Saturday 10:00 PM–Sunday 6:00 AM fixture produced exact 120/360 gross, 15/15 break, and 105/345 paid-minute
  allocations while retaining one shift, four punch events, and one canonical occurrence.
- [x] SQL coverage passed for actual-week overtime, partial-week context, corrected assignment history, adjacent
  locks, idempotent retries, duplicate allocation rejection, legacy-v1 ownership, missing-clock-out blockers, MFA,
  grants, and unchanged historical hashes.
- [x] The existing EP/TRUEP payroll-classification regression passed under the v2 policy.
- [x] Component and unit coverage includes DST boundaries, cross-week breaks, exact-range clipping, selected-week
  totals, zero-paid slices, legacy fallback, stored-policy workbook behavior, CSV compatibility, and lock blockers.
- [x] Final application gate: 369 test files passed / 1 skipped and 2,086 tests passed / 1 skipped, with strict
  TypeScript, zero-warning lint, production build, and the static-asset contract passing.
- [x] Mandatory actual-component browser gate: 46/46 across desktop and mobile Chromium, including the 42/42 Time
  Clock workflow plus the focused payroll and interface checks.
- [x] Production application, migration, health/readiness, and exact-asset verification passed on both
  `app.sygilant.us` and the Worker fallback. Both installed SQL regressions passed, migration history contains the
  local/remote `20261008125500` pair, and the post-activation baseline retained every canonical and locked-history
  count and hash.

The linked database lint baseline contains eight pre-existing unrelated function errors. The final comparison must
show the same baseline with no new payroll-allocation error.

## Deployment and rollback record

- Production migration: `20261008125500_payroll_week_elapsed_time_allocation`
- Implementation commit: `10e4313`
- Cloudflare Worker version: `1e0a20bd-c677-4b43-b995-6e1026f292d0`
- Pre-release rollback tag: `rollback/pre-payroll-week-boundary-allocation-20261008`
- Production health/readiness and exact live-asset result: both production origins returned healthy/ready and the
  live index served `assets/index-DoiV7Mtq.js` with `assets/index-2FDQBd7j.css`, matching the verified build.

The application is deployed before the database policy is activated because the updated application can read both
v1 and v2 payloads, while the prior application does not understand the new v2 policy enum. If rollback is required,
the source tag restores the pre-release application, and the migration's forward-only historical protections ensure
that no existing shift, punch, occurrence, locked batch, or assignment-history row was rewritten by activation.

## Deliberate boundary

Historical locked workbooks still retrieve live accountability, sick, and PTO event details because those event
records were not snapshotted by the pre-existing batch design. This release does not claim to make those unrelated
historical event sections immutable; doing so requires a separate schema and lock-workflow change. The new payroll
week allocations and their stored policy evidence are immutable within the official locked rows.
