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

### Enterprise Breach Protection Program

- Priority: **Urgent**
- Target window: Staged security-hardening program beginning with immediate credential containment
- Status: Approved / queued; no employee login-flow changes authorized
- Added: 08/31/2026

Build a defense-in-depth security program that materially reduces the likelihood and impact of account takeover, credential theft, unauthorized data access, malicious administration, and data exfiltration without requiring ordinary employees to purchase hardware keys, enroll in a new MFA method, or change their normal login routine. Preserve the current privileged-role MFA boundary and the optional Jordan-only hardware-key pilot.

#### Stage 1 — Immediate Credential Containment

- [ ] Rotate every Supabase access token, database password, service-role credential, provider credential, and other production secret that has ever been exposed outside an approved protected secret store.
- [ ] Update Cloudflare Worker secrets atomically, verify the replacement credentials, and revoke the former credentials immediately after the verified cutover.
- [ ] Scan Git history, release artifacts, Cloudflare configuration and logs, CI configuration, local environment files, and operational documentation for accidental secret exposure.
- [ ] Enable and verify GitHub secret scanning and push protection where the repository plan supports them.
- [ ] Maintain a protected credential inventory with the owner, purpose, storage location, last rotation date, and next required rotation date; never record the credential value.

#### Stage 2 — Cloudflare Edge and Perimeter Protection

- [ ] Enable reviewed Cloudflare managed WAF and OWASP protections without blocking legitimate SygShift traffic.
- [ ] Add targeted rate limits for login, password recovery, MFA, email delivery, exports, sensitive reads, and high-impact write operations.
- [ ] Add bot and credential-stuffing defenses, using managed or conditional Turnstile only for suspicious traffic so normal employees are not burdened.
- [ ] Verify TLS, HSTS, Content Security Policy, CORS, CSRF and origin protections, no-cache controls for sensitive responses, payload limits, and strict content-type validation.
- [ ] Apply stronger path-specific protections to administrative, financial, export, document, and account-security APIs.

#### Stage 3 — Identity, Session, and Account-Takeover Controls

- [ ] Harden session storage and cookies using secure, HttpOnly, SameSite, rotation, idle-timeout, and absolute-lifetime controls where the current architecture supports them.
- [ ] Revoke active sessions after password reset, MFA reset, protected-role downgrade, separation, account disablement, suspicious activity, and administrator-forced sign-out.
- [ ] Provide permission-controlled session and device inventory with clear revocation tools and append-only audit evidence.
- [ ] Detect meaningful risk signals such as unusual IP or ASN changes, impossible travel, repeated failures, new-device anomalies, and abnormal privileged activity without relying on fixed-IP restrictions for remote personnel.
- [ ] Keep the normal employee login flow unchanged; retain privileged-role MFA and optional FIDO2 security keys as stronger controls rather than universal employee requirements.

#### Stage 4 — Server, Database, and Authorization Hardening

- [ ] Complete a deny-by-default review of row-level security, grants, functions, views, storage policies, Worker endpoints, and object-level authorization for every active module.
- [ ] Keep all service credentials server-only and ensure no privileged secret or protected connection value can reach browser code, logs, screenshots, or downloadable artifacts.
- [ ] Enforce server-side schema validation, parameterized database operations, object ownership checks, and exact effective permissions on every protected read and write.
- [ ] Review all security-definer functions for fixed search paths, safe ownership, narrow execution grants, and audited privileged behavior.
- [ ] Maintain automated allow-and-deny tests for every role, protected Admin recovery, extra role membership, individual grant, individual denial, disabled account, and unauthenticated access.
- [ ] Require recent authentication for high-risk security, financial, bulk-export, restricted-document, and mass-account actions; apply export caps, rate limits, and complete audit trails.

#### Stage 5 — Data, Document, and Privacy Protection

- [ ] Classify SygShift data as Public, Internal, Confidential, or Restricted and apply handling, access, retention, backup, and audit requirements to each class.
- [ ] Keep Social Security numbers, banking data, tax data, and PHI out of ordinary employee profiles, free-text fields, logs, exports, and general SygShift storage; retain Payroll Vault and approved Microsoft storage as the authoritative homes unless a separately approved restricted vault is activated.
- [ ] Isolate salary and compensation access behind named HR and Finance authority instead of generic operational or administrative visibility.
- [ ] Keep document storage private with random object names, immutable version history, short-lived signed access, quarantine, file-signature and MIME validation, size limits, malware scanning, download auditing, and explicit legal-hold and retention controls.
- [ ] Add redaction and data-loss-prevention checks for logs, exports, notifications, support diagnostics, and user-entered notes.

