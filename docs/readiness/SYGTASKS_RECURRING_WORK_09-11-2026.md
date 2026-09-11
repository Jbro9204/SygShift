# Recurring SygTasks Release Readiness

Date: 2026-09-11

Decision: **Released and verified in production**

## Preserved behavior

- The existing one-time task creation path is unchanged unless **Repeat this task** is deliberately enabled.
- Existing boards, tasks, assignments, comments, files, activity history, reminders, alarms, badges, and email preferences are not rewritten.
- Existing task reminders and alarms continue to use the same delivery and acknowledgment lifecycle.

## User workflow

1. Create a task normally and enable **Repeat this task** only when needed.
2. Choose daily, weekly, or monthly cadence, interval, and time zone.
3. Choose when the series ends.
4. Optionally add one reminder or repeating alarm for each occurrence.
5. Review the plain-language summary and create the series.
6. Use the task's **Repeat** tab to pause, resume, skip the next date, update future work, or stop the series.

## Safety contract

- Each occurrence is independent; completing one does not complete the series or another occurrence.
- Server-side uniqueness and locking prevent duplicate occurrence creation.
- Scheduler retries are idempotent and processing is time-bounded.
- Series changes apply only to future occurrence templates and preserve historical work.
- Board archive, owner deactivation, and assignee ineligibility fail safely without deleting prior records.
- Browser clients receive only permission-scoped RPC output and the existing private realtime invalidation signals.

## Pre-release evidence

- Database migration dry run: passed.
- Transactional lifecycle regression with rollback: passed.
- Focused automated tests: 28 passed.
- Full repository check: 247 files / 1,265 tests, typecheck, lint, and production build passed.
- Rendered SygTasks layout/accessibility matrix: 10 desktop, laptop, tablet, mobile, dialog, and 200% reflow checks passed.

## Live postflight

- [x] Applied and ledgered additive migration `20260912160000`.
- [x] Re-ran the rollback-only lifecycle regression against linked production.
- [x] Confirmed existing counts and task fingerprint are unchanged: 5 boards, 9 tasks, 9 assignments, 3 reminders, fingerprint `8102a448ef888b3c412ec02513d23521`.
- [x] Confirmed zero recurring series, occurrences, or series-activity rows remained after the rollback test.
- [x] Confirmed private table access and the three authenticated RPC boundaries.
- [x] Passed 42/42 actual-component desktop/mobile Time Clock preservation checks.
- [x] Rebuilt production assets after the final browser suite and deployed Worker version `cee4fa73-685a-44cf-86c3-94627cd32f89`.
- [x] Confirmed primary and fallback root, health, and readiness endpoints are HTTP 200 and the live entry bundle matches the fresh production build.
