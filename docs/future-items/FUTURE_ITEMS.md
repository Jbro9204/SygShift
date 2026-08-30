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

### Hardware Security Key Pilot Validation

- Priority: High
- Target window: Jordan-only controlled production pilot
- Status: Deployed / awaiting physical-key enrollment and device validation
- Added: 08/29/2026

The full FIDO2/WebAuthn implementation, production database controls, administrator recovery tools, audit trail, security notices, feature flag, and `jbrown`-only allowlist are deployed. Complete the final human hardware ceremony and supported-device checks before considering any broader rollout.

Remaining pilot validation:

- Enroll Jordan Brown's physical key from **My Account > Security** after completing authenticator MFA.
- Verify successful key sign-in in current Chrome and Edge on `https://app.sygilant.us`.
- Verify cancellation and absent-key flows leave **Use authenticator instead** available.
- Verify key removal, administrator revocation, and MFA reset using the physical pilot credential.
- Keep the authenticator factor enrolled throughout the pilot and do not expand the allowlist until the pilot evidence is recorded.

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

- Priority: **Urgent**
- Target window: Staged enterprise program; approximately 24–28 controlled runs
- Status: Stage 1 completed 08/29/2026 / Stage 2 protected control plane completed 08/29/2026 / Stage 3 People & HR Workspace completed 08/29/2026 / Stage 4 Secure Document Platform completed across four controlled runs on 08/30/2026 / Stage 5 HR Automation & Action Center completed dormant on 08/30/2026; production identity backfill, document delivery, and workflow activation remain separately gated
- Added: 08/29/2026
- Source: Approved complete enterprise HRIS/HCM specification reviewed 08/29/2026

Build a complete, secure, permission-controlled HRIS/HCM suite inside **HR & Finance**. Deliver it as focused, production-ready modules built on SygShift's existing permanent employee identity—not as disconnected document screens, duplicate directories, mock enterprise pages, or unfinished shells.

Existing foundation: the dedicated Payroll workspace and HR & Finance navigation foundation were completed 08/28/2026. Preserve them during this program and integrate them only through the controlled stages below.

Program controls:

- [x] Treat security as the first stage and a release gate for every later stage.
- [ ] Preserve Schedule, Availability, Time & Attendance, Licensing, User Accounts, Roles & Permissions, and Payroll as the authoritative systems for their existing domains.
- [ ] Preserve the current Payroll workspace until Stage 10 reconciliation and controlled integration are complete.
- [ ] Keep every database change additive, reversible, backed up, and protected by tested rollback procedures.
- [ ] Complete each run end to end: functional UI, server authorization, persistence, audit history, tests, production validation, Git backup, and a dated changelog.
- [ ] Use compact queues, pagination, search, filters, saved views, and open-on-demand detail; never introduce uncontrolled long-scroll record lists.
- [ ] Use MM/DD/YYYY dates and civilian time with military time throughout applicable production workflows.

#### Stage 1 — Discovery and HR Security Foundation (completed 08/29/2026)

- [x] Inventory current schemas, routes, services, storage, permissions, background jobs, notifications, audits, tests, and production integrations.
- [x] Create an authoritative source-of-truth and data-boundary map for every employee and HR domain.
- [x] Classify HR data and define separately protected vaults for general HR, financial, identity, medical, disciplinary, and other restricted records.
- [x] Define deny-by-default module, row, field, action, and document authorization enforced by the server.
- [x] Define recent-MFA requirements, break-glass recovery, session controls, append-only audits, backup/restore, feature flags, maintenance controls, and rollback.
- [x] Validate the security foundation before any new protected HR records enter production.

Stage 1 closed the protected-data release gate by default and added a machine-validated control contract. The gate remains closed until each later stage supplies its required authorization tests, isolated backup/restore drill, document quarantine validation, production verification, and rollback evidence.

#### Stage 2 — Core HR Data Architecture (2–3 runs)

- [x] Establish the feature-off immutable person, worker, employment, and assignment identifier architecture without creating duplicate employee identities. (Run 1 completed 08/29/2026; protected employee mappings remain intentionally empty.)
- [x] Add the private effective-dated employment, manager, department, position, status, classification, and compensation data contract. (Run 1 completed 08/29/2026; no protected records have been backfilled.)
- [x] Install the disabled-by-default controlled-backfill plane with recent-MFA authorization, recovery-evidence requirements, a three-person canary limit, single-use expiring approvals, stale-snapshot rejection, service-only execution, preservation assertions, and append-only audit evidence. (Run 3 control plane completed 08/29/2026; no employee mappings were executed.)
- [x] Add a protected Employment Data Readiness workspace for authoritative hire/separation-date evidence without exposing backfill execution. (Readiness workspace completed 08/29/2026; production backfill gate remains closed.)
- [ ] Backfill existing active and historical employees with reconciliation reports and duplicate prevention.
- [ ] Preserve separated-employee, payroll, licensing, schedule, time, and audit history through migrations and rollback tests.