#### Stage 6 — Detection, Monitoring, and Security Operations

- [ ] Centralize tamper-resistant security and audit events for authentication failures, impossible travel, disabled-account access, role and permission changes, MFA and FIDO actions, bulk reads, downloads, payroll exports, restricted-file access, authorization denials, WAF events, and privileged secret use.
- [ ] Define severity levels, alert destinations, responsible responders, acknowledgment targets, and response runbooks without exposing protected diagnostic details to ordinary users.
- [ ] Make the administrator System Operations workspace show a sanitized, actionable cause for service or security degradation while employees continue to see only the established green, yellow, or red service state.
- [ ] Establish searchable operational retention and longer-term protected archive retention based on an approved security and legal policy.

#### Stage 7 — Secure Development and Release Protection

- [ ] Protect the main branch with reviewed changes and required security validation before production release.
- [ ] Run secret scanning, static analysis, dependency and supply-chain scanning, lockfile-integrity checks, and software-bill-of-materials generation in the release pipeline.
- [ ] Require negative authorization, RLS, upload, export, session, recovery, and privileged-action tests for security-sensitive changes.
- [ ] Preserve canary deployment, maintenance communication, version-aware refresh, rollback, and audited migration procedures; never perform an untracked production write.
- [ ] Schedule quarterly access and architecture reviews and an independent penetration test before activating highly restricted HR, document, compensation, or payroll-vault capabilities.

#### Stage 8 — Incident Response, Recovery, and Governance

- [ ] Create and rehearse response runbooks for stolen credentials, account takeover, malicious administration, data exfiltration, exposed secrets, ransomware, compromised uploads, and database corruption.
- [ ] Provide tested emergency controls to revoke all sessions, disable an affected account or feature, rotate secrets, enter feature-specific read-only maintenance, and preserve forensic evidence.
- [ ] Define encrypted backup and point-in-time-recovery coverage, independent restore verification, quarterly recovery drills, and approved recovery-time and recovery-point objectives.
- [ ] Formalize joiner, mover, and leaver controls; quarterly access certification; vendor-security review; and administrator endpoint requirements including encryption, patching, antimalware, and prohibition of shared accounts.

Program completion criteria:

- [ ] Every exposed data object and protected operation has tested allow-and-deny authorization coverage.
- [ ] No production secret exists in Git, browser-delivered code, public logs, screenshots, or ordinary documentation.
- [ ] Every privileged change and restricted download is attributable and auditable.
- [ ] Revoked sessions and credentials are proven unusable within the approved response target.
- [ ] Backup restoration and incident-response exercises pass with recorded evidence.
- [ ] The implementation is reviewed against NIST Cybersecurity Framework 2.0, CISA Secure by Design principles, and an OWASP ASVS Level 2 target before the program is closed.

### Duo Authentication Feasibility and Controlled Pilot

- Priority: **High**
- Target window: Security architecture review after immediate credential-containment work; pilot only after compatibility approval
- Status: Approved for feasibility research / no production login change authorized
- Added: 08/31/2026

Evaluate whether Cisco Duo can be integrated safely with SygShift's current Supabase Auth, Cloudflare Worker, and PostgreSQL architecture. The database is not assumed to be the identity provider, and the review must prevent duplicate identities, split authorization decisions, weakened MFA, or a second uncontrolled account directory. Existing login, authenticator MFA, remembered-device, recovery, and FIDO2 behavior must remain unchanged until a documented design and controlled pilot are approved.

Required feasibility work:

