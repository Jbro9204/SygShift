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

#### Execution instructions

1. Begin with a read-only inventory of current secrets, identity paths, permissions, storage, logs, edge controls, backups, and response ownership; do not rotate or disable anything during discovery.
2. Complete stages in order. Before each production stage, document the owner, affected systems, exact change, employee impact, canary group, monitoring, rollback command or procedure, and acceptance evidence.
3. Make security changes through reviewed repository migrations/configuration and protected secret stores. Never paste production credentials into chat, Git, screenshots, logs, changelogs, or the Future list.
4. Test both allowed and denied behavior, normal employee login continuity, privileged access, revocation, recovery, and rollback before expanding a canary.
5. Close the program only after the completion criteria below have recorded evidence and an independent security review; remove the item only after the dated changelog and DEVLOG are updated.

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

- Priority: **Low**
- Target window: Security architecture review after immediate credential-containment work; pilot only after compatibility approval
- Status: Approved for feasibility research / no production login change authorized
- Added: 08/31/2026

#### Execution instructions

1. Assign a technical owner and obtain current Duo product, licensing, privacy, and integration documentation before designing a production path.
2. Map the existing Supabase/Auth, Worker, MFA, FIDO, recovery, session, and role lifecycle first; the proposal must name one authoritative identity and show where Duo participates without duplicating it.
3. Produce a written architecture, threat review, cost/support assessment, outage behavior, fallback, and rollback plan before writing integration code.
4. If approved, build behind an independent feature gate and test only with an explicitly named canary account; do not change the ordinary employee login flow during feasibility work.
5. End with an Adopt, Defer, or Reject decision and retain the evidence even if Duo is not adopted.

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
- Status: Core in-system HR Suite operational release completed 09/03/2026. Recruiting, Onboarding, Leave, Benefits, Compensation, Talent, Learning, Employee Cases, Safety, Assets, Offboarding, Self-Service, Reporting, employee files, and Document Studio are available through their exact permission boundaries. Historical identity backfill, HR automation, advanced document capabilities, and any external payroll cutover remain separately gated.
- Added: 08/29/2026
- Source: Approved complete enterprise HRIS/HCM specification reviewed 08/29/2026

#### Execution instructions

1. Treat the stage checklist as the required order of work and start each remaining stage by confirming its business owner, authoritative source, data classification, permissions, and release gate.
2. Reuse the permanent employee identity and authoritative Schedule, Time, Payroll, Licensing, User Accounts, and Document systems; never create a parallel employee file or silently copy records.
3. Use additive forward migrations, exact server authorization, recent MFA where specified, bounded interfaces, immutable audits, isolated canaries, and documented rollback/recovery evidence.
4. Do not populate, infer, or activate protected HR data from placeholders. Backfills and external integrations require reconciled source files and explicit approval.
5. A stage may be marked complete only when its authorized end-to-end workflow—not merely its schema or page—passes persistence, permission, accessibility, recovery, and production verification.

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
- [x] Add and activate the malware-scanning and quarantine release boundary required before a document can be previewed or downloaded. (Foundation completed 08/30/2026; Cloudflare Queue + isolated ClamAV container release completed 09/02/2026.)
- [x] Support authorized in-browser preview for safe file formats.
- [x] Support authorized downloads through short-lived, non-public access.
- [x] Install the dormant immutable document/version, append-only scan/access evidence, archive/restore metadata, retention-policy, legal-hold, and rollback foundation. (Run 1 completed 08/30/2026; operational backup/restore and access-minting drills remain release blockers for later runs.)
- [x] Add document requests, acknowledgments, signatures, access records, and append-only document audits. (Run 4 completed 08/30/2026; the workflow is deployed dormant and remains unavailable until a separate controlled activation.)

Run 1 created no employee document, version, uploaded object, role assignment, or individual permission override. All six storage buckets are private, have explicit file-size and MIME allowlists, and have no authenticated-client storage policy.

Run 4 added service-only document request and assignment workflows, exact immutable-version employee access, acknowledgment and signature evidence, and append-only lifecycle audits. Manager and employee workspaces are compact and independently authorized. That run was intentionally dormant; the core workspace was subsequently released on 09/02/2026 after scanner and recovery evidence passed.

The unified Document Studio and electronic-signature control plane was completed on 09/02/2026. The production core now includes versioned policies and templates, normalized fields, canonical record associations, signer routing, consent and authentication evidence, saved signature appearances, immutable signed renditions, audit certificates, private uploads, asynchronous malware scanning, browser preview, download, and bounded management/employee workspaces. OCR, true native PDF content editing, irreversible redaction, page restructuring, regulated-document automation, external signers, and organizational seals remain separate future capabilities and stay fail-closed until their own technical, legal, and recovery controls exist.

