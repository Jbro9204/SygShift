# HRIS Stage 5 Automation and Action Center

## Release boundary

Stage 5 installs a dormant, deny-by-default workflow engine and a compact Action Center integration. It does not activate any HR workflow, assign any new permission, expose the administrative workspace in navigation, or change an employee's existing access.

Activation requires both independent controls:

- `private.hr_automation_release_gate.enabled = true`
- `SYGSHIFT_HR_AUTOMATION_ENABLED = true`

Production was released on 08/30/2026 with both controls false. A single control cannot activate processing.

## Workflow model

- Definitions describe a stable workflow identity.
- Published versions are immutable execution contracts.
- Instances retain the employee, definition version, state, and lifecycle timestamps.
- Human tasks support assignment, due dates, reminders, escalation, completion notes, and Action Center delivery.
- Events form an append-only history of workflow and task activity.
- Background jobs carry bounded, idempotent work for timers, notifications, and explicitly configured conditions.
- Schedules create due work through service-only processing.
- Dead letters retain exhausted failures for authorized review instead of silently discarding them.

Published definitions and versions are never edited in place. A changed process requires a new version so in-flight work remains reproducible.

## Reliable processing

- The scheduled Worker claims no more than 10 jobs per run.
- Claims use a 120-second lease and database row locking with `skip locked` to prevent concurrent ownership.
- Jobs have stable idempotency keys and a maximum of five attempts.
- Completion and failure are recorded through service-only database procedures.
- Exhausted jobs move to dead-letter storage.
- Notification delivery is handed to the existing notification outbox rather than sent directly from workflow evaluation.
- Condition jobs require an explicit boolean result; the Worker does not evaluate arbitrary expressions or execute stored code.

## Authorization and data boundaries

- All workflow, task, event, job, schedule, and dead-letter tables are in the private schema with row-level security enabled.
- Browser clients cannot read or mutate the private tables directly.
- Administrative access requires an active account, MFA, and the exact `hr.automation.view` permission.
- Management, operation, and manual-override permissions are separate catalog entries for later controlled assignment.
- Personal Action Center task delivery is scoped by the signed-in employee identity.
- Administrative worklists use server-side filters and bounded 5, 10, or 20 item pages.
- Manual task completion requires a meaningful note and records the actor and timestamp.

No Stage 5 permission is assigned to a role or employee by the migrations.

## Action Center integration

The existing Action Center can display assigned HR tasks only after both release gates are active and the signed-in employee has an eligible task. Task actions are compact, open on demand, and require a completion note. When the gates are closed, the existing Action Center behaves exactly as it did before Stage 5.

The separate administrative workspace exists at `/hr/automation`, but it is intentionally absent from navigation and inaccessible without the new view permission.

## Activation prerequisites

Before activation:

1. Approve the first workflow definition and immutable version.
2. Assign the minimum required permissions through the normal access-control workflow.
3. Validate authorization for personal tasks, administrative views, management, operation, and override actions.
4. Verify notification recipients and templates with a non-production destination.
5. Complete a job failure, retry, dead-letter, pause, resume, cancel, and recovery exercise.
6. Record backup and rollback evidence.
7. Enable the database gate for a controlled canary.
8. Enable the Worker flag only after the database canary checks pass.
9. Monitor the first scheduled runs and Action Center delivery before expanding access.

## Production evidence

On 08/30/2026:

- All three Stage 5 migrations were applied successfully.
- All nine private Stage 5 tables were verified with row-level security enabled.
- The database release gate was verified false.
- The Worker release flag was deployed false.
- Workflow definition, job, and task counts were verified at zero.
- Existing employee, account, role-membership, role-permission, and employee-override counts were unchanged.
- Every new permission had zero role assignments and zero individual overrides.
- The full application regression suite passed with 113 test files and 565 tests.
- Production returned HTTP 200 for the application and rejected unauthenticated automation workspace access with HTTP 401.