Run 1 installed the dormant private schema, deny-by-default permission definitions, no-delete/close-only history protections, and access-preservation assertions. Run 2 installed a deterministic, service-only reconciliation proposal and validated all 78 source employee records without creating HR identity rows. Run 3 installed the protected execution controls but intentionally performed no identity write. The protected Employment Data Readiness workspace now records authoritative date evidence without exposing any browser backfill action. Production reported zero identity blockers; all 78 records require hire-date review and nine separated records also require separation-date review before an effective-dated canary can be authorized. Current employee records, roles, permissions, overrides, payroll, licensing, schedule, timekeeping, and runtime behavior remain unchanged. The production backfill remains gated for authoritative date resolution, isolated recovery evidence, a controlled canary, authorization tests, and cross-module preservation verification.

#### Stage 3 — People & HR Workspace (completed 08/29/2026)

- [x] Build a compact HR overview and priority work queue.
- [x] Build a paginated People list with search, filters, saved views, and active employees by default.
- [x] Build the permission-controlled authoritative Employee File.
- [x] Preserve the existing permission-safe operational Directory as the single Directory editing workflow instead of creating a second employee editor.
- [x] Use connected summaries and permission-filtered deep links so each domain remains authoritative instead of duplicating data.

Stage 3 added the protected `/hr`, `/hr/people`, and `/hr/people/:employeeId` workspaces. The People list uses legal names, server-side search and filtering, bounded pagination, private saved views, and active employees by default. Restricted contact information requires the separate `hr.people.restricted` permission. The Employee File is read-only and links only to specialized workspaces the current user can actually access. Existing Directory, Schedule, Time & Attendance, Licensing, User Accounts, Roles & Permissions, and Payroll workflows remain authoritative and unchanged. No identity backfill, production role assignment, individual permission override, or employee record mutation was performed.

#### Stage 4 — Secure Document Platform (3–4 runs)

- [x] Implement the dormant private document-vault foundation with six separately protected vaults, deny-by-default permission definitions, private storage, a disabled release gate, and no production role or employee assignments. (Run 1 completed 08/30/2026; uploads and document delivery remain unavailable.)
- [x] Support file picker, drag-and-drop upload, progress, validation, and clear recovery states.
- [x] Validate file signatures, MIME types, extensions, size limits, and active content at the server upload boundary. (Run 2 completed 08/30/2026; the browser upload experience remains deferred.)
- [x] Add the dormant malware-scanning and quarantine release boundary required before a document can be previewed or downloaded. (Run 2 completed 08/30/2026; no scanner integration or production upload is enabled.)
- [x] Support authorized in-browser preview for safe file formats.
- [x] Support authorized downloads through short-lived, non-public access.
- [x] Install the dormant immutable document/version, append-only scan/access evidence, archive/restore metadata, retention-policy, legal-hold, and rollback foundation. (Run 1 completed 08/30/2026; operational backup/restore and access-minting drills remain release blockers for later runs.)
- [x] Add document requests, acknowledgments, signatures, access records, and append-only document audits. (Run 4 completed 08/30/2026; the workflow is deployed dormant and remains unavailable until a separate controlled activation.)

Run 1 created no employee document, version, uploaded object, role assignment, or individual permission override. All six storage buckets are private, have explicit file-size and MIME allowlists, and have no authenticated-client storage policy.

Run 4 added service-only document request and assignment workflows, exact immutable-version employee access, acknowledgment and signature evidence, and append-only lifecycle audits. Manager and employee workspaces are compact and independently authorized. The database release gate remains disabled, the Worker feature switch remains unconfigured, and no document permission or assignment was granted in production. Stage 4 is structurally complete but intentionally dormant; activation remains a separate controlled release requiring scanner configuration, recovery evidence, permission assignment, and canary validation.

Run 2 installed the dormant server pipeline for exact file-signature validation, quarantine-only storage, append-only scan evidence, recent authenticator or security-key verification, and permission-scoped one-time document access. Every access token is hashed, expires within 60 seconds, is single-use, and rechecks the current document version, clean scan state, active account, and effective vault permission when consumed. The browser upload/preview/download experience, scanner service activation, document permission assignments, operational recovery drill, and release-gate enablement remain deferred. Production still contains zero document records, versions, upload operations, access grants, and document permission assignments.

#### Stage 5 — HR Automation & Action Center (completed 08/30/2026)

