# SygShift architecture

## Purpose

SygShift is a workforce-operations application for scheduling, qualifications, events, timekeeping, requests, announcements, and payroll preparation. The source workbook remains an immutable business record during migration. Imported records are accepted only after automated reconciliation reports zero unexplained differences.

## Runtime

- React and TypeScript provide the browser application.
- Cloudflare Workers serves the application and versioned API routes.
- Supabase provides PostgreSQL, authentication, object storage, and managed backups.
- Operational timestamps are stored in UTC. Site coverage keeps the Site/Post operating time zone, while an employee's personal schedule is displayed in the supported continental U.S. time zone reported by the browser or, when unavailable, the employee profile.
- The application is API-first so a future company hub can use the same authorization and business services without embedding this interface.

## Trust boundaries

### Browser

The browser may receive a Supabase publishable key. It must never receive a database password, secret key, service-role key, email-provider credential, encryption key, or payroll integration credential. Browser database requests are treated as untrusted and are constrained by PostgreSQL row-level security.

### Cloudflare Worker

The Worker owns same-origin API endpoints, request validation, server-authoritative timestamps, rate limiting, idempotency, and integrations that require secrets. API paths are versioned under `/api/v1`.

### PostgreSQL

PostgreSQL is the final authorization boundary. Roles are Guard, Supervisor, and Admin. Row-level security is enabled on every table exposed through the Data API. Sensitive site instructions, source cells, import evidence, and audit details live in a non-public schema.

## Modules

1. Identity and employee directory
2. Sites, posts, patrol, and dispatch coverage
3. Schedule and published schedule history
4. Events and qualified open-shift requests
5. Time off and call-off workflow
6. Timeclock, corrections, approval, locking, and payroll exports
7. Announcements and delivery history
8. Audit history and source reconciliation

## Continental U.S. schedule time zones

- SygShift supports `America/New_York`, `America/Chicago`, `America/Denver`, and `America/Los_Angeles` for employee schedule display and future employee-specific assignment entry.
- The employee profile holds the operational fallback time zone. A supported browser time zone controls personal display so an employee sees the local wall-clock time they are expected to follow.
- Server timestamps remain authoritative UTC instants. Browser time is used only to select the presentation zone; it never authorizes an early punch or supplies the recorded punch timestamp.
- A future one-person assigned shift is entered in the selected employee's profile time zone and stored as an absolute timestamp. Open coverage, multi-person coverage, and general Site/Post operations continue to use the Site/Post time zone.
- Existing shifts, punches, payroll assignments, and historical records are not rebased when an employee time zone is added or changed. A profile-zone correction changes presentation and future employee-specific entry only.
- Payroll batching remains governed by its separately versioned `America/Denver` boundary and is not changed by employee display zones.

## Identity and access control

- The employee directory is the source of truth for names, roles, employment type, status, contact details, and permanent usernames.
- Supabase Auth users are linked privately to employee records. The sign-in email is derived from the username and is never presented as a real employee email address.
- Authorized employees manage employee records and account state from the User Accounts console through effective permissions and MFA.
- `admin.users.invite` is the dedicated New User Invites permission for branded welcome and login-instruction email delivery. The Worker enforces it independently from account-security controls.
- Auth-user creation and password resets run through the Worker because they require the service-role key. That key is never available to browser code.
- Disabled accounts and separated employees are blocked at the database authorization boundary even if an Auth session exists.
- The workbook people import promotes only clear person records automatically; ambiguous source rows remain held for review.

## Change discipline

- Schema changes are forward-only migrations.
- Material state changes create audit records.
- Punches and source evidence are append-only.
- Published schedules are versioned; historical versions are not overwritten.
- Payroll exports identify their source entries and preserve a checksum.
- Every completed change is reviewed, checked, and committed to Git.

## Payroll export control