- [ ] Confirm the currently supported Duo integration method for the SygShift architecture, including Duo Universal Prompt and any supported OIDC, SAML, or identity-gateway option.
- [ ] Confirm whether Supabase Auth can remain the authoritative user and session system or whether a safe server-side Cloudflare integration is required; do not create parallel employee identities.
- [ ] Map the complete login lifecycle for ordinary employees, protected roles, first-time setup, password reset, remembered devices, MFA recovery, role promotion and demotion, separation, login disablement, administrator recovery, and the Jordan-only FIDO2 pilot.
- [ ] Define the exact relationship between Duo verification, Supabase assurance levels, existing authenticator MFA, recent-authentication requirements, remembered-device policy, and FIDO2 so no path can downgrade another security control.
- [ ] Evaluate the available Duo methods and licensing before promising functionality, including push, passcodes, hardware tokens, supported recovery methods, trusted-device policy, and any optional device-posture controls.
- [ ] Require server-side validation, protected secrets, signed state and nonce checks, anti-replay protection, exact production redirect origins, secure session binding, revocation, rate limiting, and complete authentication audit evidence.
- [ ] Review the employee identifiers, phone or device information, authentication metadata, retention, privacy obligations, vendor terms, administrative access, and breach-notification responsibilities associated with Duo.
- [ ] Document licensing cost, per-user or per-feature limits, administrator workload, enrollment support, recovery operations, vendor outage behavior, and the effect on employees using mobile and desktop devices.
- [ ] Design a clear fallback and emergency-access path that does not lock out the company, bypass required controls, or depend on an unrecorded manual database change.
- [ ] Build any prototype only in an isolated or feature-gated environment and restrict the first production pilot to an explicitly approved account, preferably Jordan Brown, before considering broader use.
- [ ] Test successful and denied authentication, cancellation, timeout, offline and vendor-outage behavior, replay attempts, account disablement, role downgrade, session revocation, recovery, fallback, and rollback.
- [ ] Deliver a written **Adopt**, **Defer**, or **Reject** recommendation covering the final architecture, cost, affected roles, employee experience, security impact, migration plan, support plan, and rollback procedure.

Completion criteria:

- [ ] The integration has a reviewed identity and session architecture with one authoritative SygShift employee identity per person.
- [ ] Existing Supabase authorization, permissions, privileged-role MFA, FIDO2, account recovery, and audit controls are proven not to be weakened.
- [ ] Cost, privacy, support, outage, fallback, and rollback implications are accepted before any production enrollment.
- [ ] A limited pilot passes the approved security and usability test matrix before any wider rollout is considered.

## HR, Finance & Employee Lifecycle

### SygShift HR & Finance Suite

- Priority: **Urgent**
- Target window: Staged enterprise program; approximately 24–28 controlled runs
- Status: Stages 1–9 and the dormant Stage 10 payroll-integration control plane completed through 08/30/2026. The controlled Onboarding release completed 08/31/2026; Recruiting, identity backfill, document delivery, the remaining protected modules, and any external payroll cutover remain separately gated.
- Added: 08/29/2026
- Source: Approved complete enterprise HRIS/HCM specification reviewed 08/29/2026

Build a complete, secure, permission-controlled HRIS/HCM suite inside **HR & Finance**. Deliver it as focused, production-ready modules built on SygShift's existing permanent employee identity—not as disconnected document screens, duplicate directories, mock enterprise pages, or unfinished shells.

Existing foundation: the dedicated Payroll workspace and HR & Finance navigation foundation were completed 08/28/2026. Preserve them during this program and integrate them only through the controlled stages below.

Program controls:

- [x] Treat security as the first stage and a release gate for every later stage.
- [x] Preserve Schedule, Availability, Time & Attendance, Licensing, User Accounts, Roles & Permissions, and Payroll as the authoritative systems for their existing domains.
- [x] Preserve the current Payroll workspace while Stage 10 reconciliation and controlled-integration controls are established.
- [ ] Keep every database change additive, reversible, backed up, and protected by tested rollback procedures.
- [ ] Complete each run end to end: functional UI, server authorization, persistence, audit history, tests, production validation, Git backup, and a dated changelog.
- [x] Use compact queues, pagination, search, filters, saved views, and open-on-demand detail; never introduce uncontrolled long-scroll record lists.
- [x] Use MM/DD/YYYY dates and civilian time with military time throughout applicable production workflows.

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
- [x] Enforce the production release sequence: one-to-three-person canary, automatic gate closure, independent evidence-backed canary verification, and a separate recent-MFA authorization before full rollout. (Release hardening completed 08/30/2026; no employee mappings were executed.)
- [ ] Backfill existing active and historical employees with reconciliation reports and duplicate prevention.
- [ ] Preserve separated-employee, payroll, licensing, schedule, time, and audit history through migrations and rollback tests.

