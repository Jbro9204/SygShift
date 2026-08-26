# SygShift Maintenance and Safe Release Runbook

Date: 08/25/2026

## Purpose

Use System Operations to warn employees about planned work, protect only the workflows being changed, and restore normal access predictably. Maintenance controls are inactive by default and must be scheduled by an authorized System Admin with MFA.

## Access

- Open **Administration → System Operations**.
- The required permission is `admin.maintenance.manage`.
- The permission is critical, requires MFA, and is granted to the protected System Admin role only.
- Do not grant this permission as routine operational access.

## Access modes

| Mode | Employee impact | Appropriate use |
| --- | --- | --- |
| Notice only | Employees receive the maintenance message; normal access continues. | Low-risk releases that do not require write protection. |
| Read-only | Employees can view affected areas, but protected database writes are rejected. | Data migrations or releases where reading is safe but edits must pause. |
| Temporarily unavailable | Affected pages show a maintenance panel and protected writes are rejected. | Major or emergency work where the workflow cannot be used safely. |

## Schedule a window

1. Open **System Operations** and choose **Schedule maintenance**.
2. Choose the release type and least-disruptive access mode that is safe.
3. Enter the start and end in Mountain Time. Every window must end after it starts, remain under 24 hours, and end in the future.
4. Write a clear employee-facing title and message.
5. Select only the affected features. Keep **Employee Time Clock** available unless the release specifically makes clocking unsafe.
6. Review the form and choose **Schedule maintenance**.

SygShift does not activate maintenance merely because code was deployed. The saved schedule and server time control activation. Overlapping maintenance windows are rejected so employees never receive conflicting instructions.

## During maintenance

- Employees see one global notice with the start/end time and affected features.
- Notice-only work does not restrict access.
- Read-only and unavailable modes are enforced at the database for configured operational tables, including calls made outside the visible page.
- Unavailable pages are replaced with a focused maintenance message.
- A release-refresh prompt waits for active saves to finish before refreshing the application.
- The maintenance window ends automatically at the scheduled end time even if an administrator does not return to close it.

## Complete or cancel

- For active work, choose **Complete maintenance**, confirm the completion message, and choose **Complete now**.
- For future work that will not occur, choose **Cancel window**.
- Closing a window restores write access immediately and records the actor, action, time, and affected record in the audit history.

## Release procedure

1. Confirm the intended Git commit and database migration.
2. Run `pnpm check` and resolve every failure.
3. Schedule a maintenance notice only if the release requires it.
4. If writes must pause, select the exact affected features and use read-only or unavailable mode.
5. Confirm employee time clock availability before starting the release.
6. Apply database migrations and verify applied history.
7. Deploy the Cloudflare Worker and assets.
8. Verify `/api/v1/health` and `/api/v1/ready`.
9. Test the changed workflow using the intended role.
10. Complete maintenance and record the release in `docs/changelogs/`.

## Recovery

- If the release fails but SygShift remains safe, leave the window active while rolling back or correcting the release.
- If the window end is near, edit it before it expires; the new end must still remain within 24 hours of the start.
- If System Operations is unavailable, database controls still expire at the saved end time.
- Never extend protection by creating overlapping windows. Complete or edit the current window first.
- Never modify production employee, schedule, timekeeping, or payroll records solely to test maintenance behavior.

## Verification checklist

- No maintenance window is active before the approved start.
- The employee message is readable on desktop and phone widths.
- Only selected features are affected.
- Read-only/unavailable writes fail without partial data changes.
- Unaffected features, especially the employee time clock, remain functional.
- The end time restores access automatically.
- Completion/cancellation appears in recent maintenance history.
- The audit record identifies the administrator and action.

## Production acceptance record

The first controlled production rehearsal was completed on 08/25/2026 Mountain Time.

- A Communications-only read-only window displayed upcoming and active states at the expected server times.
- A protected Communications write was rejected at the database boundary.
- Time Clock remained outside the maintenance scope, and the verification transaction left production time records unchanged.
- The MFA/System Admin close control restored Communications writes immediately and created the expected audit history.
- A second notice-only rehearsal ended automatically and appeared as expired in System Operations before its history record was closed.
- Production was returned to zero scheduled, active, or upcoming windows after validation.

This acceptance record verifies the safe default and recovery path. Future releases must still follow the checklist above and use the smallest safe feature scope.
