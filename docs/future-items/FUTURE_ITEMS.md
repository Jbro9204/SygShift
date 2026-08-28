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

## Security, Identity & Account Protection

### Hardware Security Key MFA Pilot

- Priority: High
- Target window: Controlled administrator pilot after the current workspace usability corrections
- Status: Approved / queued
- Added: 08/28/2026

Add FIDO2/WebAuthn hardware security keys as a phishing-resistant MFA option, beginning with Jordan Brown as the only pilot user. A verified security-key challenge must satisfy the application's MFA requirement; it is not a password-only bypass. When a key is unavailable, cancelled, or fails, the existing authenticator-app workflow remains available and all users without a registered key continue under the current rules.

Required My Account experience:

- Add a focused **Security Keys** area under **My Account > Security**.
- Allow the signed-in employee to add a key, give it a friendly name, view the date added and last-used date, rename it, and remove it.
- Keep the existing authenticator method enrolled during the pilot so the user has a controlled fallback.
- Require recent authentication before registering, renaming, or removing a security key.
- Explain in plain language that the physical key replaces the authenticator-code step when used successfully; it does not remove account security.

Required login behavior:

- Verify the username and password first, then offer a registered FIDO2/WebAuthn key as the preferred MFA factor.
- Treat a successful security-key challenge as verified MFA at the same protected access level required for administrative workflows.
- Fall back to the normal authenticator-app challenge when the key is unavailable or the user chooses another method.
- Never fall back to password-only access and never weaken server-side AAL2 or permission enforcement.
- Preserve safe return-to-page behavior, trusted-device rules, inactivity handling, and existing session protections.

Required administration and audit controls:

- Add authorized User Accounts controls to view registered-key status and revoke or reset a lost or compromised key without exposing key material.
- Record key registration, rename, successful use, removal, administrative revocation, and recovery actions in the audit history.
- Send a security notification when a key is added or removed.
- Use a feature flag and a single-user allowlist for the initial pilot, with a tested rollback that leaves authenticator MFA operational.
- Keep the relying-party identity stable for the production SygShift domain so later URL or deployment changes do not invalidate enrolled keys.

Required validation:

- Confirm current Supabase/WebAuthn support and production limitations before implementation; do not rely on an experimental authentication path without a controlled fallback.
- Test Chrome, Edge, supported mobile behavior, cancelled challenges, absent keys, lost keys, authenticator fallback, revocation, concurrent sessions, server authorization, and audit records.
- Complete the Jordan-only pilot before deciding whether to expand security-key enrollment to other users.

## Navigation & Workspace Usability

### Canonical My Time and Review Queue Navigation

- Priority: High
- Target window: Next focused usability release
- Status: Approved / queued
- Added: 08/28/2026

Audit the Time & Attendance routes and navigation because the employee-facing destination reached from **My Time** currently appears to duplicate the **Review Queue** experience. Create one clear path for employee self-service and one clearly identified path for authorized team review without maintaining duplicate-looking pages or ambiguous buttons.

Required outcomes:

- Keep **My Time** focused on the signed-in employee's own punches, breaks, pay periods, correction requests, and request status.
- Keep **Review Queue** focused on authorized Supervisor, Scheduler, Dispatcher, Admin, Payroll, or other specifically permitted review work.
- Consolidate duplicate routes or shared content into one canonical implementation where appropriate instead of maintaining visually identical copies.
- Give each destination a distinct page title, description, breadcrumb/back behavior, empty state, and primary actions.
- Ensure employee users cannot see team records merely because a route or button is visible; enforce the difference on the server and through effective permissions.
- Remove or rename redundant links so a user can predict where each action will take them.
- Preserve direct links, back navigation, pending form state, mobile behavior, and current correction-request history.
- Add navigation, permission, and route tests for employee self-service and authorized team-review users.

### Accessible Sidebar Collapse Control

- Priority: High
- Target window: Next focused usability release
- Status: Approved / queued
- Added: 08/28/2026

Replace the nearly invisible sidebar-collapse control with a clear, accessible navigation control that is easy to find and use without disrupting the premium SygShift layout.

Required outcomes:

- Provide a clearly visible control attached to the sidebar edge with an approximately 44-by-44-pixel interaction target.
- Use the established SygShift color, border, icon, hover, active, and keyboard-focus styles; do not use a tiny white sliver or an unrelated button treatment.
- Provide accessible labels and tooltips that change between **Collapse navigation** and **Expand navigation**.
- Keep the control visible at supported desktop resolutions without covering page content or becoming clipped.
- Use the existing mobile navigation pattern rather than forcing the desktop collapse control onto narrow screens.
- Preserve the user's navigation preference where appropriate without causing a page reset, route change, or loss of unsaved work.
- Test expanded and collapsed states, keyboard use, zoom, high-contrast visibility, supported viewport sizes, and mobile navigation.

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

1. Dedicated Payroll workspace and HR & Finance navigation foundation. **Completed 08/28/2026.**
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