- [x] Implement versioned workflows, approval paths, human tasks, reminders, escalations, and due dates.
- [x] Make delivery transactional and reliable with idempotency and concurrency protection.
- [x] Add retry, failure, dead-letter, pause, resume, cancel, and audited manual-override controls.
- [x] Connect approved HR work to the Action Center and notification system without flooding users.

Stage 5 installed a private, service-only workflow engine; immutable versions; human tasks; bounded, idempotent jobs; retry and dead-letter controls; scheduled work; notification-outbox handoff; and compact Action Center and administrative worklists. The database and Worker release gates are both disabled, the administrative route is absent from navigation, and no new permission is assigned to any current role or employee. Production contains no workflow definitions, jobs, or tasks. Activation is a separate controlled release requiring approved workflow content, minimum permission assignment, canary validation, reliability and recovery evidence, and both release controls.

#### Stage 6 — Recruiting & Onboarding (completed 08/30/2026)

- [x] Implement requisitions, applicants, candidate stages, interviews, scorecards, offers, and disposition history.
- [x] Convert an approved candidate into the permanent employee identity without re-entering or duplicating data.
- [x] Implement preboarding and onboarding templates, assigned tasks, dependencies, readiness, reminders, and escalation.
- [x] Integrate onboarding with User Accounts, Licensing, Training, equipment, documents, and site-access readiness.

Stage 6 is deployed dormant. Recruiting and onboarding have independent database and Worker release gates, all six permissions remain unassigned, and no candidate, employee, onboarding case, or task was created during deployment. Activation requires a separate controlled release with approved permissions, canary data, duplicate review, recovery evidence, and post-activation validation.

#### Stage 7 — Leave, Benefits & Compensation (completed 08/30/2026)

- [x] Implement time-off and protected-leave foundations using approved eligibility, accrual, and policy rules only.
- [x] Connect approved leave to Schedule, Time & Attendance, and Payroll only after authorized approval.
- [x] Implement benefits plans, eligibility, enrollment, elections, and effective-dated history foundations.
- [x] Implement effective-dated compensation history, approvals, recent-MFA requirements, and restricted access.
- [x] Never invent balances, policy entitlements, benefit promises, or compensation decisions.

Stage 7 is deployed dormant. Leave Administration, Benefits Administration, and Compensation have independent database and Worker release gates, all 11 permissions remain unassigned, and no policy, balance, entitlement, benefit plan, enrollment, compensation record, proposal, or approval was created during deployment. Operational time-off remains authoritative. Protected leave information is isolated behind separate permissions, downstream leave effects require explicit authorization, and compensation access requires recent MFA with database-enforced proposer/approver separation. Activation requires approved source data, named access owners, an isolated canary, recovery evidence, and post-activation validation.

#### Stage 8 — Talent, Learning, Cases, Safety & Assets (3–4 runs)

- [ ] Implement goals, reviews, performance history, development plans, and restricted visibility.
- [ ] Implement learning and training workflows connected to the existing Licensing Center where appropriate.
- [ ] Implement restricted HR case management with factual records, attachments, follow-ups, and audits.
- [ ] Implement safety and workers' compensation workflows with appropriate restricted-data boundaries.
- [ ] Implement equipment and asset issuance, acknowledgment, transfer, return, and offboarding reconciliation.

#### Stage 9 — Offboarding, Self-Service & Reporting (2–3 runs)

- [ ] Implement separation and rehire workflows with explicit human approvals and preserved history.
- [ ] Coordinate account access, Schedule, Payroll, Licensing, documents, training, and equipment during offboarding.
- [ ] Implement employee and manager self-service limited to effective permissions and approved records.
- [ ] Implement permission-aware reports, custom report building, scheduled reports, and asynchronous exports for large jobs.

#### Stage 10 — Payroll Integration & Enterprise Hardening (2–3 runs)

- [ ] Define and approve a versioned HR-to-Payroll integration contract.
- [ ] Keep Payroll authoritative and require controlled approval for every payroll-impacting HR change.
- [ ] Run parallel reconciliation and locked-snapshot comparisons before any cutover.
- [ ] Complete cross-module security, permission, audit, accessibility, mobile, performance, backup, and recovery tests.
- [ ] Perform controlled production integration with a tested rollback and final reconciliation.
- [ ] Preserve future Sygilant hub readiness through stable identifiers, versioned APIs/events, and webhooks without making this release dependent on that future application.

Completion standard:

- [ ] Do not mark the program or a stage complete because pages or buttons exist. The authorized workflow, secure storage, server enforcement, persistence, document lifecycle, audit history, automation behavior, tests, backup/recovery validation, production deployment, and rollback must all be verified.
- [ ] Keep adverse, sensitive, financial, employment-status, leave, discipline, compensation, and official payroll decisions under documented human approval; automation may prepare and route work but must not make those decisions silently.

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