- Payroll is a dedicated workspace under the permission-aware **HR & Finance** navigation group. Time & Attendance remains responsible for punches, attendance, corrections, and operational exception work.
- The Payroll workspace uses focused Overview, Review Queue, Employee Payroll, Export & History, and administrator-only Rules destinations. The selected pay period is carried in the URL so it remains consistent across tabs and reloads.
- Overview pages show summaries and a maximum of five priority items. Full employee and review lists use search, filters, sorting, pagination, and open-on-demand detail instead of rendering all records at once.
- Supervisors preview CSV payroll rows first; the preview does not create the official record.
- A locked payroll export is created only through the database, after the server recalculates the review range.
- Payroll locking is blocked when any row has a missing punch, invalid punch order, unresolved correction, zero paid minutes, or other exception.
- A linked shift occurrence is assigned as one indivisible unit to the payroll week containing its scheduled start in `America/Denver`. A Saturday shift that ends Sunday remains in the Saturday week; early or late punches do not move it.
- Standalone manual entries use their manual clock-in, and legitimate unscheduled work uses its actual clock-in. Missing anchors remain unresolved and must be reviewed before export.
- Payroll-batch assignment and overtime allocation are separate policies. The batch rule never silently changes daily or weekly overtime calculations.
- Open occurrences may be recalculated under the active versioned policy. Locked export snapshots retain their original assignment, policy version, configuration version, time zone, and grouping rule.
- Authorized payroll-batch corrections require MFA, a Sunday week-start date, a written reason, and append-only history. They apply only to the selected unlocked occurrence.
- Locked batches are stored in private tables with row snapshots, totals, the exporting employee, an audit note, and a SHA-256 digest of the clean review rows.
- Locked batches and their rows are append-only. Duplicate locks for the exact same reviewed range and digest return the existing batch instead of creating clutter.
- Browser users cannot insert payroll export records directly; they can only request the controlled export function, which requires Supervisor or Admin role plus MFA.

## Request and notification lifecycle

- Guard requests are created through database functions that derive the employee from the authenticated account.
- Time-off approval is blocked while an active assignment overlaps the requested dates; approved time off blocks later assignment.
- A call-off queues a supervisor alert but does not claim delivery. A supervisor with MFA must review it and publish the replacement opening.
- Publishing a replacement opening cancels the original assignment, opens the shift, creates the announcement, and queues qualified delivery atomically.
- Notification records distinguish queued, attempted, delivered, and failed states. The interface must never describe a queued message as sent.
- Employee email routing is personal-first. Database queues exclude the temporarily blocked `@guardianshipsecurity.net` domain, and the Worker independently suppresses that domain before the provider is called.

## System status and release communication

- The application shell shows every signed-in user one compact service state: Online, Attention Needed, or Service Disruption.
- Detailed readiness and integration checks are restricted to the System Operations workspace and the `admin.maintenance.manage` permission.
- The Worker readiness endpoint returns sanitized booleans only. Secret values, private URLs, credentials, and request diagnostics are never rendered in the browser.
- Upcoming maintenance notices are dismissible. Active maintenance remains persistent until the protected window ends.
- Completed maintenance uses employee-safe language, automatically dismisses after 15 seconds, and stores dismissal per maintenance event so it does not reappear during navigation or a later session.
- Feature access continues to be enforced at the server and database boundaries; the service indicator is informational and never substitutes for authorization or health enforcement.
# HRIS Stage 8 protected workspaces

Talent, Learning, Employee Cases, Safety, and Assets are private HR domains with independent release gates. Their browser routes use the existing SygShift application shell, but protected data is read through authenticated Worker endpoints rather than direct browser access to private tables. Each endpoint requires its exact effective permission; Employee Cases and Safety additionally require recent MFA. Attachments remain in the Secure Document Platform, Licensing remains authoritative for credentials, and existing employee identities remain authoritative across every Stage 8 relationship. Compact worklists are bounded to 5, 10, or 20 records per page.