The Guardianship HR Template Library v1.0 searchable index was completed on 09/02/2026. All 56 controlled GS-HR forms are cataloged once inside the HR-restricted Document Studio with plain-language search, category and audience filtering, expandable purpose/handling details, and bounded 5/10/20 pagination. Employees use the separate **My Documents** workspace only for forms and completed records assigned directly to them. The protected pipeline is available for controlled canonical source ingestion; individual source files remain **Indexed** until HR uploads and links each approved version.

Run 2 installed the original fail-closed server boundary for exact file-signature validation, quarantine storage, append-only scan evidence, recent authenticator or security-key verification, and permission-scoped one-time document access. Every access token remains hashed, expires within 60 seconds, is single-use, and rechecks the current clean version, active account, and effective vault permission when consumed. The 09/02/2026 controlled activation added the missing scanner queue/container, recovery canary, company/shared record support, safe Office preview, and production release evidence without broadening vault permissions.

#### Stage 5 — HR Automation & Action Center (completed 08/30/2026)

- [x] Implement versioned workflows, approval paths, human tasks, reminders, escalations, and due dates.
- [x] Make delivery transactional and reliable with idempotency and concurrency protection.
- [x] Add retry, failure, dead-letter, pause, resume, cancel, and audited manual-override controls.
- [x] Connect approved HR work to the Action Center and notification system without flooding users.

Stage 5 installed a private, service-only workflow engine; immutable versions; human tasks; bounded, idempotent jobs; retry and dead-letter controls; scheduled work; notification-outbox handoff; and compact Action Center and administrative worklists. Its general-purpose automation gate remains disabled because approved workflow content and a dedicated operational canary have not yet been supplied. The operational HR modules released on 09/03/2026 use direct, audited service actions and do not silently activate the general automation engine.

#### Stage 6 — Recruiting & Onboarding (completed 08/30/2026)

- [x] Implement requisitions, applicants, candidate stages, interviews, scorecards, offers, and disposition history.
- [x] Convert an approved candidate into the permanent employee identity without re-entering or duplicating data.
- [x] Implement preboarding and onboarding templates, assigned tasks, dependencies, readiness, reminders, and escalation.
- [x] Integrate onboarding with User Accounts, Licensing, Training, equipment, documents, and site-access readiness.

The controlled Onboarding release completed 08/31/2026. Recruiting joined it in the operational HR Suite release on 09/03/2026 with protected requisition, applicant, stage, interview, offer, disposition, and candidate-conversion foundations plus audited management actions. The release also repaired latent onboarding template-version and pre-hire email query ambiguities and the candidate-conversion applicant lookup. No candidate, employee, onboarding case, task, or access assignment was created during deployment.

#### Stage 7 — Leave, Benefits & Compensation (completed 08/30/2026)

- [x] Implement time-off and protected-leave foundations using approved eligibility, accrual, and policy rules only.
- [x] Connect approved leave to Schedule, Time & Attendance, and Payroll only after authorized approval.
- [x] Implement benefits plans, eligibility, enrollment, elections, and effective-dated history foundations.
- [x] Implement effective-dated compensation history, approvals, recent-MFA requirements, and restricted access.
- [x] Never invent balances, policy entitlements, benefit promises, or compensation decisions.

Leave Administration and Benefits Administration joined Compensation in the operational HR Suite release on 09/03/2026. Authorized HR staff can open and independently decide leave cases and create and independently activate benefit plans through the audited service boundary. Operational time-off remains authoritative; no leave entitlement, balance, benefit promise, enrollment, pay record, or access grant was inferred or created. Compensation retains its separate recent-MFA and maker-checker controls.

#### Stage 8 — Talent, Learning, Cases, Safety & Assets (completed 08/30/2026)

- [x] Implement goals, reviews, performance history, development plans, and restricted visibility.
- [x] Implement learning and training workflows connected to the existing Licensing Center where appropriate.
- [x] Implement restricted HR case management with factual records, attachments, follow-ups, and audits.
- [x] Implement safety and workers' compensation workflows with appropriate restricted-data boundaries.
- [x] Implement equipment and asset issuance, acknowledgment, transfer, return, and offboarding reconciliation.

Talent, Learning, Employee Cases, Safety, and Assets became operational on 09/03/2026 through one centralized, service-only action boundary. Their compact workspaces now provide permission-appropriate create and management actions while retaining bounded 5/10/20 worklists and their existing connections to Document Studio, Licensing, Onboarding, and Offboarding. Employee Cases and Safety continue to require recent MFA. Activation created no business record and changed no employee or access assignment.

#### Stage 9 — Offboarding, Self-Service & Reporting (completed 08/30/2026)

- [x] Implement separation and rehire workflows with explicit human approvals and preserved history.
- [x] Coordinate account access, Schedule, Payroll, Licensing, documents, training, and equipment during offboarding.
- [x] Implement employee and manager self-service limited to effective permissions and approved records.
- [x] Implement permission-aware reports, custom report building, scheduled reports, and asynchronous exports for large jobs.

