# SygTasks Reminders and Alarms

Date: 09/09/2026

## Problem and user impact

SygTasks could organize and assign work but could not remind an employee at a chosen time or continue alerting them when a task required an alarm. A device-local timer alone would have been unreliable across refreshes, multiple tabs, reassignment, due-date changes, and closed sessions, and could have created duplicate sounds or misleading acknowledgment history.

## Root cause and release design

There was no authoritative reminder definition, per-recipient occurrence lifecycle, scheduled delivery processor, alarm state RPC, or separate SygTasks badge/audio surface. This release adds those capabilities as a server-authoritative extension of the existing SygTasks, Notification Center, Realtime, email, and Cloudflare scheduled-processing boundaries.

## Functional behavior

- Task Detail now includes a rounded, responsive **Reminders** workspace.
- A reminder notifies once. An alarm repeats the owner-provided SygTasks sound while an authorized visible SygShift tab is open, with approximately six seconds of silence after the sound before the next play.
- Employees can create private reminders for themselves. An authorized task editor can create a reminder or alarm for the task's current assignees.
- Scheduling supports a specific Mountain Time date/time or a lead time relative to the task due time. Optional email uses the existing approved employee delivery queue.
- Active alarm controls include **Stop alarm**, **Snooze** for 5, 10, 15, 30, or 60 minutes, **Open task**, and **Mark complete** when the employee is authorized.
- Opening the task silences only the current browser; it does not record a false acknowledgment. Stop, snooze, completion, cancellation, and automatic lifecycle changes persist on the server across sessions and devices.
- Relative occurrences follow a changed task due date. Task completion/cancellation/archive, assignment removal, and ineligible accounts cancel affected future or active occurrences while retaining history.
- One browser tab owns custom alarm playback at a time. Multiple active alarms do not overlap; the active card shows how many more are waiting.
- SygTasks has an independent launcher badge. SygSphere message counts and sounds remain separate.
- Device Sound Settings now have an independent **Task alarms** toggle and test control. The supplied `loz_secret_BL9kfi1.mp3` was copied byte-for-byte to a content-versioned SygTasks asset.
- If the browser is closed or suspended, the existing background browser/device notification path provides the alert subject to device permission and operating-system policy; a website cannot keep a custom MP3 repeating after its process is closed.
- Recurring task generation was deliberately kept out of this release and recorded as a separate later Future List item.

## Authorization, privacy, and reliability

- Reminder tables are private, forced-RLS records with direct browser table grants revoked.
- Authenticated RPCs recheck active account state, task visibility, ownership/edit rights, current assignment, and task lifecycle. The due processor is service-role only.
- Each definition expands to recipient-specific occurrences. Database uniqueness and request IDs keep creation and processing idempotent.
- The minute scheduler claims bounded due work with `FOR UPDATE SKIP LOCKED`; it revalidates access before delivery and emits only private employee-scoped invalidation signals.
- In-app and optional email delivery share one occurrence lifecycle so an alarm cannot be represented as delivered, stopped, or snoozed solely by client state.
- The new scheduled job runs in an independent Cloudflare `waitUntil` branch, so a reminder failure cannot block timekeeping automation, ticket delivery, employee notifications, or other scheduled work.
- Fallback tag `rollback/sygtasks-reminders-pre-release-20260909` preserves the pre-release application source. Production database recovery remains forward-only; applied migration history is not rewritten.

## Files and migrations

Primary implementation areas:

- `src/components/SygTasksAlarmHost.tsx` and `src/components/SygTasksAlarmHost.css`
- `src/components/sygtasks/SygTasksRemindersPanel.tsx`
- `src/components/sygtasks/SygTasksDialogs.tsx`
- `src/components/SygTasksLauncher.tsx` and `src/styles/sygtasks-launcher.css`
- `src/components/LiveNotifications.tsx`
- `src/components/NotificationPreferences.tsx` and `src/components/NotificationPreferences.css`
- `src/lib/notificationSounds.ts`
- `src/data/sygtasks.ts`
- `src/components/AppShell.tsx`
- `worker/index.ts`
- `public/sounds/SygTasks_Alarm_6aa3fd61.mp3`
- related unit, guard, Worker, shell, sound, data, and launcher tests
- `docs/ARCHITECTURE.md`
- `docs/future-items/FUTURE_ITEMS.md`

Production migrations:

- `20260911020000_sygtasks_task_reminders.sql` — private reminder/occurrence storage, lifecycle reconciliation, authenticated RPCs, service processing, notification/email delivery, auditing, grants, indexes, and Realtime signaling.
- `20260911021000_sygtasks_assignee_reminder_variable_repair.sql` — forward-only correction for an ambiguity found by the production database linter before application release.

Both migrations are present in linked production history. The database linter reports no issue for the new reminder functions after the repair. The rollback-only SQL lifecycle suite is checked in as `supabase/tests/sygtasks_task_reminders_regression.sql`; local execution was unavailable because this workstation has no Docker or Podman database runtime, and that limitation was not misreported as a pass.

## Verification

- `pnpm check`: passed.
  - TypeScript project build: passed.
  - `oxlint src worker --deny-warnings`: passed.
  - Vitest: **228 files / 1,143 tests passed**.
  - Production Worker and client builds: passed.
- Focused SygTasks reminder/alarm, sound preference, launcher badge, data contract, migration guard, shell lifecycle, and scheduled Worker tests: passed.
- Actual-component Time Clock preservation matrix: **42/42 desktop and mobile checks passed**, including early clock-in acknowledgment, clock-in/break/clock-out, split-shift return, duplicate prevention, active controls, dispatcher/admin/supervisor/guard roles, errors, and light/dark presentation.
- SygTasks rendered layout/accessibility matrix: **10/10 checks passed** across light/dark desktop, laptop, tablet, mobile, 200% reflow, dialogs, keyboard focus, overflow, and WCAG automated checks.
- Supplied/copy audio SHA-256: `6AA3FD616B52905480D596C7A747D7129687AB3845CCC307565B7AEF16506198` on both files.
- `git diff --check`: passed.

## Production release

- Application source commit: pending final release commit.
- Git push: pending.
- Cloudflare Worker version: pending.
- Primary and fallback health/readiness: pending post-deployment verification.
- Live route and asset identity: pending post-deployment verification.
- Post-deployment actual-component Time Clock matrix: pending.

## Remaining boundary

The deployed system supports one-time reminders and repeating alarms. Recurring task creation is intentionally deferred until the one-time lifecycle has been operationally accepted. Browser and operating-system rules prevent a web page from continuously playing a custom audio file after all SygShift tabs are closed; the background alert remains a device notification rather than an uncontrolled audio loop.
