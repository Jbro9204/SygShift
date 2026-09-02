+# My Time Pay-Period Total Alignment

Date: 09/02/2026

## Outcome

The My Time **Pay Period** metric now totals every paid timecard row in the complete company payroll period. **Today**, **This Week**, and **Pay Period** remain separate calculations, and the date range displayed above the cards is guaranteed to be the same range used to retrieve the rows.

The same authoritative payroll-range loading order now applies to employee views in the Time Command Center.

## Root cause

My Time requested timecard rows before loading the company's anchored payroll rules. On 09/02/2026, that initial fallback request covered 08/30–09/12. After the response arrived, the page relabeled the card with the correct company period of 08/23–09/05 without refetching the missing first-week rows.

That mismatch made **This Week** and **Pay Period** both display 20.10 hours even though the full period contained additional time.

## Repair

- Load the authoritative payroll rules for every employee who can view their own time.
- Calculate the active payroll period from the trusted server timestamp and those rules.
- Wait for the rules before requesting My Time review rows.
- Include the exact payroll boundaries in the review query key.
- Display the response's own `fromDate` and `throughDate`, preventing a label/data mismatch.
- Apply the same employee-safe rule loading and query gating to Time Command Center.
- Keep missing-time request history aligned to the same payroll-period end date.
- Fail clearly if payroll rules cannot load rather than presenting incomplete totals as correct.

## Production diagnosis

A read-only production comparison for the reported employee confirmed:

- Correct company range, 08/23–09/05: 8 rows, 2,406 paid minutes, **40.10 hours**.
- Incorrect fallback range, 08/30–09/12: 3 rows, 1,206 paid minutes, **20.10 hours**.

No time event, timecard, schedule, payroll, correction, or employee record was modified during diagnosis.

## Verification

- Targeted payroll-range, Time Command Center, and time-rule tests passed: 3 files / 13 tests.
- Full validation passed: TypeScript, zero-warning lint, 152 test files / 737 tests, and both Worker and client production builds.
- All 88 desktop/mobile Playwright checks passed.
- The deployed My Time and Time Command Center assets returned HTTP 200 and contain the authoritative payroll-rule query path.
- Primary and fallback login, health, and readiness endpoints returned HTTP 200; readiness reported all required bindings available.

## Release status

- Git: implementation commit `f33b19f` pushed to `origin/main`.
- Cloudflare: Worker version `f42d7e80-a378-44fc-ac57-acdad654064a` deployed.
- Database migration: none required; this was a client query-range correction.

