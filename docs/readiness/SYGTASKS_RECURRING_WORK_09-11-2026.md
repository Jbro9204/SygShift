# Recurring SygTasks Release Readiness

Date: 2026-09-11

Decision: **Ready for additive production release after live postflight**

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

## Required live postflight

- Apply and ledger the additive migration.
- Re-run the rollback-only lifecycle regression against linked production.
- Confirm existing board, task, assignment, and reminder counts/fingerprints are unchanged.
- Confirm no recurring series exists until a user deliberately creates one.
- Deploy the Worker and verify health/readiness, scheduled processing, SygTasks desktop/mobile layout, and time-clock preservation.
