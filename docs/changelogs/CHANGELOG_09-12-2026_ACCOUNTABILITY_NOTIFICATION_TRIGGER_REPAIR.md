# Accountability Notification Trigger Repair

**Date:** 09/12/2026
**Status:** Released and verified in production

## Outcome

Authorized managers can again record, review, reopen, void, dismiss, correct, and reclassify employee Accountability occurrences. The occurrence transaction now completes together with its append-only action history, protected employee notification, email-delivery queue row, audit event, and Realtime invalidation signal.

No employee, schedule, shift, punch, timecard, payroll, Accountability, notification, or audit history was deleted or rewritten.

## Problem and user impact

Recording an occurrence for another employee failed with the raw database message `column reference "notification_id" is ambiguous`. Because the failure occurred in an after-insert trigger within the same PostgreSQL transaction, the reported occurrence and its connected action, notification, email, and audit work were rolled back together.

The defect affected employee-facing actions performed by a different authorized actor: create, confirm, mark excused/protected, correct, dismiss, void, reopen, and reclassify. Self-authored actions skipped this employee-delivery branch and therefore did not reproduce the same error.

## Root cause

`private.deliver_accountability_writeup_to_employee()` declared a local PL/pgSQL variable named `notification_id`. The email-delivery insert also used the `notification_id` table column in `ON CONFLICT (notification_id)`. PostgreSQL correctly rejected that reference because it could refer to either the local variable or the column.

## Repair

- Added forward-only migration `20260912200000_accountability_notification_trigger_repair.sql`.
- Renamed the local value to `created_notification_id` and left the delivery column name unchanged.
- Added `#variable_conflict error` to make any future variable/column collision fail during function compilation instead of surviving to a manager workflow.
- Kept the trigger private and denied direct execution to `public`, `anon`, and `authenticated`.
- Preserved notification deduplication, email queueing, the employee update signal, existing action eligibility, permissions, and MFA.
- Replaced raw Supabase/database diagnostics in all Accountability operations with safe, plain-language retry messages. Mutation failures explicitly tell the user that their typed entry or reason remains in the open form.

## Files changed

- `supabase/migrations/20260912200000_accountability_notification_trigger_repair.sql`
- `supabase/tests/accountability_notification_delivery_regression.sql`
- `src/data/accountability.ts`
- `src/data/accountability.test.ts`
- `src/accountabilityNotificationDeliveryRepair.test.ts`
- `DEVLOG.md`
- `docs/changelogs/CHANGELOG_09-12-2026_ACCOUNTABILITY_NOTIFICATION_TRIGGER_REPAIR.md`

## Database verification

- Before the migration, the rollback-only manager workflow reproduced SQLSTATE `42702` at the email-delivery `ON CONFLICT` clause.
- Migration `20260912200000` was applied to the linked SygShift project and recorded in the hosted migration ledger.
- The postflight confirmed the trigger is enabled, the distinct variable is installed, the standalone ambiguous declaration is absent, and browser roles cannot execute the private trigger function.
- The same rollback-only workflow then passed create, confirm, and reclassify operations; it asserted three append-only action rows, three protected employee notifications, and three email-delivery queue rows.
- The complete regression finished with `ROLLBACK`; a postflight count confirmed zero persisted regression fixture events.
- Private-schema database lint did not report the repaired function. It continues to report two older diagnostics in unrelated HR automation/backfill functions that this narrow release did not change.

## Application and release verification

- Focused regression: 4 files / 20 tests passed.
- Complete `pnpm check`: TypeScript, zero-warning application lint, 253 test files / 1,295 tests, Worker build, and client production build passed.
- Complete Playwright gate: 322 passed, 12 intentionally skipped duplicate mobile-project cases, 0 failed.
- Post-release actual-component Time Clock and Early Clock-In gate: 42/42 passed across desktop and mobile.
- `https://app.sygilant.us/api/v1/health` returned `ok`; `/api/v1/ready` returned `ready` with `ready: true`.
- `https://sygshift.sygilant.workers.dev/api/v1/health` returned `ok`; `/api/v1/ready` returned `ready` with `ready: true`.
- The live entry bundle `/assets/index-CJJWoVs6.js` matched the verified local production bundle byte-for-byte (SHA-256 `99A8685894A553B23AAFF9D79CCF56B6DC7A03EC6C053EF4C13590F51558FB25`).

## Release record

- Source commit: `3ea71a2` (`fix: restore accountability occurrence delivery`), pushed to `origin/main`.
- Cloudflare Worker version: `86177ff5-32ec-48dd-b81a-80bfd713cec0`.
- Forward migration: `20260912200000`, applied and recorded.
- Pre-release fallback tag: `rollback/pre-accountability-notification-trigger-repair-20260912` at `1af4692`.

## Recovery and remaining scope

The application can be restored to the prior source with the fallback tag. The database correction is forward-only and compatible with the prior application; a database reversal, if ever required, must be a new migration rather than a rewrite of applied history.

There is no remaining limitation in the reported Accountability create/review/notification workflow. The two unrelated existing private-schema lint findings remain separately scoped and were not broadened into this production-blocker repair.
