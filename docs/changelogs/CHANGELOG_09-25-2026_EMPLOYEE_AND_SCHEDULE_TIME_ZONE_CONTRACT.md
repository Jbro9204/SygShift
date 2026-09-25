# Employee and Schedule Time-Zone Contract

Date: 09/25/2026
Status: Released to production

## Outcome

SygShift now treats each employee's saved profile time zone as the authority for
that employee's personal schedule, Home schedule, My Time, and early clock-in
experience. Schedulers enter a one-person assigned shift in **Employee Time** and
see the corresponding **Site Time** conversion before saving. Open coverage,
multi-person coverage, and site/post work remain based on **Site Time**.

The trusted server timestamp remains authoritative for punch creation and clock
eligibility. A browser or device clock cannot change the instant recorded by the
timekeeping system.

## Root cause and user impact

The former schedule workflow treated Mountain time as an implicit default at
several employee, site, scheduling, and copy boundaries. An Eastern employee's
intended 9:00 AM shift could therefore require a scheduler to enter 7:00 AM to
produce the desired result, and copied shifts could inherit stale time-zone
metadata. This made the scheduler's input meaning unclear and risked future
one- or two-hour errors, especially across daylight-saving transitions.

The repair establishes one explicit contract instead of relying on browser time,
operator time, or a system-wide default.

## Time-zone authority

- The employee profile is authoritative for a one-person assigned shift and for
  the employee's personal Schedule, Home, My Time, and early clock-in displays.
- The site/post profile is authoritative for open coverage, multi-person
  coverage, and site-oriented views.
- Supported operating zones are Eastern, Central, Mountain, Arizona, and
  Pacific, stored as IANA identifiers.
- Scheduler controls label the active authority as **Employee Time** or
  **Site Time** and show the converted counterpart when one exists.
- Browser and device time zones affect neither the saved shift meaning nor the
  punch timestamp.

## Scheduler and employee workflow

- User Accounts, HR onboarding, Recruiting/Licensing employee creation, and
  candidate conversion now require an explicit employee time zone.
- Sites require a supported site time zone, including Arizona's non-DST
  `America/Phoenix` zone.
- A single assigned employee changes the shift editor to Employee Time and the
  scheduler enters the time exactly as that employee should see it.
- Reassigning or ordinarily editing an existing shift preserves the stored UTC
  instant and its recorded time-basis snapshot unless the scheduler explicitly
  performs a time conversion operation.
- Early clock-in messaging shows the employee's scheduled time in the employee
  profile zone while retaining trusted server time for the actual punch rule.

## Daylight-saving and copy behavior

- Week copy and repeated-shift creation preserve the intended local wall-clock
  time in the current authoritative employee or site zone.
- Spring-forward times that do not exist are rejected before records are
  created.
- Fall-back times that occur twice are rejected as ambiguous instead of silently
  selecting an instant.
- Multi-row operations are atomic: an invalid occurrence prevents the complete
  batch instead of creating a partial schedule.
- Dispatch-overlap behavior remains supported by the repaired week-copy path.

## Production data repair

- Misty Kimbal's authoritative employee profile was corrected from
  `America/Denver` to `America/New_York`.
- Exactly 11 active employee-sourced shift records were relabeled to the
  employee authority while preserving their UTC start and end instants.
- The superseded 09/25/2026 13:00Z record remains unchanged as historical
  evidence.
- The currently published 09/25/2026 14:00Z occurrence remains unchanged and is
  now displayed as 10:00 AM Eastern. It was deliberately not rewritten because
  changing an already-published UTC instant would alter operational history.
  A scheduler may review that single occurrence manually if its intended wall
  clock was 9:00 AM Eastern.
- Future 13:00Z occurrences correctly display as 9:00 AM Eastern.

## Security and preservation boundaries

- Direct schedule and protected employee writes remain revoked from ordinary
  clients; controlled database functions enforce the contract.
- New and repaired functions retain explicit authenticated/service-role grants
  and deny anonymous access.
- The legacy seven-argument candidate-conversion function remains available only
  to the service role during the rolling release, but fails closed with an
  instruction to refresh and supply a time zone. It performs no reads or writes.
- Existing punches, payroll totals, audit history, employee work locations, and
  published UTC instants were not rewritten.
- Each migration uses a transaction-local five-second lock timeout so deployment
  aborts safely rather than waiting indefinitely on a busy production table.

## Files and migrations

Primary implementation areas:

- `src/schedule/timeBasis.ts`, `src/schedule/calendar.ts`, and
  `src/components/ScheduleTimeBasisPanel.tsx`
- Schedule, Time, Home, User Accounts, Onboarding, Licensing, and Sites pages
- Schedule, employee, onboarding, licensing, and timekeeping data contracts
- `worker/index.ts`
- Architecture and build/handoff documentation plus focused guard tests

Forward-only production migrations, applied in this order:

1. `20260925175035_explicit_employee_time_zone_and_misty_repair.sql`
2. `20260925180104_repair_schedule_week_copy_time_basis.sql`
3. `20260925182312_enforce_schedule_dst_boundaries.sql`
4. `20260925190311_enforce_client_site_time_zones.sql`

All four versions are recorded as applied in production. No broad database push
was used.

## Verification

- `pnpm check`: passed with strict TypeScript, zero-warning lint, production
  build, 321 test files, and 1,691 tests.
- Focused release guards: 19/19 passed.
- Mandatory post-deploy Time Clock desktop/mobile matrix: 42/42 passed.
- Production rollback-only SQL regressions passed and rolled back cleanly for:
  employee time-zone authority, onboarding/account creation, week copy,
  dispatch overlap, DST boundaries, and client/site time zones.
- Production postflight confirmed the four migration versions, Misty's Eastern
  profile, the exact 11-row relabel, preserved UTC ranges and superseded history,
  zero unsupported client/site zones, zero pending candidate conversions, and
  zero leftover test fixtures.
- Live read-only UI verification confirmed:
  - Scheduler displays **Site Time — Mountain** for open Administrative coverage.
  - Selecting Misty switches the same unsaved form to
    **Employee Time — Eastern** and displays the Mountain conversion.
  - User Accounts requires an employee time-zone choice.
  - Sites exposes the five supported site zones.
  - The published Schedule displays Misty's 14:00Z occurrence as
    10:00 AM–6:00 PM Eastern.
- Primary and fallback `/api/v1/health` and `/api/v1/ready` endpoints returned
  HTTP 200. A signed-out protected HR endpoint returned HTTP 401.
- Live entry JavaScript, CSS, Schedule, User Accounts, Onboarding, Licensing,
  Sites, Home, My Time, and Time bundles matched the deployed local build
  byte-for-byte.

## Release references

- Production implementation commit:
  `2acd642ffac2afdde2baed2c12031b075520fea9`
- Cloudflare Worker version: `a745a1bc-c6e4-489c-9b88-e7b9b906a70e`
- Rollback tag:
  `rollback/pre-employee-schedule-time-zone-contract-20260925`
- Primary origin: `https://app.sygilant.us`
- Fallback origin: `https://sygshift.sygilant.workers.dev`

## Operator note

HR and Admin users who had SygShift open during the release should perform one
hard refresh before creating an employee, changing a site, or scheduling work.
The preserved 09/25/2026 published Misty occurrence is the only identified item
that may need a manual scheduler decision; the application and database will not
silently rewrite that operational history.
