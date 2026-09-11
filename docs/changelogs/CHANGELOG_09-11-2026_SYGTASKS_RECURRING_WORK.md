# Guided Recurring SygTasks

Date: 09/11/2026

## Outcome

- Added a guided **Repeat this task** flow to the existing New Task dialog without changing the one-time task path.
- Employees can repeat work daily, weekly, or monthly, choose an interval and time zone, and end the series on a date, after a number of occurrences, or manually.
- An optional reminder or repeating alarm can be attached to every generated occurrence. Each occurrence receives its own reminder state, so acknowledged and snoozed alarms are never reused.
- Every generated occurrence is a normal, independent SygTask with its own assignee, status, activity, search visibility, completion state, and notification lifecycle.
- Task Detail now includes a **Repeat** workspace with schedule, next date, occurrence history, audit history, and guided pause, resume, skip-next, future-update, and stop controls.
- Future changes never rewrite completed or already-generated task history.

## Reliability and access controls

- Recurring-series definitions, occurrences, and lifecycle activity are private forced-RLS records with no direct browser table access.
- Authenticated RPCs recheck the active account, board visibility, task-management permission, optional assignee eligibility, and optimistic series version.
- A unique series/date boundary plus advisory locking and request identifiers prevent duplicate occurrences during retries or overlapping Worker runs.
- The scheduled processor uses a bounded seven-day horizon. It generates due occurrences before the existing reminder processor runs, allowing a newly due alert to use the established notification, email, badge, and alarm pipeline in the same scheduled pass.
- Archiving a board stops its future series. Deactivating the owner pauses generation. An ineligible assignee is removed from the future occurrence rather than preventing authorized work from being created.
- Stopping or changing a series does not delete historical tasks, activity, reminders, or audit evidence.

## Verification

- Focused recurring-task, task-dialog, data-contract, reminder-guard, and Worker tests: 28 passed.
- Full repository gate: TypeScript passed; lint passed; 247 test files / 1,265 tests passed; production Worker and client builds passed.
- SygTasks rendered workflow matrix: 10 passed across light/dark desktop, laptop, tablet, mobile, dialogs, keyboard focus, accessibility checks, and 200% reflow.
- Transactional database migration and recurring lifecycle regression completed successfully with rollback, including idempotent create and processor retry, independent completion, pause/resume, skip-next, and stop behavior.
- `git diff --check`: passed.

## Primary implementation

- `supabase/migrations/20260912160000_sygtasks_recurring_work.sql`
- `supabase/tests/sygtasks_recurring_work_regression.sql`
- `src/components/sygtasks/SygTasksDialogs.tsx`
- `src/components/sygtasks/SygTasksRecurringPanel.tsx`
- `src/data/sygtasks.ts`
- `src/pages/SygTasksPage.tsx`
- `src/styles/sygtasks.css`
- `worker/index.ts`
- related focused, data, component, Worker, and source-guard tests

## Recovery boundary

The application rollback tag preserves the pre-release source. The database change is additive and forward-only; it does not modify existing boards, tasks, assignments, reminders, alarms, or activity records.

## Production release

- Source commit: `6d18838` (`feat: add guided recurring SygTasks`), pushed to `origin/main`.
- Recovery tag: `rollback/pre-sygtasks-recurring-work-20260911`.
- Migration `20260912160000` applied and recorded in linked production history.
- The production rollback-only lifecycle regression passed without leaving a series, occurrence, task, reminder, or activity record behind.
- Existing operational work remained identical before and after migration: 5 boards, 9 tasks, 9 assignments, 3 reminders, and task fingerprint `8102a448ef888b3c412ec02513d23521`.
- Private recurring tables expose zero direct `anon` or `authenticated` table grants; authenticated clients use the three approved RPC boundaries.
- Mandatory post-release actual-component Time Clock matrix: 42/42 passed on desktop and mobile.
- A fresh production build was created after the final browser run and deployed as Cloudflare Worker version `cee4fa73-685a-44cf-86c3-94627cd32f89`.
- Primary and fallback root, health, and readiness endpoints returned HTTP 200. `/tasks` returned HTTP 200, and the live primary entry bundle exactly matched the fresh production build.
- The owner account remained active, activated, enabled, and outside the Required Actions canary throughout this release.
