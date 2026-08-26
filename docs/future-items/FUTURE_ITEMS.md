# SygShift Future Items

This is the active queue for approved or retained work that has not been completed.

Keep this repository copy synchronized with:
`C:\Users\Jordan\Desktop\SygShift Future Items\FUTURE_ITEMS.md`

## Queue Rules

- Every item must have a category, priority, target window, status, and added date.
- Assign work to the category that owns the outcome, even when implementation touches several areas.
- When an item is completed, record it in the dated changelog and `DEVLOG.md`, then remove it from this active queue.
- Do not mark an item complete because a screen or button exists. The full authorized workflow, persistence, audit behavior, tests, and production verification must be complete.
- All displayed dates and dated documentation use MM/DD/YYYY.

## Access, Identity & User Administration

### Manage Employee Access Workspace Redesign

- Priority: High
- Target window: Next user-administration release
- Status: Approved / queued
- Added: 08/25/2026

Replace the current long, confusing employee-access modal with a clear task-focused workspace for individual access changes.

Required outcomes:

- Use a comfortably sized, responsive workspace instead of a cramped or excessively long modal.
- Separate role memberships, individual grants/denials, active overrides, and effective-access review into clear steps or tabs.
- Group permissions under the established application categories.
- Explain inherited role access versus person-specific exceptions in plain language.
- Keep save actions close to the setting being changed and show immediate loading, success, and refreshed state.
- Preserve server-enforced authorization, MFA requirements, audit notes, and Admin recovery safeguards.

### User Accounts Consolidation and Preferred-Name Boundary

- Priority: High
- Target window: Near-term user-administration release
- Status: Approved / queued
- Added: 08/25/2026

Refine the current Users & Access area into a focused User Accounts workspace now that roles and permissions have their own administration area.

Required outcomes:

- Evaluate and apply the clearer `User Accounts` name throughout navigation, headings, and documentation.
- Keep account activation, usernames, login history, MFA reset, onboarding messages, and account recovery in this workspace.
- Keep role and permission design in Roles & Permissions while still showing the employee's effective role/access summary where useful.
- Treat preferred names as schedule-facing display data; use legal/profile names in User Accounts and other controlled employee records unless a specific workflow calls for the preferred name.
- Preserve the existing first-name schedule disambiguation rules so similar employee names remain clear.

## Time, Attendance & Payroll

### Employee Timecard History and Current-Period Defaults

- Priority: High
- Target window: Near-term timekeeping release
- Status: Approved / queued
- Added: 08/25/2026

Give employees a clean way to review their own current and prior timecards without exposing team-level payroll controls.

Required outcomes:

- Default employee and authorized staff time views to the current pay period.
- Provide simple previous/next pay-period navigation and a clearly labeled custom range only where appropriate.
- Let employees review their own punches, breaks, work locations, calculated worked time, and submitted correction status for prior periods.
- Keep supervisor/admin correction tools permission-controlled and separate from employee self-service.
- Apply the established Sunday-through-Saturday workweek and overnight workday ownership rules everywhere.

### Dedicated Payroll Workspace and Export Navigation

- Priority: High
- Target window: Near-term payroll experience release
- Status: Approved / queued
- Added: 08/25/2026

Separate payroll work from the general Time & Attendance workspace and remove the need to scroll through a long employee list before reaching export controls.

Required outcomes:

- Give Payroll Export a dedicated, permission-controlled navigation destination.
- Keep Time & Attendance focused on clock status, employee time review, exceptions, and corrections.
- Replace the long always-expanded employee section with a compact searchable summary and open-on-demand employee detail.
- Default payroll views to the current pay period while retaining approved period shortcuts and custom-range export.
- Preserve one summary row per employee, Week 1/Week 2 payroll separation, employee detail sheets, overnight attribution, exception readiness, and official-export locking.

## Workforce Organization & Scheduling

### Supervisor Assignment and Scoped Workforce Visibility

- Priority: Medium
- Target window: After current access and payroll usability work
- Status: Pinned for later
- Added: Before 08/25/2026

Add an Assigned Supervisor field to employee profiles so supervisors can default to the employees they are responsible for without changing the permissions that authorize each action.

Required outcomes:

- Keep permission authorization separate from employee visibility scope.
- Preserve full-company visibility for authorized Admin users.
- Define whether assignments can be employee-based, site/post-based, or both.
- Provide focused views for My Employees, All Employees, Unassigned, and By Supervisor where authorized.
- Preserve audited exception access when a supervisor needs to help outside their normal scope.

## Recruiting & External Integrations

### Indeed Employer Integration and Recruiting Depot

- Priority: Research
- Target window: Later expansion
- Status: Pinned for later
- Added: Before 08/25/2026

Research whether Indeed Employer can connect to SygShift/Sygilant and support a dedicated Recruiting Depot for applicants, recruiting stages, licensing progress, and onboarding handoff.

Required outcomes:

- Confirm available Indeed Employer APIs, permissions, costs, and data-use limitations before committing to an integration.
- Define the recruiting record lifecycle and its handoff into the employee, licensing, and user-account workflows.
- Evaluate secure email parsing, controlled CSV intake, or manual intake if a direct integration is not viable.
- Keep the recruiting expansion separate from current production-critical scheduling and payroll work.

## Completed Work

Completed initiatives do not remain in this active queue. Their implementation history is retained in `docs/changelogs/` and `DEVLOG.md`.
