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

## Time, Attendance & Payroll

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

## HR, Finance & Employee Lifecycle

### SygShift HR & Finance Suite

- Priority: High
- Target window: Begin immediately after the dedicated Payroll workspace foundation
- Status: Approved / queued
- Added: 08/28/2026

Expand SygShift into a secure, permission-controlled HR and Finance workspace built on the existing permanent employee record. This is a major product initiative and must be delivered as complete, auditable workflows rather than disconnected document-upload screens.

Required navigation and experience:

- Add an **HR & Finance** sidebar group that is visible only when the signed-in user has an applicable effective permission.
- Give the group two focused destinations initially: **HR Center** and **Payroll**.
- Keep the main sidebar compact; use clear subnavigation inside HR Center rather than placing every HR function in the sidebar.
- Keep Time & Attendance responsible for punches, employee time review, exceptions, and corrections; keep Payroll responsible for reviewed payable time and official handoff.
- Use focused pages, compact summaries, search, filters, and open-on-demand detail instead of long all-record pages.

Required HR Center capabilities:

- HR overview and work queue for new hires, expiring documents, missing acknowledgments, pending actions, upcoming separations, and items requiring attention.
- Secure employee files for employment agreements, tax/payroll forms, identification and authorization documents, policies, acknowledgments, performance records, disciplinary records, restricted medical records, and HR correspondence.
- Company document and policy library with assignment by employee, role, or group; versioning; required review or acknowledgment; due dates; reminders; and completion status.
- Onboarding and offboarding checklists covering documents, account access, licensing handoff, training, equipment/uniforms, status changes, and account shutdown.
- Employee-action workflows for factual incidents, coaching, recognition, written warnings, corrective actions, follow-up dates, and restricted HR review.
- Effective-dated employment and leave history, including sick time, vacation/PTO, leave of absence, employment-status changes, and Hourly, Salary, or Flex classification.
- HR reports for headcount, turnover, missing or expiring documents, onboarding status, attendance/accountability trends, and payroll readiness.

Required document controls:

- Store employee documents privately; never expose permanent public file URLs.
- Use short-lived authenticated access for previews and downloads.
- Separate permissions for viewing, uploading, replacing, downloading, categorizing, acknowledging, and deleting documents.
- Support confidentiality levels so general employee files, financial records, identity records, medical records, and disciplinary records can have different access boundaries.
- Record append-only audit history for uploads, views, downloads, replacements, acknowledgments, access changes, and deletions.
- Preserve document versions, retention rules, legal/audit holds where required, backups, and recovery.
- Enforce allowed file types and size limits and add malware scanning before a document becomes available.
- Do not send sensitive employee documents as normal email attachments.

Required identity and integration boundaries:

- Extend the existing employee record and permanent employee number; do not create a second HR directory or duplicate employee identity.
- Link the same employee identity to User Accounts, Directory, Schedule, Time & Attendance, Payroll, Licensing, Availability, Training, Accountability, and HR records.
- Keep legal names authoritative in HR and payroll while preserving preferred-name use in approved employee-facing scheduling contexts.
- Preserve current Licensing Center ownership of credentials and shift eligibility while allowing authorized HR workflows to reference status without duplicating credential records.
- Preserve full history when an employee separates; active views should exclude separated employees by default while authorized users can retrieve historical records.

Required access and security:

- Create functional, server-enforced permissions for each HR and Finance capability; sidebar visibility alone is not authorization.
- Require MFA for sensitive employee-document, employment-status, disciplinary, payroll, and access actions.
- Support role permissions and audited individual grants or denies without broadening existing employee access.
- Employees may access only their own approved self-service documents and acknowledgments unless another permission explicitly authorizes more.
- Keep highly restricted medical, identity, disciplinary, and financial records out of general Supervisor or Scheduler visibility.
- Include loading, empty, success, validation, access-denied, service-error, and recovery states for every workflow.

Planned delivery sequence:

1. Dedicated Payroll workspace and HR & Finance navigation foundation.
2. HR Center foundation, private document storage, permission model, audit model, and secure employee-file profiles.
3. Company documents, policy assignment, acknowledgments, reminders, and employee self-service.
4. Onboarding and offboarding workflows.
5. Employee actions, restricted HR review, leave, and effective-dated employment history.
6. HR reporting, automation, retention administration, and controlled integrations.

Completion standard:

- Do not mark this initiative complete until storage security, server authorization, document lifecycle, audit history, retention, employee self-service, administrative workflows, tests, backup/recovery validation, production deployment, and rollback procedures are all verified.

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
