# SygShift Timekeeping Operations Expansion

Date: 08/18/2026

## Summary

SygShift now includes a controlled operations layer for daily timekeeping, attendance exceptions, employee corrections, call-offs, reporting, alerts, and scheduled automation. The release preserves existing punches and payroll history while adding the workflows needed to resolve real operational issues without editing accurate records simply to clear a warning.

## Employee workflows

- Employees can submit time-adjustment requests with a work date, issue type, requested time, and required explanation.
- Employees can report a sick absence or call-off against an assigned shift.
- Employees can review the status and history of their own requests.
- Automatic clock-outs create an employee notification and a correction path instead of silently treating the generated punch as final.

## Supervisor and administrative workflows

- Authorized users can review timekeeping exceptions in one operations workspace.
- Authorized users can create paired manual time entries for overnight and same-day work.
- Manual time records retain the original values, edits, actor, reason, timestamps, and approval status.
- Authorized reviewers can approve or reject employee adjustment requests with a required decision note.
- Urgent call-off alerts remain visible until an authorized user acknowledges them.
- Permissions and MFA are enforced at the database boundary for every sensitive operation.

## Automated timekeeping protections

- A scheduled job checks published, assigned shifts once per minute.
- Employees still clocked in three minutes after the exact scheduled end receive an automatic clock-out at the scheduled end time.
- Automatic clock-out processing is idempotent and protected against concurrent job execution.
- The system records the generated time event, exception, audit entry, employee notification, operations alert, and queued email in one transaction.
- Missing clock-ins create a review exception without inventing a punch.
- Existing valid clock-outs and previously processed shifts are never duplicated.

## Reporting and payroll

Eight permission-controlled operations reports are available:

1. Timekeeping Exceptions
2. Automatic Clock-Outs
3. Manual Time Entry Audit
4. Time Adjustment Requests
5. Attendance and Call-Offs
6. Scheduled vs. Actual Hours
7. Coverage and Unfilled Shifts
8. Overtime and Payroll Risk

Schedule notes are included in payroll workbook detail rows. Existing Sunday-through-Saturday payroll rules and one-week-at-a-time schedule publishing remain intact.

## Email safety

- Outbound email is checked against a centralized suppression rule before the provider is called.
- `guardianshipsecurity.net` is suppressed by default and can be controlled through the Worker environment configuration.
- Suppressed attempts are recorded with recipient, category, reason, and time for audit review.

## Database and security

- Added operational exception, job-run, manual-entry, adjustment-request, call-off, alert, acknowledgment, email-attempt, and history records.
- Added server-side validation for date ranges, time order, maximum duration, employee/shift relationships, active records, permissions, MFA, and reason requirements.
- Employee self-service time access is isolated from team-wide operational records; only explicit operational permissions expose team data.
- Applied and recorded seven production migrations for the feature and its database-integrity and visibility repairs.
- Verified the secured workspace and all report datasets using an authenticated admin session with MFA claims.

## Validation completed

- TypeScript type checking and linting.
- Automated unit, integration, worker-schedule, authorization, export, and migration guard tests.
- Production application build.
- Live Supabase RPC contract checks.
- Cloudflare Worker readiness and live-site verification.
