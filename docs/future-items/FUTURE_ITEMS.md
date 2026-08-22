# SygShift Future Items

Use this file for ideas we want to keep visible but are not building yet.

Keep this repo copy in sync with:
`C:\Users\Jordan\Desktop\SygShift Future Items\FUTURE_ITEMS.md`

Maintenance rule:
When a future item is implemented, record it in the proper changelog/devlog, then remove it from this active future list so this file stays current.

## Active / Recently Closed

### Employee Time & Attendance Self-View
Status: Completed 07/29/2026

Outcome:
Employees can view their own Time & Attendance without exposing supervisor payroll review tools.

### Users & Access Account Activity Filters
Status: Completed 07/29/2026

Idea:
Let admins filter by account setup and activity status so rollout issues are easier to find.

Notes:
- Built filters should use real account activity data only.
- Email delivery filters require persisted welcome/login email send timestamps before they are added.

### Multi-Day Manual Shift Creation
Status: Completed 07/29/2026

Idea:
Schedulers need to add the same shift to multiple days without recreating it one day at a time.

Notes:
- Keep this limited to the selected schedule week until a full recurring-shift preview and approval flow is designed.
- The UI must show the dates being created before save.

### Timekeeping Operations Expansion
Status: Completed 08/18/2026

Outcome:
- Added automatic scheduled-end clock-out protection with exception, audit, and employee-notification records.
- Added missing clock-in detection without creating false punches.
- Added controlled manual time entry, employee adjustment requests, call-off reporting, urgent operations alerts, and eight operational reports.
- Added server-enforced permissions, MFA checks, validation, idempotency, and audit history for every new workflow.
- Added schedule notes to payroll exports and preserved the existing one-week-at-a-time publishing boundary.

## Pinned For Later

### Accountability Tracker
Status: Pinned for later

Idea:
Allow approved operations users to mark call-offs, late arrivals, and early departures on a shift, with a reliability view per employee.

Requirements before build:
- Protected / state-mandated sick time must be explicitly excluded from negative reliability counts.
- Every entry needs an audit trail showing who recorded it and when.
- Employee-facing language must be careful and professional.
- Reports should separate operational history from payroll/timekeeping records.

### Supervisor Assignment / Scoped Visibility
Status: Pinned for later

Idea:
Add an Assigned Supervisor field to employee profiles so supervisors can default to seeing only their own employees instead of the full company.

Notes:
- Keep access permissions separate from employee visibility scope.
- Admins should still see everyone.
- Decide whether assignment should be employee-based, site/post-based, or both.
- Consider views for All employees, My employees, Unassigned, and By supervisor.

### Indeed Employer / Recruiting Depot
Status: Pinned for later

Idea:
Explore whether Indeed Employer can connect into SygShift/Sygilant through an API or integration, then use that connection to support a Recruiting Depot.

Notes:
- Goal is to better organize applicants, recruiting stages, licensing progress, and onboarding handoff.
- Need to confirm Indeed Employer API access, permissions, costs, and data limits.
- If direct API access is not realistic, evaluate email parsing, CSV import, or manual intake as fallback options.

### Role-Based Welcome/Login Emails
Status: Pinned for later

Idea:
Create role-specific welcome/login emails.

Notes:
- Welcome emails and login credential emails should stay separate.
- Emails should explain role-specific expectations for Guards, Supervisors, Schedulers, Dispatchers, Recruiting & Licensing, and Admins.
