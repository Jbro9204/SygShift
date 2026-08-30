# HRIS Automation Rollback

## Purpose

This procedure stops HR automation processing and task delivery without deleting workflow definitions, immutable versions, instances, tasks, event history, jobs, schedules, notification evidence, or dead letters.

## Immediate containment

1. Set `SYGSHIFT_HR_AUTOMATION_ENABLED=false` and deploy the Worker.
2. Set `private.hr_automation_release_gate.enabled=false` through an approved, audited administrative operation.
3. Confirm the administrative workspace returns the unreleased response for an otherwise authorized test account.
4. Confirm scheduled Worker logs report HR automation as disabled and claim no new jobs.
5. Pause affected definitions or schedules if the incident is limited to one workflow.
6. Preserve in-flight jobs, failures, dead letters, task records, notification outbox records, and append-only events for review.

Either release control being false stops new Stage 5 processing. Set both false during containment.

## Preservation requirements

Do not delete or rewrite records as part of rollback.

- Preserve immutable workflow versions.
- Preserve workflow instances and human tasks.
- Preserve the original actor, completion note, due date, reminder, and escalation evidence.
- Preserve append-only workflow events.
- Preserve job attempts, leases, failures, and dead letters.
- Preserve notification outbox and delivery history.
- Do not change existing employee accounts, roles, role permissions, or individual overrides unless a separately approved access incident requires it.

## Verification after containment

1. Verify both Stage 5 release controls are false.
2. Verify the job runner claims zero Stage 5 jobs.
3. Verify no Stage 5 task appears in the Action Center.
4. Verify the application, authentication, Schedule, Time & Attendance, Payroll, Licensing, User Accounts, Roles & Permissions, HR People, and HR Documents remain operational.
5. Verify existing access-control counts remain unchanged.
6. Run `pnpm check:hris-automation`.
7. Run `pnpm check`.
8. Record the incident window, affected workflow versions, containment actor, retained evidence, and recovery decision.

## Recovery

Treat recovery as a new controlled release. Correct the cause, publish a new workflow version when behavior changes, repeat authorization and reliability tests, validate notification delivery, complete a canary, and obtain new activation evidence. Never edit an immutable published version or re-enable processing solely because the original error is no longer visible.