Offboarding & Rehire, HR Self-Service, and HR Reporting became operational on 09/03/2026 through exact permissions and audited actions. Separation and rehire decisions retain independent approval and preserved history; self-service remains scoped to the signed-in employee or effective manager authority; and governed report definitions remain permission filtered. Offboarding and Reporting continue to require recent MFA. The release created no lifecycle case, request, report, schedule, payroll, licensing, document, training, asset, or access mutation.

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

### HR Operational Release and Document Studio Expansion

- Priority: **High**
- Target window: Controlled HR releases after owners, policies, and release evidence are approved
- Status: Core employee files, compensation, onboarding, Document Studio, and signatures are operational; remaining HR modules and advanced document capabilities are queued or gated
- Added: 09/02/2026

#### Execution instructions

1. HR must first identify the approved source documents, operating policies, record owners, required recipients, retention rules, and which workflows require acknowledgment, approval, or legal signature.
2. Release one bounded workflow at a time. Configure its exact role permissions, recent-authentication rule, document handling, escalation path, canary users, and rollback before enabling it.
3. Upload only approved source versions, preserve immutable originals, and link each resulting record to the canonical employee, client, site, or company record instead of creating duplicate files.
4. Keep OCR, editing, redaction, external signing, regulated automation, and seals disabled until the named processor, legal terms, security review, recovery drill, and end-to-end tests are complete.
5. Have an authorized HR user perform the real workflow in production after deployment and record the result before calling the capability operational.

Finish the remaining HR operating workflows without replacing the permanent employee record, duplicating documents, weakening the current HR access boundary, or presenting dormant back-end foundations as released functionality.

Required work:

- [ ] Upload, verify, approve, and link each source file represented in the indexed Guardianship HR Template Library so **Indexed** entries become controlled, usable document versions.
- [ ] Convert approved operational material into governed checklists, fillable forms, site rules, guided prompts, and required reporting workflows with named owners and version history.
- [ ] Release the corrective-action workflow from authorized supervisors to HR, including factual records, evidence, follow-up, receipt acknowledgment that does not imply agreement, employee response, restricted visibility, and audit history.
- [ ] Activate the remaining protected HR modules only after each module has approved operating policy, permission ownership, recent-MFA rules, canary validation, recovery evidence, and production verification.
- [ ] Review the protected-document reauthentication window so continuously active authorized HR work is usable while inactivity, session expiration, and especially sensitive actions still require strong reauthentication.
- [ ] Keep compensation rate changes under the existing restricted maker-checker control and obtain the required second qualified approver before activation or amendment.
- [ ] Preserve employment classification separately from pay basis: full-time, part-time, Flex, temporary, or another approved classification must not be conflated with hourly, salary, or another approved compensation basis.
- [ ] Add OCR, native PDF form/content editing, irreversible redaction, page restructuring, regulated-document automation, external signers, and organizational seals only as separately reviewed capabilities with immutable originals, exact permissions, audit evidence, recovery controls, and legal approval.
- [ ] Keep Social Security numbers, banking information, tax records, and PHI outside the general HR workspace and follow the approved Payroll Vault and Microsoft storage boundary unless a separate restricted-vault release is authorized.

Completion criteria:

- [ ] Every released HR workflow has complete UI, persistence, server authorization, audit, document behavior, allow-and-deny tests, recovery evidence, and production validation.
- [ ] Authorized HR employees can complete their work without gaining compensation, security-administration, payroll-vault, or unrelated employee access.
- [ ] Advanced document features remain visibly unavailable—not simulated—until their independent release gates pass.

### Organizational Hierarchy and Permission Governance

- Priority: **High**
- Target window: After Michelle and Jordan approve the official hierarchy; before additional broad role assignments
- Status: Management decision and permission review required; current roles remain authoritative until approved changes are released
- Added: 09/02/2026

#### Execution instructions

1. Hold a decision session with Michelle and Jordan to approve the organization chart, role names, reporting relationships, and which responsibilities belong to a role versus a specific person.
2. Build the written matrix by permission category and action—view, create, edit, approve, assign, export/download, deactivate, and administer—before changing production assignments.
3. Compare the approved matrix with current primary roles, additive roles, individual grants, and denials; flag Michael and every other exceptional account for explicit review rather than using it as a template.
4. Apply changes additively with before/after access snapshots, protected Admin safeguards, allow-and-deny tests, a small canary, and immediate rollback capability.
5. Obtain sign-off on the effective-access report, then update role documentation and employee assignments separately so a role-design change never silently reclassifies an employee.

Formalize the company hierarchy and replace informal or person-specific access assumptions with a written, tested permissions matrix.