Run 1 installed the dormant private schema, deny-by-default permission definitions, no-delete/close-only history protections, and access-preservation assertions. Run 2 installed a deterministic, service-only reconciliation proposal and validated all 78 source employee records without creating HR identity rows. Run 3 installed the protected execution controls but intentionally performed no identity write. Release hardening now prevents a full authorization until a real one-to-three-person canary has completed, the gate has closed automatically, and independent service verification has confirmed deterministic mappings and an unchanged preservation snapshot against current recovery evidence. The protected Employment Data Readiness workspace records authoritative date evidence without exposing any browser backfill action. Production still has zero HR identity mappings: all 78 records require authoritative hire dates, nine separated records also require authoritative separation dates, and current isolated recovery evidence is not yet present. Current employee records, roles, permissions, overrides, payroll, licensing, schedule, timekeeping, and runtime behavior remain unchanged. The production backfill remains gated for authoritative date resolution, isolated recovery evidence, the controlled canary, independent verification, a new full authorization, and cross-module preservation verification.

#### Stage 3 — People & HR Workspace (completed 08/29/2026)

- [x] Build a compact HR overview and priority work queue.
- [x] Build a paginated People list with search, filters, saved views, and active employees by default.
- [x] Build the permission-controlled authoritative Employee File.
- [x] Preserve the existing permission-safe operational Directory as the single Directory editing workflow instead of creating a second employee editor.
- [x] Use connected summaries and permission-filtered deep links so each domain remains authoritative instead of duplicating data.

Stage 3 added the protected `/hr`, `/hr/people`, and `/hr/people/:employeeId` workspaces. The People list uses legal names, server-side search and filtering, bounded pagination, private saved views, and active employees by default. The Employee File now owns audited legal-identity, job title, Hourly/Salary, Full Time/Part Time/Flex, contact, address, emergency-contact, employment-date, and separately protected pay-rate maintenance. Restricted contact information still requires `hr.people.restricted`; pay amounts require exact compensation permission, recent MFA, and independent proposal approval. Directory, Schedule, Time & Attendance, Licensing, User Accounts, Roles & Permissions, and specialized HR modules remain authoritative for their own records so information is not duplicated.

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

The controlled Onboarding release completed 08/31/2026. Onboarding now supports dynamic federal, state, employment-classification, job-family, guard, and armed requirements; evidence-gated checklist completion; a separate approval before activation; permanent employee and User Account linkage without duplicate data entry; and separate company-welcome and login-instruction emails. The release preserved every existing employee, account, role, role membership, and individual permission override. It created no candidate, employee, onboarding case, or task during deployment. Recruiting remains dormant behind its independent release gate and its permissions remain unassigned.

#### Stage 7 — Leave, Benefits & Compensation (completed 08/30/2026)

- [x] Implement time-off and protected-leave foundations using approved eligibility, accrual, and policy rules only.
- [x] Connect approved leave to Schedule, Time & Attendance, and Payroll only after authorized approval.
- [x] Implement benefits plans, eligibility, enrollment, elections, and effective-dated history foundations.
- [x] Implement effective-dated compensation history, approvals, recent-MFA requirements, and restricted access.
- [x] Never invent balances, policy entitlements, benefit promises, or compensation decisions.

Stage 7's Leave Administration and Benefits Administration foundations remain dormant behind independent database and Worker gates. The protected Compensation pay-rate workflow was released on 09/01/2026 for compensation-authorized system administrators only. Viewing pay requires exact permission and recent MFA; adding or changing a rate creates a proposal that must be approved by a different compensation-authorized administrator. The release created no employee pay record or proposal, inferred no amount, and granted no compensation access to Human Resources or Operations roles. Operational time-off remains authoritative, and future Leave or Benefits activation still requires approved source data, named owners, an isolated canary, recovery evidence, and post-activation validation.

#### Stage 8 — Talent, Learning, Cases, Safety & Assets (completed 08/30/2026)

- [x] Implement goals, reviews, performance history, development plans, and restricted visibility.
- [x] Implement learning and training workflows connected to the existing Licensing Center where appropriate.
- [x] Implement restricted HR case management with factual records, attachments, follow-ups, and audits.
- [x] Implement safety and workers' compensation workflows with appropriate restricted-data boundaries.
- [x] Implement equipment and asset issuance, acknowledgment, transfer, return, and offboarding reconciliation.

Stage 8 is deployed dormant. Talent, Learning, Employee Cases, Safety, and Assets have independent database and Worker release gates, all 15 permissions remain unassigned, and no goal, review, course assignment, HR case, safety case, workers' compensation record, asset, assignment, acknowledgment, or financial review was created during deployment. Employee Cases and Safety require recent MFA in addition to exact permissions. The compact workspaces use bounded 5/10/20 worklists and connect to the existing document, Licensing Center, onboarding, and offboarding authorities without duplicating those records. Activation requires approved operating policies, named access owners, permission assignment, recovery evidence, an isolated canary, and post-activation validation.

