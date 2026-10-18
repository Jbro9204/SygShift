# Payroll Hours Reconciliation Repair

Date: October 18, 2026
Status: Database repair verified in production; application deployment fields remain pending below

## Outcome

SygShift now presents operational workday totals and payroll-period allocations as two explicit, reconcilable views instead of mixing them in one employee detail calculation. Complete overnight occurrences remain attached to the workday on which they started, while payroll continues to allocate elapsed minutes at the configured Sunday 12:00 AM `America/Denver` boundary.

The repair also separates current clock status from a selected historical date range. Team Attendance and the Time Command Center use the live roster for **Clocked In** and **On Break**, while first and last punch fields are clearly labeled as evidence for the selected operational workdays.

## Verified root causes

1. Time Maintenance used payroll-range `paidMinutes` for employee detail and hours breakdown, then compared that clipped value with whole-shift scheduled minutes. A final-day overnight occurrence could therefore lose its after-midnight allocation from the operational display even though the canonical timecard was complete.
2. Team Attendance filtered individual punches by their calendar date before rolling them into an occurrence. A clock-in on the final selected workday could remain while its paired next-day clock-out was excluded, producing a stale last punch and a false historical **Clocked In** state.
3. Team and command-center status cards treated the latest event inside a selected date range as current status. Historical range state and live clock state were not the same question.
4. Team totals and payroll review used separate minute-rounding paths. A multi-segment occurrence could disagree by one minute even when both paths used the same effective punches.

A read-only production audit covered 37 Team Attendance employees and 31 hourly payroll-review employees for October 4-17. It found seven operational/payroll presentation differences, seven rows whose selected-range status could be mistaken for live status, and one separate genuinely incomplete punch pair. The repair does not assume every employee or difference has the same cause.

## Confirmed Alejandro example

Employee identity was not changed. The record remains `@ralejandro`; Michael's separate name correction is outside this release.

For Neon Local Apt-Unarmed / NLA and operational dates October 4-17, 2026:

| View | Before | Repaired behavior |
| --- | --- | --- |
| Complete operational work | Team overview showed 24.08 hours, but employee detail showed 20.08 | Overview, employee detail, and hours breakdown all show 1,445 minutes / **24.08 hours** |
| Scheduled work | 24.00 hours | **24.00 hours**, unchanged |
| Operational variance | -3.92 hours | **+0.08 hours** |
| Current-period payroll allocation | Shown as if it were the full worked total | Explicitly labeled **20.08 hours / 1,205 minutes** for October 4-17 |
| Adjacent payroll allocation | Not explained in employee detail | **4.00 hours / 240 minutes** remains in the next payroll range |
| Reconciliation | Ambiguous | `1,205 + 240 = 1,445` minutes, with no loss or duplication |
| Clock status and last punch | Appeared Clocked In with last clock-out October 17 at 4:00 AM MDT | Live status comes from the live roster; the selected-workday record includes the completed October 18 at 4:00 AM MDT clock-out |

The approved October 15 clock-in adjustment remains effective for calculation. The original 11:36 PM punch, adjusted 8:00 PM punch, reason **first day onboarding**, actor, timestamp, and audit chain remain intact.

## Application repair

- Added an operational occurrence summary that uses canonical `occurrence*` minutes, scopes rows by `operationalDate`, deduplicates repeated allocation representations, and counts only closed worked segments.
- Employee detail, worked totals, hours breakdown, category totals, completed segments, and scheduled-versus-worked variance now use complete operational occurrences owned by the selected workdays.
- Payroll preview, lock, CSV/XLSX generation, and downstream export remain allocation-slice based. When the payroll allocation differs from operational time, Time Maintenance explains the Sunday-midnight boundary rather than hiding it.
- Rebuilt Team Attendance summary and totals around the effective occurrence assignment anchor so paired next-day events stay with the starting workday.
- Aligned Team Attendance minute totals with the same canonical occurrence-level rounding used by payroll review.
- Added bounded prior-week context and canonical Sunday-boundary classification to Team Attendance overtime, so a
  partial date range cannot reset the 40-hour threshold and a Saturday overnight occurrence cannot be assigned
  wholesale to the week in which it began.
- Added `incompletePunchCount` to the Team Attendance totals contract. It counts incomplete canonical occurrences,
  not events, leaves complete next-day overnight closes at zero, and never substitutes scheduled minutes for an
  unclosed punch pair.
- Merged current status and location from the protected live roster into Team Attendance and the Time Command Center. Historical first/last punches remain selected-range evidence and are labeled accordingly.
- Added live-roster query invalidation after punch mutations so current status refreshes with the rest of Timekeeping.

## Payroll policy and data preserved