Required work:

- [ ] Confirm the official hierarchy and rank names with Michelle and Jordan, including Owner/Chief, Operations Manager, Lieutenant if retained, Supervisor, Human Resources Manager, Human Resources Employee, Scheduler, Dispatcher, Recruiting & Licensing, Guard, and Patrol Officer.
- [ ] Create the approved **Chief/Owner** role for Michelle with business-wide operational authority while excluding unnecessary technical system-administration powers.
- [ ] Define for every role what it may view, create, approve, edit, download/export, assign, deactivate, and administer.
- [ ] Review and reduce Scheduler permissions so future schedulers do not automatically inherit Michael's exceptional individual access.
- [ ] Separate supervisory accountability authority from scheduling authority and keep confidential HR records, corrective actions, compensation, and protected documents limited to named authorized roles.
- [ ] Reconcile primary role, additional access roles, and individual additions or denials so each mechanism has a clear purpose and the effective-access view never appears duplicated or contradictory.
- [ ] Validate Admin safety protections, Human Resources versus Human Resources Manager boundaries, Operations Manager scope, role promotion/demotion, and access removal with allow-and-deny tests.

Completion criteria:

- [ ] The approved hierarchy and permissions matrix are written, versioned, and understandable without inspecting code or individual accounts.
- [ ] No broad role receives protected access merely because one current employee has an exceptional assignment.
- [ ] Production effective access matches the approved matrix and preserves explicitly reviewed individual exceptions.

## Workforce Data Integrity & Attendance

### Workforce Record Reconciliation and Attendance Refresh

- Priority: **High**
- Target window: Focused workforce data-quality and attendance reliability release
- Status: Partially complete; the dedicated live clock roster is complete, while data reconciliation and schedule-change refresh remain open
- Added: 09/02/2026

#### Execution instructions

1. Management must name the headcount-audit owner and approve the exact definitions of Active, onboarding, floating/Flex, placeholder, test, separated, and inactive records.
2. Generate a read-only reconciliation report first. Review every proposed deactivation or reclassification with the owner; never bulk-delete employee, account, schedule, time, payroll, or audit history.
3. Repair attendance refresh against the current published schedule using idempotent server-side reconciliation, with the original alert retained as auditable evidence when it is resolved or superseded.
4. Test assignment removal, reassignment, schedule correction, revision publication, overnight shifts, salary exclusions, and concurrent supplemental Dispatch duty before release.
5. Compare Directory, HR, User Accounts, scheduling, and reporting totals after the canary and obtain the owner's approval before closing the reconciliation.

Produce one reliable active-workforce population and ensure schedule corrections immediately flow into attendance signals without deleting valid history.

Required work:

- [ ] Assign the final management owner of the active-employee headcount audit.
- [ ] Identify and deactivate or formally classify test accounts, placeholder records, separated employees, abandoned partial onboarding records, and non-active floating records; do not hard-delete audit or payroll history.
- [ ] Define one authoritative active-employee count and document which statuses and classifications are included or excluded.
- [ ] Make attendance alerts re-evaluate the current published schedule after assignments, removals, corrections, and revision publication.
- [ ] Recalculate or close stale attendance alerts when the authoritative schedule no longer supports them, while preserving an audit trail of the original signal and its resolution.
- [x] Route **On Duty Now** and **Clocked In** to the dedicated, automatically refreshed roster of employees with open clock sessions. Completed 09/02/2026.

Completion criteria:

- [ ] Directory, HR, User Accounts, scheduling, and reporting agree on the active population under the approved definition.
- [ ] A schedule correction cannot leave an unsupported missing-clock or attendance alert active.
- [ ] No cleanup changes valid employee, time, payroll, licensing, or audit history.

## Client, Patrol & Operational Migration

### Client Data Import, Association, and Visibility Hardening

- Priority: **High**
- Target window: Before broad Patrol rollout and before any Client Portal activation
- Status: Enterprise Client Files foundation complete; authoritative source import and operational association cleanup remain open
- Added: 09/02/2026

#### Execution instructions

1. Obtain authoritative TrackTik and sales exports, identify the source owner and extraction date, and preserve the untouched originals in protected storage.
2. Stage and normalize source rows without creating clients automatically. Match by stable identifiers and verified business facts, then route duplicates, conflicts, former clients, and incomplete addresses for human review.
3. Promote a small approved canary first and verify contacts, sites, posts, service types, statuses, documents, activity, and permissions before processing the remaining accepted rows.
4. Clean addresses and confirm site ownership before geocoding or geofencing. Do not infer an address, client relationship, coordinate, or service type from route names alone.
5. Run association and negative-access reports after import so every operational record resolves to the intended client/site and no employee can see unrelated locations or records.

Populate the Client Files system with verified source data and make the client record the controlled relationship point for sites, services, operational records, documents, and future portal publication.