#### Stage 9 — Offboarding, Self-Service & Reporting (completed 08/30/2026)

- [x] Implement separation and rehire workflows with explicit human approvals and preserved history.
- [x] Coordinate account access, Schedule, Payroll, Licensing, documents, training, and equipment during offboarding.
- [x] Implement employee and manager self-service limited to effective permissions and approved records.
- [x] Implement permission-aware reports, custom report building, scheduled reports, and asynchronous exports for large jobs.

Stage 9 is deployed dormant. Offboarding & Rehire, HR Self-Service, and HR Reporting have independent database and Worker release gates, all nine permissions remain unassigned, and no lifecycle case, self-service request, report definition, scheduled report, export run, or downstream handoff was created during deployment. Separation and rehire decisions require explicit approval and preserve history; downstream account, Schedule, Payroll, Licensing, document, training, and asset work is coordinated through auditable tasks instead of silently mutating authoritative systems. Self-service is scoped to the signed-in employee or effective manager permissions. Reporting is permission-aware and supports bounded asynchronous run records without exposing unrestricted employee data. Offboarding and Reporting require recent MFA. Activation requires approved operating policies, named access owners, permission assignment, recovery evidence, an isolated canary, and post-activation validation.

#### Stage 10 — Payroll Integration & Enterprise Hardening (control plane completed 08/30/2026; external cutover gated)

- [x] Define a versioned HR-to-Payroll integration contract and independent approval path. The installed contract remains a draft until authorized business approval.
- [x] Keep SygShift Payroll authoritative and require controlled approval for every payroll-impacting HR change.
- [x] Install parallel-reconciliation and locked-snapshot comparison controls that must pass before any cutover. No external-target reconciliation has been run because no target has been approved.
- [x] Install cross-module verification, immutable audit, release-gate, rollback-plan, and recovery-evidence controls. Target-specific accessibility, mobile, performance, backup, and recovery evidence remains a cutover prerequisite.
- [ ] Perform a controlled external payroll integration with an approved target, isolated canary, tested rollback, and final reconciliation.
- [x] Preserve future Sygilant hub readiness through stable identifiers, versioned contracts/events, and disabled HTTPS-only webhooks without making this release dependent on that future application.

Stage 10's dormant production control plane is complete. SygShift Payroll remains the sole payroll authority. Integration, webhooks, and enterprise cutover each have independent database and Worker gates and all remain disabled. Six exact permissions were added without assignment to any current role or employee. Payroll-impacting proposals require a documented reason, recent MFA, and independent maker-checker approval; reconciliation is anchored to immutable locked payroll export batches and rows. Versioned event envelopes, secret-binding-only webhook definitions, rollback plans, rollback executions, and enterprise verification runs are present but cannot publish, call a destination, or start cutover while the release gates are closed. No proposal, approval, reconciliation run, webhook subscription, rollback execution, external handoff, payroll-row mutation, or user-access change was created during deployment. External integration remains intentionally pending until a target, owners, contract approval, recovery evidence, canary, and final reconciliation are authorized.

#### Cross-stage Admin access baseline (completed 08/30/2026)

- [x] Establish the protected Admin role as the complete administrative baseline for every active permission in the catalog.
- [x] Preserve all non-Admin roles, employee identities, role memberships, and individual permission overrides while applying the baseline.
- [x] Keep every dormant HRIS release gate closed so complete Admin authorization does not activate unreleased modules.
- [x] Protect the baseline from partial removal and independently verify the production access matrix after deployment.

Production verification confirmed Admin at 135 of 135 active permissions, with 69 permissions added to the role and both active Admin accounts inheriting the result. Every non-Admin access assignment remained unchanged. Future permission-catalog additions continue to require a reviewed activation step rather than receiving an automatic background grant.

Completion standard:

- [ ] Do not mark the program or a stage complete because pages or buttons exist. The authorized workflow, secure storage, server enforcement, persistence, document lifecycle, audit history, automation behavior, tests, backup/recovery validation, production deployment, and rollback must all be verified.
- [ ] Keep adverse, sensitive, financial, employment-status, leave, discipline, compensation, and official payroll decisions under documented human approval; automation may prepare and route work but must not make those decisions silently.

