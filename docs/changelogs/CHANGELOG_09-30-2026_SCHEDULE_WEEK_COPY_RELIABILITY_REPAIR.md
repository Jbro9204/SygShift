# Schedule Week Copy Reliability Repair

Date: 09/30/2026
Status: Released to production

## Outcome

**Copy week** now completes a normal-sized operational schedule within the
authenticated request budget instead of timing out and rolling the entire copy
back. The existing copy contract remains atomic: a failed copy changes neither
the source week nor the destination draft.

When an employee carried from the source week has approved Time Off in the
destination interval, SygShift now safely copies the shift but leaves that one
placement open for Operations to cover. The completion message states how many
assignments were intentionally left open because of approved Time Off.

## Root cause

The authoritative week-copy function validated IANA time zones by scanning
`pg_catalog.pg_timezone_names` twice for every copied shift. The catalog scan
was approximately 0.9 seconds in production. Repeating it across a normal
week exceeded the authenticated API statement-timeout budget, so PostgreSQL
correctly canceled the all-or-nothing transaction.

After that bottleneck was removed, rollback-only production rehearsal exposed a
second real boundary: the existing assignment trigger correctly rejects an
employee whose approved Time Off overlaps a copied destination shift. The old
copy workflow treated that one valid protection as a reason to cancel the
entire week.

## Repair

- The copy function now loads the valid IANA zone names once into an in-memory
  array for each copy and reuses that authoritative set for every source and
  destination shift.
- It retains exact source-revision validation, wall-clock and DST behavior,
  Site/Employee time-basis behavior, Dispatch phone-duty classification,
  assignment-overlap validation, credential handling, audit evidence, and
  atomic replacement of the destination working draft.
- Before carrying an assignment, the function locks the employee's schedule
  and Time Off boundary and checks the same approved-leave interval rule used
  by the normal assignment trigger.
- A conflicting approved-leave placement is skipped, counted, and audited;
  the copied shift remains open. The trigger itself was not weakened, so a
  direct conflicting assignment remains denied.
- The browser result contract accepts the new skip count without breaking
  rolling deployments. Copy errors remain inside the Copy Week dialog, use
  plain recovery language, and clear when the dialog is closed, reopened, or
  changed.

## Files and database changes

- Browser contract and Scheduler feedback:
  - `src/data/schedule.ts`
  - `src/pages/SchedulePage.tsx`
  - `src/schedule/copyWeekFeedback.ts`
- Regression coverage:
  - `src/schedule/copyWeekFeedback.test.ts`
  - `src/scheduleWeekCopyCapacityGuard.test.ts`
  - `src/schedulerBehaviorGuard.test.ts`
  - `supabase/tests/schedule_week_copy_capacity_regression.sql`
- Forward-only source migrations:
  - `20260930195833_schedule_week_copy_timezone_lookup_cache.sql`
  - `20260930201111_schedule_week_copy_approved_time_off_skip.sql`
- Production migration ledger entries:
  - `20260930200544` — `schedule_week_copy_timezone_lookup_cache`
  - `20260930201526` — `schedule_week_copy_approved_time_off_skip`

The different source-file and hosted-ledger timestamps are intentional results
of the controlled hosted migration application; the migration names and
installed function definition were verified directly after application.

## Verification

- A rollback-only capacity regression ran through the same authenticated AAL2
  browser RPC with a seven-second timeout: 142 source shift blocks and 136
  source placements copied within the guard. It carried 135 eligible
  placements, left the six originally open shifts plus one approved-leave shift
  open, preserved the valid Dispatch overlap, retained wall-clock behavior
  across DST, wrote the expected audit record, and rolled every fixture back.
- A live-size rollback-only rehearsal against the reported schedule passed
  without retaining a destination draft, assignment, audit fixture, or change
  to the source schedule.
- Existing rollback-only regressions for Time Off intervals, DST boundaries,
  Schedule time basis, and Dispatch overlap all passed. The direct
  approved-Time-Off assignment denial remains covered and still passes.
- The installed production function was checked directly: it contains one
  cached zone set, locks leave before assignment carry-forward, returns the
  approved-leave skip count, remains `SECURITY DEFINER` with an empty controlled
  search path, allows authenticated execution, and denies anonymous execution.
- Full `pnpm check` passed after this repair was merged: strict TypeScript,
  zero-warning lint, the full unit/regression suite, production builds, and the
  static-asset contract.
- The required actual-component Time Clock Playwright workflow passed after the
  final application build.
- Cloudflare deployed a fresh build successfully. Both production origins
  returned healthy and ready responses, and the live
  `SchedulePage-BTvzWJJF.js` bundle exactly matched the freshly built local
  SHA-256 `1dbd69089fed506ba62c24a55db080a0436aa997bb1720563469dbbf128c31a3`.

## Production release references

- Implementation commit: `011bcae` (`fix: make schedule week copy reliable`)
- Cloudflare Worker version: `c2f7033c-e087-428c-9d57-2adb05489b19`
- Rollback tag:
  `rollback/pre-schedule-week-copy-reliability-repair-20260930`
- Rollback tag target: `8dedd6812cd6d86e7d7bd3314ccb73c727fb9f6c`
- Production origins:
  - `https://app.sygilant.us`
  - `https://sygshift.sygilant.workers.dev`
- Desktop archive copy:
  `C:\Users\Jordan\Desktop\SygShift Changelogs\CHANGELOG_09-30-2026_SCHEDULE_WEEK_COPY_RELIABILITY_REPAIR.md`

## Operational notes

No existing schedule, shift, assignment, Time Off request, punch, payroll row,
notification, or audit record was rewritten by these repairs. The database
changes are forward-only. If a later correction is needed, it must be a new
forward migration; do not edit an applied migration or delete operational
history.

Schedulers can retry **Copy week** normally. If a carried employee has
approved Time Off during the target shift, the copy will succeed and explicitly
identify the number of placements left open for coverage review. The repair
does not invent a replacement or override approved leave.