Required work:

- [ ] Import and reconcile the complete TrackTik client/site list and applicable sales records without duplicating the client records already created from the initial sales workbook.
- [ ] Verify legal client name, property/site name, physical and billing addresses, primary and operational contacts, phones, emails, client status, and service types for every imported record.
- [ ] Distinguish Active, Inactive, Former, Prospect, and Occasional/Event-only clients and support Static, Patrol, Event Security, Executive Protection, and Mixed services.
- [ ] Support static and patrol services under one client while keeping each Site/Post, shift, patrol hit, report, image, video, invoice, contract, proposal, post order, and document tied to the correct canonical client relationship.
- [ ] Clean and validate Site/Post addresses before activating geofencing; never infer coordinates from incomplete or ambiguous source data.
- [ ] Correct unrelated route/site associations and restrict site visibility by assignment, operational need, and effective permission instead of exposing every site to every patrol employee.
- [ ] Support an authorized employee serving as a static officer, patrol officer, or both without duplicating the employee or client record.

Completion criteria:

- [ ] Import reconciliation accounts for every accepted, rejected, merged, and unresolved source row.
- [ ] All client-linked operational records resolve to the correct client and site without duplicate storage.
- [ ] Negative-permission tests prove employees and future clients cannot access unrelated sites, records, documents, or media.

### Patrol Field Pilot, Media Validation, and Route Completion

- Priority: **High**
- Target window: Controlled field pilot before Patrol is treated as fully production-ready
- Status: Patrol workflow and reporting foundation complete; real route data, field acceptance, and sustained media validation remain open
- Added: 09/02/2026

#### Execution instructions

1. Management must enter and verify real route addresses, hit counts, evidence requirements, instructions, and any optional time windows; keep the route in draft until reviewed.
2. Create a bounded field-test route for Joseph with representative required hits, an extra hit, notes, a photo, a normal video, and a longer incident-style video.
3. Test the complete guard workflow on the phones and network conditions actually used in the field, including upload interruption, retry, preview, completion, and correction.
4. Test the management workflow separately: edit/version a route, assign it through Schedule, monitor progress, review evidence, correct exceptions, and export internal and client-ready reports.
5. Record Joseph's feedback and the media/permission results, resolve or explicitly accept each finding, and obtain operational sign-off before broad activation.

Finish the operational rollout of Patrol with real addresses, route ownership, field feedback, and evidence that mobile reporting and larger media behave reliably under actual guard conditions.

Required work:

- [ ] Add and verify the remaining route addresses, site instructions, and editable hit requirements using the permanent Patrol management workflow.
- [ ] Keep optional hit time windows available for later management use without inventing times for routes that are currently count-based.
- [ ] Let management select whether a hit requires a photo, video, both, or neither, while guards retain optional notes and permitted supplemental media.
- [ ] Send Joseph the end-of-shift report and Patrol workflow for field testing and record feedback on mobile usability, clarity, missing information, reporting sufficiency, and photo/video behavior.
- [ ] Personally complete the management and guard workflows before broad release, including adding an extra hit, changing an existing route, building a route, saving addresses, completing hits, and exporting reports.
- [ ] Prove that at least three-to-ten-minute incident videos and supported photographs can be uploaded, stored, scanned, viewed, downloaded, retained, and associated with the correct client, site, employee, route, shift, and patrol activity.
- [ ] Verify media authorization prevents unrelated employees, managers outside scope, and future client users from viewing or downloading records they do not own.
- [ ] Confirm static and Patrol reporting can coexist under one client without duplicating records or crossing access boundaries.

Completion criteria:

- [ ] Joseph's field findings are resolved or explicitly accepted by the named operational owner.
- [ ] Mobile, offline/retry, media, report/export, permission, audit, recovery, and rollback tests pass using production-equivalent data sizes.
- [ ] Patrol is not labeled fully production-ready until the field pilot and media evidence are recorded.

### TrackTik Replacement and Controlled Migration

- Priority: **High**
- Target window: After feature and data inventories; before TrackTik retirement
- Status: Research inputs and management decisions required
- Added: 09/02/2026

#### Execution instructions

1. Obtain Zach's complete TrackTik notes and current exports, then create a feature/data inventory with an owner and disposition for every entry.
2. Classify each capability as Replicate, Improve, Replace, or Exclude and document the operational reason, dependency, security boundary, and acceptance test.
3. Build the migration map from TrackTik identifiers to canonical SygShift/Sygilant client, site, employee, route, report, document, and media identifiers before importing data.
4. Rehearse migration and rollback with non-production copies, reconcile row/file counts and checksums, then operate an approved parallel-use window with named support coverage.
5. Retire TrackTik only after management signs the acceptance report and confirms the replacement, historical access, exports, media, dispatch decision, recovery, and contingency plan.

