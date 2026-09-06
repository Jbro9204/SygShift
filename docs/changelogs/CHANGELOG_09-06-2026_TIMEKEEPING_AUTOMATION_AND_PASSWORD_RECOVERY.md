# Timekeeping Automation and Password Recovery Repair

**Released:** September 6, 2026

## What was found

- The scheduled timekeeping service had stopped completing after September 3. A historical employee clock session was attached to a shift now classified as concurrent Dispatch Phone duty.
- The Dispatch Phone protection correctly rejected new payable clock sessions, but it also rejected the automatic clock-out needed to close that older session. Because the automatic work runs atomically, that one rejection rolled back every other automatic clock-out and missing-clock evaluation in the batch.
- Administrator-assisted password resets already existed, but the employee login page did not contain the promised self-service **Forgot password?** option.
- Production evidence also confirmed that employee clock-in itself remained operational: 31 browser clock-ins from 18 employees were recorded between September 3 and the repair review.

## Timekeeping repair

- Preserved the non-negotiable rule that Dispatch Phone duty does not create a separate payable clock session.
- Added one narrow compatibility path: the system may create a clock-out only when it closes a valid historical Dispatch-linked clock-in/break session. New employee, supervisor, imported, or system clock-ins for Dispatch Phone duty remain rejected.
- Applied production migration `20260906141658_repair_timekeeping_automation_and_self_service_password_reset.sql` through an isolated migration history. The dry run selected only that migration.
- The first repaired scheduled run completed successfully, created two overdue automatic clock-outs, evaluated the accumulated missing-clock work, and resumed downstream notification processing.
- The following scheduled run completed normally with no error and no remaining eligible automatic clock-out candidates.

## Employee password recovery

- Added **Forgot password?** to the signed-out login page with a compact username-based recovery form.
- Active employees with a linked login and approved personal email receive a secure, single-use Supabase recovery link that returns to SygShift's existing password-recovery screen.
- The browser always receives the same accepted response whether the username exists, is disabled, lacks an approved email, or has reached the request limit. The endpoint never returns an employee name, account state, or email address.
- Added hourly per-username and short-window per-request-source limits. Only one-way SHA-256 hashes are retained for rate limiting; raw request-source addresses are not stored.
- Added a private, forced-RLS, append-only reset-request audit table. Anonymous and authenticated browser roles have no table access; only the service Worker can claim a recovery target.
- Delivery uses the existing personal-email preference, blocked-domain protection, audited email provider, and short-lived recovery redirect. Delivery failures are logged without a username or email and do not create an account-enumeration signal.

## Verification

- Type checking and zero-warning lint passed.
- All 169 Vitest files and 811 tests passed, including new Worker, UI, migration, enumeration-safety, and Dispatch-history guardrails.
- The Worker and client production builds passed.
- All 116 desktop and mobile Playwright checks passed.
- Production database migration, scheduled-job recovery, follow-up job completion, and zero remaining eligible automatic clock-out candidates were verified.
- Production deployment and live endpoint checks are recorded below after release.

