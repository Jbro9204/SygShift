# HRIS Stage 1 System Inventory

**Reviewed:** 08/29/2026

**Scope:** Existing SygShift production architecture before protected HRIS records are introduced

## Executive result

SygShift already has a mature workforce-operations foundation that the HRIS program must extend rather than duplicate. The repository contains 179 forward-only Supabase migrations, 91 row-level-security enablement statements, 107 policies, 568 database-function definitions, a centralized effective-permission model, private object storage, an authenticated Cloudflare Worker, append-only evidence patterns, scheduled automation, feature-scoped maintenance, and broad unit and browser coverage.

The Stage 1 release gate remains closed. No new protected HR records or HR document vaults may enter production until the controls declared in `config/hris-foundation-boundaries.json` have implementation evidence.

## Runtime and deployment

| Layer | Current implementation | HRIS boundary |
| --- | --- | --- |
| Browser | React 19, TypeScript, Vite, TanStack Query, Zod | Untrusted client. May render only records returned after server and database authorization. |
| Edge API | Cloudflare Worker with same-origin `/api/v1` routes, secure headers, readiness, account, notification, and attendance endpoints | Owns secret-backed integrations, validation, short-lived access, idempotency, rate limiting, and sanitized errors. |
| Database | Supabase PostgreSQL with public/private schemas, RPC services, RLS, triggers, and forward-only migrations | Final data-authorization boundary. HR tables must use deny-by-default RLS and controlled functions. |
| Identity | Supabase Auth linked through private employee-account records | User Accounts remains authoritative. HR modules use the permanent employee ID. |
| Storage | Private Supabase buckets for photos, credentials, source imports, and payroll exports | Existing buckets are not general HR vaults. Stage 4 must add separately permissioned HR vaults. |
| Hosting | Cloudflare Workers static assets and Worker runtime on `app.sygilant.us` | New HR features default off and use maintenance/release controls. |

## Existing data domains

### Identity and workforce

- `public.employees` is the permanent employee identity and legal-name record.
- Private account, contact, username, separation, deletion-retention, MFA, password-recovery, trusted-device, and security-key records protect the authentication lifecycle.
- Active access is calculated from role memberships, role permissions, and person-specific grants or denies.
- Separated records preserve operational, payroll, licensing, and audit history.

### Scheduling and workforce operations

- Sites, posts, events, schedules, shifts, assignments, requests, availability, overrides, and time-off requests already exist.
- Published schedules are versioned and historical records are protected from casual rewriting.
- Shift qualification, capacity, overlap, time off, and availability are enforced through controlled database functions.

### Time, attendance, and payroll

- Source time events are append-only.
- Time, type, location, Site/Post, workday, occurrence, payroll-week, and exception decisions are separate amendments or overrides with reasons and actors.
- Operational exception lifecycle, daily reconciliation, manual time entry, employee adjustment requests, call-offs, accountability, payroll review, locked export batches, and append-only export history already exist.
- The scheduled Worker runs timekeeping automation every minute and performs a full operational-alert reconciliation at 2:00 AM Mountain Time.

### Licensing, learning, and communications

- Credential types, requirements, employee credentials, documents, eligibility overrides, communications, and templates are already authoritative in Licensing Center.
- Training courses, versions, assignments, acknowledgments, and Action Center work exist.
- Announcement templates, banners, work items, recipient snapshots, retries, notification outbox, and delivery audit exist.

### Maintenance and release controls

- Feature-specific maintenance windows are off by default, automatically expire, preserve clock access unless selected, and require the protected maintenance permission plus MFA.
- The Worker exposes sanitized health/readiness results; detailed operations are restricted.
- Production release history, automatic recovery, save-aware update prompts, and rollback procedures are documented and tested.

## Storage inventory

| Bucket | Current purpose | Current maximum | HRIS decision |
| --- | --- | ---: | --- |
| `employee-photos` | Employee profile images | 10 MB | Retain for profile photos only. |
| `credential-documents` | Licensing evidence | 25 MB | Retain under Licensing Center authority. Do not store general HR files here. |
| `source-imports` | Controlled workbook/import evidence | 50 MB | Retain for source reconciliation only. |
| `payroll-exports` | Payroll exports | 25 MB | Retain under Payroll authority. |

Six future HR vaults are reserved in the foundation contract: general HR, financial, identity, medical, disciplinary, and legal/safety. They do not exist in production and must not be simulated by reusing an existing bucket.

## Authorization inventory

- Unknown routes and unrecognized permissions are denied.
- Navigation visibility follows effective permissions but never substitutes for authorization.
- The Worker protects service-role actions and does not expose server credentials.
- PostgreSQL helper functions enforce active employment, effective permissions, and MFA at mutation boundaries.
- The latest access-integrity migration verifies that authorization hardening does not alter existing role memberships, employee grants, or denies.
- Recent-MFA semantics for future HR writes must be stricter than a generic remembered-device session and are reserved by the Stage 1 contract.

## Audit and evidence inventory

- `private.audit_events` records actor, employee, request ID, schema, table, operation, row ID, and before/after records.
- Material services also write explicit business-action audit entries.
- Punches, corrections, source evidence, timekeeping decisions, access recovery, payroll snapshots, and key-security events use append-only history.
- Existing audit coverage is strong but HRIS modules must declare and test their own view, export, approval, download, and break-glass events.

## Background jobs and integrations

| Job/integration | Current behavior | HRIS constraint |
| --- | --- | --- |
| Timekeeping automation | Every-minute job run with a unique job ID | HR automation must use independent idempotent jobs and cannot interfere with clock processing. |
| Operational-alert lifecycle | Incremental every minute; full reconciliation at 2:00 AM Mountain | HR alerts use separate types and lifecycle policies. |
| Scheduled announcements | Publishes due work in bounded batches | HR notifications may connect only through approved, recipient-safe work items. |
| Notification delivery | Worker processes bounded delivery jobs and audits outcomes | HR delivery needs retry, dead-letter, and no-company-domain handling. |
| Cloudflare Email Service | Transactional email through protected binding | HR messages cannot disclose restricted record contents in email. |
| Supabase Storage | Private object storage with bucket policies | HR files require quarantine, scan status, versioning, retention, legal hold, and short-lived delivery. |

## Test and quality inventory

- Vitest covers access enforcement, Guard least privilege, account security, maintenance, timekeeping, payroll, schedule, licensing, communications, navigation, layouts, and session continuity.
- Playwright covers representative production workflows, accessibility, responsive layouts, and authenticated paths.
- `pnpm check` performs type checking, linting, unit tests, and a production build.
- Dedicated access-inventory and production-access-preservation tools protect current role assignments.
- Stage 1 adds a machine-validated HRIS boundary contract and guard test; later stages must add module-specific authorization and recovery evidence.

## Confirmed gaps and release gates

1. There is no authoritative effective-dated HR employment record yet.
2. There are no category-separated HR document vaults.
3. Malware scanning and quarantine are not yet implemented for HR documents.
4. The future HR permission catalog and server services do not yet exist.
5. Break-glass workflow records, second-person review, and recent-MFA enforcement for HR do not yet exist.
6. An HR-specific backup/restore drill has not been performed because no HR schema or protected HR data exists yet.
7. No HRIS module is permitted to turn on until its authorization, audit, recovery, and rollback evidence satisfies the release gate.

These are expected Stage 1 findings. They are explicit blockers, not missing work hidden behind an interface.