Create a documented replacement and migration program before discontinuing TrackTik.

Required work:

- [ ] Obtain and review Zach's TrackTik research notes and classify each function as Replicate, Improve, Replace with another workflow, or Intentionally exclude.
- [ ] Inventory migration requirements for clients, sites, addresses, contacts, post orders, routes, reports, media, and applicable employee/licensing records.
- [ ] Decide whether the existing dispatch log is retained, replaced, or retired and identify its final management owner during transition.
- [ ] Define source cleanup, identity matching, duplicate prevention, transformation, reconciliation, exception handling, audit, and rollback procedures.
- [ ] Establish acceptance criteria and a controlled parallel-use period where required so operational coverage is never dependent on an unverified replacement.
- [ ] Do not discontinue TrackTik until the replacement workflows, migrated data, reports, media, permissions, and recovery plan are tested and formally accepted.

## Platform Strategy & Business Systems

### Sygilant Convergence and Shared Identity

- Priority: **Strategic / High**
- Target window: Side-by-side integration first; Sygilant-hosted consolidation only after independent readiness and rollback approval
- Status: Approved direction; no change to SygShift's current production login or authorization boundary is authorized yet
- Added: 09/02/2026

#### Execution instructions

1. Inventory both platforms' identity, session, MFA/FIDO, recovery, user, role, permission, audit, URL, and deployment models before selecting the shared-identity design.
2. Approve one authoritative identity provider and a versioned mapping contract; never export or copy password hashes, MFA seeds, FIDO secrets, recovery codes, or session tokens.
3. Implement and validate Sygilant independently first, using its own server authorization even when authentication is shared. Create test identities and an isolated canary before linking a real employee.
4. Run side by side with feature flags, monitoring, revocation propagation, outage/fallback behavior, and reversible routing while direct SygShift login remains available.
5. Remove direct SygShift login only after management approves the consolidation acceptance report and verified entry, deep-link, logout, recovery, authorization, audit, support, and rollback behavior.

Allow SygShift and Sygilant to operate side by side with one secure employee identity and familiar login experience, then later make SygShift an authenticated Sygilant module without copying password material, weakening MFA, or coupling the platforms before Sygilant is ready.

Required work:

- [ ] Define one authoritative identity provider and stable person/account identifiers; never synchronize password hashes, recovery secrets, authenticator seeds, FIDO credentials, or remembered-device tokens between independent stores.
- [ ] Reuse SygShift's proven authentication, account-recovery, MFA/FIDO, session, audit, and security patterns in Sygilant through a reviewed shared-identity architecture rather than a visual imitation or duplicate account directory.
- [ ] Keep authentication shared but authorization independent: platform, role, permission, client, site, record, and publication checks must remain server-enforced within each application's boundary.
- [ ] Introduce the integration side by side with feature flags, versioned contracts/events, isolated canaries, session-revocation behavior, monitoring, rollback, and no required change to the current SygShift production login.
- [ ] Give Sygilant the same repository discipline for Future Items, dated changelogs, DEVLOG updates, production verification, backups, and removal of completed queue items.
- [ ] When Sygilant is ready, launch SygShift only from an authenticated Sygilant workspace and retire direct SygShift login only after account mapping, deep links, MFA, recovery, logout, outage, and rollback tests pass.
- [ ] Preserve stable URLs or controlled redirects, audit attribution, least privilege, and emergency access during the final consolidation.

Completion criteria:

- [ ] The same authorized person can use both platforms through one approved identity lifecycle without maintaining two passwords or creating duplicate employee records.
- [ ] Compromise or excessive authority in one platform does not silently grant access to the other.
- [ ] Direct SygShift login is not removed until Sygilant provides verified replacement entry, recovery, support, monitoring, and rollback paths.

### SigSales Platform and Controlled Client Handoff

- Priority: **Later expansion**
- Target window: After Jordan and Zach approve the sales workflow and the Sygilant client contract is stable
- Status: Product definition required
- Added: 09/02/2026

#### Execution instructions

1. Jordan and Zach must approve the users, stages, required fields, calculations, documents, approvals, reporting, and handoff rules before implementation begins.
2. Model one canonical prospect-to-client lifecycle with stable identifiers, explicit stage transitions, ownership, duplicate detection, versioned proposals/contracts, and audit history.
3. Define the boundary with Sygilant so an accepted sale creates or links one client relationship through a reviewed handoff rather than copying the entire record set.
4. Prototype with non-production data, test calculation and document outputs against known examples, and require human approval before sending, signing, or activating anything externally.
5. Release by canary with permission, confidentiality, failure/retry, rollback, export, and reconciliation evidence.

Build SigSales as the controlled sales, lead, bid/proposal, and contract-management platform and hand accepted business into the canonical Sygilant client relationship without duplicate client records.

Required work:

