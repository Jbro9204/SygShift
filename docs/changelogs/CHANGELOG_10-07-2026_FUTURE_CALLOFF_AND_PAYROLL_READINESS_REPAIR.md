# Future Call-Off and Payroll Readiness Repair

Date: 10/07/2026
Status: Database repair live; application deployment pending

## Outcome

This release restores a reliable next-day call-off path without weakening early-clock controls and repairs several
Accountability and payroll-readiness defects found while reviewing the supplied SygShift issue package.

## Repairs

- Employees can select their nearest later assigned, published, standard shift when reporting sick or calling off,
  even when that shift begins more than twelve hours later.
- Authorized Accountability managers can select active published standard assignments beginning within the next
  fourteen days independently of the historical review-date filter.
- Draft, canceled, and concurrent Dispatch phone-duty assignments are excluded from both employee and manager
  call-off choices.
- Call-off shift dates are rendered in the shift's own time zone instead of deriving the date from UTC.
- Reviewed `unexcused` occurrences now display and filter as unexcused, count in reviewed reliability totals, and
  use the existing protected employee-notification and email-delivery path.
- Payroll summary exports no longer create anonymous no-activity employee/week rows.
- Payroll locking now stops in the interface when server reconciliation fails, with specific explanations for
  duplicate occurrences, unresolved payroll-week assignments, category totals, overtime totals, and paid minutes
  that still need a Regular, EP, or TRUEP classification.
- The payroll workbook now states its exact-minute rounding basis and clearly distinguishes SygShift review status
  from iSolved submission, approval, or payment status.
- The legacy Time tools implementation now uses the same canonical payroll lock guard, preventing future behavior
  drift if that code path is restored.

## Database and authorization

- Applied forward-only migration `20261007182434_restore_future_calloff_shift_visibility.sql` to production and
  recorded it as `restore_future_calloff_shift_visibility` in the migration ledger.
- The employee dashboard change restores informational shift visibility only. `record_time_event` remains the
  server authority for punch eligibility, so this release does not permit early clock-ins.
- The Accountability workspace retains its active-employee, effective-permission, and MFA checks. Anonymous access
  remains revoked.
- The source rewrite is retry-safe, requires one exact known anchor on first application, rejects partial prior
  repairs, and preserves the existing function owner and grants.
- Normal `supabase db push --dry-run` remains blocked by pre-existing local/remote migration-history drift. No broad
  history rewrite was performed. The reviewed migration was applied through the established targeted linked-query
  path, and only this new version was recorded as applied.

## Verification completed

- `pnpm check`: **363 passing test files / 1 skipped** and **2,030 passing tests / 1 skipped**, plus strict
  TypeScript, zero-warning lint, production build, and static-asset validation.
- Actual-component Time Clock Playwright matrix: **42/42** desktop and mobile tests passed.
- Focused Accountability, My Time, payroll, and migration guards passed after the final review changes.
- Rollback-only production SQL regressions passed for:
  - future standard-shift selection, draft/canceled/concurrent-duty exclusion, review-range independence, and MFA;
  - unexcused employee notification and queued email delivery;
  - canonical call-off idempotency across schedule revisions;
  - call-off alert and coverage lifecycle cleanup.
- Production postflight confirmed the dashboard repair, manager canceled-assignment filter, unexcused delivery
  function, and migration ledger entry.
- Schedule persistence investigation passed **88/88** focused schedule tests, including save/removal, week copy,
  capacity, Dispatch overlap, time-zone basis, and duplicate normalization. Active drafts contained no unintended
  duplicate groups, and no current persistence defect was reproduced.

## Deliberate boundaries and required decisions

- **Attendance points are not activated.** The supplied policy is marked submitted for review, not approved, and
  leaves material HR rules unresolved: effective date and population, ninety-day boundary, early departure and
  no-call/no-show timing, UPT accrual/rounding/rollover, threshold notices, appeals, and retention. Existing factual
  occurrence tracking remains active without automatic discipline or termination.
- **B'Nai responsibility scope was not guessed or hard-coded.** Production has no B'Nai-to-Randall supervisor
  assignment to remove; Randall's visibility comes from broad global schedule permissions and one historical
  assignment. SygShift currently has employee-supervisor scope but no authoritative site-responsibility mapping.
  A business decision is required before changing global scheduler access or adding explicit responsible-site scope.
- **EP/TRUEP classification already exists, but activation remains controlled.** Production currently has no Sites
  enabled for EP/TRUEP and no classified historical shifts or time events. The supplied PDF predates the October 6
  category release. Site activation, historical corrections, rates, and overtime allocation require Finance/Payroll
  decisions; this release does not invent them.
- **Schedule persistence has no confirmed current failure.** Automated, source, installed-function, and production
  data checks passed. A literal authenticated save, refresh, sign-out, and sign-in ceremony was not performed
  because no dedicated safe test schedule/account was designated.
- Elevon/Castle Rock holds and the proposed TMC patrol-hit change are operational/contract matters and were not
  changed by this software release.

## Deployment record

- Database migration and rollback regressions: complete.
- Source promotion, Cloudflare Worker deployment, live asset, and health/readiness verification: pending.