## Workforce Organization & Scheduling

### Patrol Workflow and Operations System

- Priority: **Urgent**
- Target window: Begin 09/01/2026
- Status: Approved for workflow review and staged implementation planning; no production change made
- Added: 08/31/2026

Review and build the Patrol workflow as a complete operational system rather than a collection of disconnected schedule labels or imported spreadsheet rows.

Required outcomes:

- Confirm the real Patrol operating workflow, responsible roles, sites, routes, posts, recurring requirements, exceptions, and completion evidence before changing production behavior.
- Preserve Schedule, Time & Attendance, Sites & Posts, employee qualifications, payroll, and audit history as the authoritative connected systems.
- Make Patrol assignments, changes, completion, and review easy to understand on desktop and mobile without long-scroll lists or duplicate records.
- Enforce permissions and qualification rules on the server while preserving documented authorized overrides.
- Deliver the work in reversible stages with production validation, rollback evidence, Git backup, and dated changelogs.

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

## Employee Experience & Accountability

### Mandatory Post-Login Required Actions Checkpoint

- Priority: **High**
- Target window: Next focused employee-accountability release
- Status: Approved / queued; discussion complete, no implementation started
- Added: 09/01/2026

Create one non-bypassable **Required Actions Checkpoint** after password and required identity verification. When an employee has a current item that requires confirmation, acknowledgment, attestation, signature, or another recorded response, the checkpoint must guide the employee through every required item before opening the ordinary SygShift workspace.

Required workflow:

- [ ] Trigger the checkpoint from authoritative pending-action records rather than hard-coded pages, banners, or duplicated client state.
- [ ] Include newly published schedules, material schedule revisions, required announcements and policies, mandatory training and safety instructions, site/post orders, required HR documents, onboarding requirements, equipment or uniform receipts, timecard attestations, licensing responses, and other explicitly approved required actions.
- [ ] Present multiple requirements as one ordered queue with clear progress such as **Action 1 of 3**, prioritizing same-day schedule changes and critical safety items.
- [ ] Do not allow closing, skipping, refreshing, signing out and back in, or opening a direct route to bypass outstanding required actions.
- [ ] Preserve immediate access to clock in/out, report a call-off, and reach emergency information so the checkpoint cannot make an employee late or obstruct a safety workflow. After the urgent action is handled, return the employee to the required queue before opening the rest of SygShift.
- [ ] Use action-specific wording and buttons. Distinguish confirmation, acknowledgment of receipt, employee attestation, acceptance, decline, dispute, and legally binding signature instead of treating them as interchangeable.
- [ ] For write-ups or corrective actions, make **Acknowledge receipt** explicitly mean receipt rather than agreement and provide a recorded employee-response or decline path.
- [ ] Keep legal electronic signatures in a separately validated signature workflow; an acknowledgment button must never be represented as a signature.
- [ ] Preserve entered progress across safe refresh/retry behavior and prevent duplicate completion through server-side idempotency and current-version checks.
- [ ] Automatically remove superseded schedule, announcement, policy, training, or document versions and present only the current authoritative requirement.
- [ ] Record the employee, exact content or schedule version, assigned/viewed/completed timestamps, response wording, action taken, resolution source, and session evidence in the existing audit-safe Action Center history.
- [ ] Provide compact permission-scoped manager reporting for pending, completed, overdue, declined, disputed, and unreachable employees without creating long-scroll lists.
- [ ] Support desktop and mobile layouts, keyboard navigation, screen readers, browser zoom, light/dark modes, time-zone-correct schedule details, and clear recovery from network interruption.
- [ ] Enforce the checkpoint and completion rules on the server as well as the client so navigation changes or direct API calls cannot bypass the requirement.

Completion criteria:

- [ ] A newly assigned required action reliably appears after the employee's next successful login or session restoration.
- [ ] The employee cannot enter ordinary SygShift routes until all current required actions are resolved, while clock, call-off, and emergency access remain available.
- [ ] Completing, declining, disputing, superseding, or expiring an item updates the active queue exactly once and creates a permanent, readable Action Center History record.
- [ ] Authorized managers can identify outstanding and overdue requirements within their permitted scope without gaining access to unrelated employee or HR records.
- [ ] Allow, deny, bypass, refresh, retry, multiple-action, superseded-version, time-zone, accessibility, and rollback tests pass before production activation.

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