- [ ] Finalize the SigSales layout and workflow with Jordan and Zach.
- [ ] Define the governed lifecycle from Prospect through Outreach, Opportunity, Proposal/Bid, Contract review, Signature, Client onboarding, and Active service.
- [ ] Connect completed sales and contract records to the correct Sygilant client account using stable identifiers and reviewed handoff states.
- [ ] Automate calculations, document preparation, and distribution only where review, approval, version, signature, and publication controls remain intact.
- [ ] Define permissions, confidentiality, audit, retention, rejection, duplicate prevention, failure recovery, and rollback before production data is introduced.

### Product Name and Trademark Review

- Priority: **Business decision / Research**
- Target window: Before additional public-brand investment or registration decisions
- Status: Requires Jordan and Zach review plus qualified legal guidance where appropriate
- Added: 09/02/2026

#### Execution instructions

1. List the exact names, logos, goods/services, markets, jurisdictions, owners, domains, and current first-use evidence to be reviewed.
2. Search relevant federal, state, common-law, domain, business-name, and marketplace sources and record dated results for identical and confusingly similar marks.
3. Have qualified trademark counsel evaluate material conflicts and filing classes before relying on internal research or making a registration claim.
4. Record the Adopt, Modify, Hold, or Retire decision for each name, along with filing owner, deadlines, specimens, and maintenance responsibilities.
5. Keep domain control, corporate-name registration, and trademark rights documented as separate assets and decisions.

Research potential conflicts and registration strategy for **SygShift**, **Sygilant**, and **SigSales** while treating domain ownership and trademark rights as separate matters.

Required work:

- [ ] Perform documented clearance research for the proposed names, relevant classes, jurisdictions, confusingly similar marks, and current use.
- [ ] Decide which names remain approved for use and which should proceed to formal registration review.
- [ ] Record findings, owners, deadlines, and counsel recommendations without representing internal research as legal clearance.

## Workforce Organization & Scheduling

### Employee-Local Shift Time Presentation

- Priority: **High**
- Target window: Next focused Schedule and Time & Attendance refinement
- Status: Approved / queued for discussion and verification; no implementation started
- Added: 09/03/2026

#### Execution instructions

1. Confirm each employee's saved IANA time zone and each Site/Post operational time zone before changing presentation logic; browser detection is advisory only.
2. Map every employee-facing and manager-facing schedule/time surface and define which zone is shown, which label accompanies it, and which authoritative instant governs clock eligibility.
3. Implement conversion in one centralized time utility without rewriting stored shifts, punches, workdays, payroll ownership, or historical audit timestamps.
4. Canary with employees in Eastern, Central, Mountain, and Pacific zones and test daylight-saving changes, overnight work, early clock-in, notifications, corrections, and active sessions.
5. Release only after Zach's existing shift remains unchanged as an absolute instant and affected employees confirm they see and can follow the intended local schedule.

Keep trusted server time and UTC timestamps authoritative for clock eligibility, audit evidence, schedule storage, payroll ownership, and security decisions while presenting each employee's shifts in the employee's actual local time zone.

Required workflow:

- [ ] Use the employee's saved IANA time zone as the authoritative presentation zone for that employee's schedule, Home, My Time, clock controls, reminders, required-action prompts, and employee-facing notifications.
- [ ] Read the browser or operating-system time zone to detect a likely mismatch, but never trust a manually incorrect device clock or silently rewrite the employee profile, schedule, punch, or payroll record from browser time alone.
- [ ] When the device zone and saved employee zone differ, display a clear non-blocking explanation and provide an authorized correction path instead of showing the shift in Mountain Time or guessing which zone is correct.
- [ ] Show a concise zone abbreviation or local-time label beside shift times whenever ambiguity is possible. Management views must make the employee-local zone and the operational Site/Post zone understandable without duplicating the shift.
- [ ] Compare server timestamps as absolute instants for early clock-in and late-clock rules so an 8:00 AM Central shift opens at the same real moment for the employee regardless of the system's Mountain operational default.
- [ ] Preserve the existing Mountain operational payroll policy and historical timestamps; this refinement must not rewrite published shifts, punches, active clock sessions, payroll assignments, or audit history.
- [ ] Handle Eastern, Central, Mountain, and Pacific zones plus daylight-saving transitions using IANA zones rather than fixed EST/CST/MST/PST offsets.
- [ ] Verify schedule display, early clock-in, clock-in/out, overnight shifts, notifications, required actions, manager views, and payroll attribution across all four supported zones and around daylight-saving boundaries.

Completion criteria:

- [ ] An employee scheduled for 8:00 AM in their saved local zone consistently sees 8:00 AM and becomes eligible to clock in at the correct server-confirmed instant.
- [ ] A device-zone mismatch cannot silently move a shift, permit an early punch, block an on-time punch, or alter payroll ownership.
- [ ] Authorized managers can identify which time zone they are viewing without requiring employees to be scheduled in Mountain Time.
- [ ] Existing schedule, timekeeping, payroll, notification, and audit records remain unchanged through release and rollback verification.