- The active payroll-week rule remains Sunday 12:00 AM through Saturday 11:59:59 PM in `America/Denver`.
- The existing `payroll-batch-v2` elapsed-time allocation policy is unchanged.
- Operational schedules and timecards continue to own a complete overnight occurrence on the day it starts.
- No hard-coded employee exception, four-hour adjustment, scheduled-hours substitution, pay-rate change, or payroll submission was added.
- No identity, schedule, shift, punch, correction, break, assignment, payroll, locked batch, audit, or rate record is rewritten or deleted.
- Incomplete punch pairs remain exceptions. They are not silently closed and scheduled hours are not treated as worked time.
- Existing locked payroll remains immutable, and adjacent payroll periods cannot lose or double-count an allocation.

## Database and security

- Applied foundation migration: `20261018225038_repair_team_attendance_overnight_summary.sql`
- Migration SHA-256: `44ae84e161e742efb45753d6201969176d87687f60e8a2eaab5f81627017d09a`
- Rollback-only regression: `team_attendance_overnight_summary_regression.sql`
- Regression SHA-256: `7428e6bcc58d56c30bab651c4caec06f04314ab66372be93c0bb98781f4aad77`
- Applied additive migration: `20261018231406_team_attendance_overtime_canonical_parity.sql`
- Additive migration SHA-256: `dbe96a6187484be9aed59a380bed098b91acb1664d167c4dd04ac905b1813937`
- Additive rollback-only regression: `team_attendance_overtime_canonical_parity_regression.sql`
- Additive regression SHA-256: `b94f1ea1126cb77af29a7130d7653d6be5ebae5e66a00249f8b95e3906b239fd`
- Additive release helper: `prepare-team-attendance-overtime-release.mjs`
- Additive release helper SHA-256: `83c731cfa3e9ecefa5736bc31cede13dd7a7f4825d54302d4699068b57c6ab77`
- Combined rollback-only rehearsal SHA-256: `9cf9f5b4319ca5c13386fc43e0283993cb45307a9c4129770b139e801f9a2828`
- Applied additive release transaction SHA-256: `d0a9f5ffec028423492964c9e017a80175c21c1d2689103033aed9b78492dc54`
- Prepared rollback-only rehearsal SHA-256: `8c5d3ce21c1a16b78d6cdc476a8bf2d0b02492502b83d3aabb1d7ba8a140cbc4`
- Prepared exact release transaction SHA-256: `02e272b09c58510ac28b206ba0dc3ec2ea13e42d82fea05026c2cfd479ebe180`
- `get_team_attendance_summary` and `get_team_attendance_totals` remain `SECURITY DEFINER` functions with an empty search path, active-account checks, effective Time permission, MFA, bounded date ranges, anonymous denial, and authenticated-only execution.
- Hosted rollback-only rehearsal: **PASSED** for the additive migration plus both SQL regression suites in one
  `BEGIN`/`ROLLBACK`; the migration-history row, function replacement, and fixture rows were absent afterward.
- Production migration state: migrations `20261018225038` and `20261018231406` are installed. Both installed
  rollback-only SQL suites passed afterward, Alejandro's live reconciliation remained exact, and Supabase security
  and performance advisors reported no error-level findings.

## Verification

- Focused application regression: **7 files / 46 tests passed**.
- Alejandro's three occurrences reconcile to 1,445 operational minutes, with 1,205 minutes in the October 4-17 payroll range and 240 minutes in the adjacent range.
- Coverage includes inbound and outbound period boundaries, complete final-day overnight shifts, DST fall-back elapsed time, approved adjusted punches, boundary-spanning breaks, multi-segment rounding, duplicate-allocation defense, incomplete punch pairs, export allocation preservation, and adjacent-range no-loss/no-duplication behavior.
- Database parity coverage also includes a one-day partial range whose prior 40 hours make the selected Saturday
  occurrence entirely overtime, a 38-hour week whose Saturday overnight splits 120 + 240 minutes across Sunday
  without creating overtime, canonical payroll-review parity, and a fail-closed incomplete occurrence count.
- Strict TypeScript passed.
- Focused zero-warning application lint passed.
- Diff whitespace validation passed.
- Full `pnpm check`: **374 files passed / 1 skipped; 2,154 tests passed / 1 skipped**, plus strict TypeScript,
  zero-warning lint, production build, and static-asset contract.
- Mandatory desktop/mobile Time Clock workflow plus Time Maintenance layout: **44/44 passed**.
- Final production build, health/readiness, authenticated workflow, and exact-asset verification: **PENDING RELEASE RECORD UPDATE**

## Deployment and rollback record

- Pre-release rollback tag: `rollback/pre-payroll-hours-reconciliation-20261018`
- Rollback tag commit: `dac0819`
- Implementation commit: `PENDING_COMMIT`
- Cloudflare Worker version: `PENDING_WORKER_VERSION`
- Cloudflare deployment ID: `PENDING_DEPLOYMENT_ID`
- Production entry assets and SHA-256 parity: `PENDING_LIVE_ASSET_VERIFICATION`

If rollback is required, restore the tagged application source. The forward database repair changes only derived Team Attendance readers and preserves canonical source records, so rollback must not delete or rewrite employee, schedule, punch, correction, or payroll history.
