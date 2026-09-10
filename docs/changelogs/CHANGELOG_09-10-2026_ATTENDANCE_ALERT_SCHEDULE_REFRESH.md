# Attendance Alert Schedule Refresh

Date: 09/10/2026

## Outcome

Attendance and missing-clock alerts now follow the current published schedule instead of remaining tied indefinitely to an older schedule revision. Assignment removals, restored assignments, relevant shift corrections, and revision publication trigger an immediate server-side refresh after the schedule transaction settles.

The original exception, alert, schedule, assignment, and action evidence remains in place. SygShift changes lifecycle state and appends a reasoned action; it does not delete or rewrite protected source history.

## Authoritative Rules

- A missing-clock occurrence remains open only when the employee still has an active `assigned` or `confirmed` assignment on the equivalent occurrence in the current published schedule.
- Equivalent occurrences retain continuity across schedule revisions by matching week, Site/Post or Event, exact start, and exact end, including overnight shifts.
- A removed employee on an older superseded revision resolves as `schedule_revised`.
- A removed employee on the current published schedule resolves as `assignment_changed`.
- Restoring an assignment reopens only an automatically closed occurrence that is due, still lacks a valid clock-in or call-off, and has no other unresolved equivalent occurrence.
- Salaried employees remain excluded from missing-clock requirements.
- Supplemental Dispatch phone duty remains excluded from separate punch and missing-clock requirements.
- A valid clock-in, active call-off, or canceled current shift continues to resolve the occurrence through the existing authoritative evidence path.

## Reconciliation and Audit

- Added `private.attendance_exception_has_current_required_assignment(uuid)` as the centralized current-schedule predicate.
- Added the private targeted refresh function and a service-role-only scheduled wrapper.
- Added deferred constraint triggers on schedule status changes, shift-assignment changes, and relevant shift changes. Deferral ensures a complete publish/revision transaction is evaluated, not an intermediate half-published state.
- Added `resolved_schedule_revised` and `resolved_dispatch_duty` action types while retaining every existing action value.
- Reopen, resolve, alert-clear, and alert-reactivation operations are idempotent and protected by a transaction advisory lock.
- The every-minute Worker calls the refresh after timekeeping automation and before the existing alert-lifecycle pass. A refresh failure is logged and isolated so patrol, announcements, HR automation, signatures, and notification processing continue.

## Production Reconciliation

The release backfill completed with:

- 52 missing-clock exceptions resolved with append-only action evidence;
- 52 associated alert lifecycle rows cleared;
- 45 of those resolutions identified as obsolete schedule-revision occurrences;
- 12 previously automatic resolutions reopened because the current published schedule again requires those employees for the occurrence; and
- zero unsupported unresolved missing-clock exceptions, zero active alerts backed by resolved exceptions, and zero currently active missing-clock alerts after reconciliation.

The reopened historical occurrences are retained in payroll review because their live operational response windows have elapsed. They do not create a new punch, alter paid time, or rewrite a schedule.

## Manager Workspace and Reports

Time Operations, manager alert counts, and timekeeping exception reports consume the reconciled `status`, `active`, and lifecycle fields directly. Production verification confirmed the manager/report sources contain no unsupported unresolved occurrence and no active alert whose exception is already resolved.

## Verification

- Rollback-only exact migration rehearsal against the linked production schema: passed before release.
- Rollback-only live regression after release: passed revision publication, removed employee, retained equivalent overnight assignment, current assignment removal, restored assignment, salary exclusion, supplemental Dispatch exclusion, lifecycle state, append-only actions, and repeated-call idempotency. All fixtures rolled back.
- `pnpm check`: passed TypeScript, zero-warning application lint, 229 test files, 1,176 tests, and both production builds.
- Actual-component Time Clock workflow: 42/42 passed on desktop and mobile before deployment, including clock-in, break, clock-out, same-shift return, early-clock acknowledgment, permissions, and no-assignment handling.
- Production database: migration `20260912020000` recorded; all three change triggers are deferrable and initially deferred; service execution remains granted only to `service_role`.
- Live Worker scheduled event: completed with `attendanceScheduleRefresh.status = completed` and zero unnecessary state changes.
- Primary and fallback `/api/v1/health`: HTTP 200 with `status: ok`.
- Primary and fallback `/api/v1/ready`: HTTP 200 with `ready: true`.

## Release and Rollback

- Runtime source commit: `87c250f`.
- Migration: `20260912020000_attendance_alert_schedule_refresh.sql`.
- Cloudflare Worker version: `427edcaf-4a38-48ec-8c6d-0764b85cf98f`.
- Pre-release rollback tag: `rollback/attendance-alert-refresh-pre-release-20260910` at `dfd5ef7`.

A rollback may remove the new trigger/service behavior, but the intentional audit actions and lifecycle reconciliation already recorded in production must not be erased. Restoring prior code does not authorize deletion or rewriting of those records.

## Scope Preservation

No employee identity, time event, pay value, payroll record, licensing record, schedule, shift, assignment, call-off, or audit row was deleted. The release changes only attendance-exception and alert lifecycle state when current authoritative schedule or attendance evidence supports that change, and it appends the corresponding audit action.