## Employee Experience & Accountability

### Mandatory Post-Login Required Actions Checkpoint

- Priority: **High**
- Target window: Next focused employee-accountability release
- Status: Approved / queued; discussion complete, no implementation started
- Added: 09/01/2026

#### Execution instructions

1. Inventory every current confirmation, acknowledgment, attestation, signature, training, schedule, policy, and document requirement and identify its authoritative record/version and owner.
2. Define the trigger, priority, due date, permitted responses, emergency bypass, supersession rule, and audit evidence for each action type before adding it to the checkpoint.
3. Build one server-authoritative queue and release action types incrementally; do not create separate blocking modals or client-only completion flags for individual modules.
4. Test mandatory behavior without blocking clock, call-off, or emergency access, and verify refresh, direct routes, multiple devices, stale versions, retry, and sign-out cannot create a bypass or duplicate completion.
5. Canary with a small employee/manager group and close only after employees can complete actions clearly and managers can verify immutable history without seeing unrelated protected records.

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

### Client Portal Activation

- Priority: **Later expansion**
- Target window: After Client File classification, ownership, and sharing policy are operationally validated
- Status: Foundation ready; portal login, invitation, and publication remain intentionally disabled
- Added: 09/02/2026

#### Execution instructions

1. Approve the client identity, organization membership, invitation, recovery, MFA, support, terms, retention, and offboarding policies before enabling any portal account.
2. Classify every potentially publishable record and create an explicit internal approval state; internal, draft, rejected, superseded, confidential, and unapproved material must default to non-publishable.
3. Build tenant-scoped server authorization and storage access from canonical client/site relationships, then prove denial for cross-client IDs, guessed URLs, exports, downloads, and stale memberships.
4. Begin with one named client canary containing approved sample reports/documents/media and validate notification, accessibility, mobile, audit, withdrawal, replacement, and support behavior.
5. Expand only after internal owners and the client confirm the acceptance checklist; preserve an immediate portal-disable control that does not delete published history or audit evidence.

Build the future client-facing portal on the stable Client File identifiers and explicit publication states introduced by the Enterprise Client Files release.

Required outcomes:

- [ ] Define client user identities, organization membership, invitation, recovery, MFA, session, and offboarding policy without reusing employee authority.
- [ ] Require named internal approval before any report, Patrol record, document, image, video, schedule summary, or service record becomes client-visible.
- [ ] Publish only the approved version and preserve later withdrawal, replacement, delivery, view, and download history.
- [ ] Prevent internal notes, pricing, employee information, security-sensitive location details, draft records, and unrelated client data from crossing the portal boundary.
- [ ] Add client-scoped reports, notification preferences, retention, terms, support, accessibility, mobile, rate-limit, abuse, and recovery controls.
- [ ] Complete tenant-isolation, object-authorization, negative-permission, export, download, audit, canary, rollback, and breach-containment testing before activation.

The current release provides portal-ready states only. It does not create client accounts, send client invitations, or publish content.

### Indeed Employer Integration and Recruiting Depot

- Priority: Research
- Target window: Later expansion
- Status: Pinned for later
- Added: Before 08/25/2026

#### Execution instructions

1. Assign a recruiting owner and document the current applicant-to-employee workflow, required data, retention, consent, communications, licensing handoff, and failure points.
2. Confirm current Indeed Employer API availability, authorization model, commercial terms, rate limits, permitted data use, and webhook/export capabilities from official sources.
3. Compare direct API, approved CSV intake, controlled email parsing, and manual entry against security, reliability, cost, support, and duplicate-prevention requirements.
4. Prototype only after selecting an approach, using non-production applicants and a versioned mapping into the dormant Recruiting foundation and permanent employee conversion path.
5. Release only with legal/privacy approval, exact permissions, source attribution, reconciliation, audit, retry, deletion/retention handling, canary evidence, and rollback.

Research whether Indeed Employer can connect to SygShift/Sygilant and support a dedicated Recruiting Depot for applicants, recruiting stages, licensing progress, and onboarding handoff.

Required outcomes:

- Confirm available Indeed Employer APIs, permissions, costs, and data-use limitations before committing to an integration.
- Define the recruiting record lifecycle and its handoff into the employee, licensing, and user-account workflows.
- Evaluate secure email parsing, controlled CSV intake, or manual intake if a direct integration is not viable.
- Keep the recruiting expansion separate from current production-critical scheduling and payroll work.

## Completed Work

Completed initiatives do not remain in this active queue. Their implementation history is retained in `docs/changelogs/` and `DEVLOG.md`.
