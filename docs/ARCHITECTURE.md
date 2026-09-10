# SygShift architecture

## Purpose

SygShift is a workforce-operations application for client relationships, scheduling, qualifications, events, timekeeping, requests, announcements, and payroll preparation. Source workbooks remain immutable business records during migration. Ambiguous source rows remain staged for deliberate review rather than becoming operational records automatically.

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
9. Client Files, private client documents, and connected service reporting

## Enterprise Client Files

- `public.clients` is the stable client/account root. Contacts, service lifecycle, billing channels, renewal dates, and internal relationship notes belong to that record.
- Sites and Posts remain authoritative in their existing modules. A Client File links to those records by identifier; it does not copy locations or posts.
- Linked Site relationships automatically flow to new Patrol stops, Patrol hits, and Events. Schedule shifts are assembled through their existing Post/Site or Event relationship.
- Client activity combines authoritative Schedule, Patrol, and client service records at read/export time. It does not duplicate source operational rows.
- Proposals, contracts, amendments, pricing, post orders, correspondence, reports, and evidence use a private `client-documents` bucket with permission-checked Worker upload and access routes.
- Source spreadsheets are staged in the private schema with source tab, row, checksum, and original field values. An authorized reviewer must match, promote, or exclude every row.
- Internal and future client-visible state remain separate. `internal_only`, `eligible_to_share`, `awaiting_approval`, `published_to_client`, and `withdrawn` prepare a later Client Portal without publishing anything in this release.
- Every list is bounded by a 5, 10, or 20-row page or a deliberate View All disclosure. Browser routes are `/clients` and `/clients/:clientId`.

## Continental U.S. schedule time zones

- SygShift supports `America/New_York`, `America/Chicago`, `America/Denver`, and `America/Los_Angeles` for employee schedule display and future employee-specific assignment entry.
- The employee profile holds the operational fallback time zone. A supported browser time zone controls personal display so an employee sees the local wall-clock time they are expected to follow.
- Server timestamps remain authoritative UTC instants. Browser time is used only to select the presentation zone; it never authorizes an early punch or supplies the recorded punch timestamp.
- A future one-person assigned shift is entered in the selected employee's profile time zone and stored as an absolute timestamp. Open coverage, multi-person coverage, and general Site/Post operations continue to use the Site/Post time zone.
- Existing shifts, punches, payroll assignments, and historical records are not rebased when an employee time zone is added or changed. A profile-zone correction changes presentation and future employee-specific entry only.
- Payroll batching remains governed by its separately versioned `America/Denver` boundary and is not changed by employee display zones.

## Global operational time header

- The authenticated application uses one shared `AppShell` header across every permission-controlled workspace. The shell owns one compact integrated date, four-zone, and account bar plus maintenance notices and the existing rotating alert lane.
- Eastern, Central, Mountain, and Pacific clocks are derived from one synchronized instant and explicit IANA zones. The display timer is anchored to the existing maintenance-status server timestamp and refreshed through that existing query; it does not make a network request every second.
- Clock formatters are cached, daylight/standard abbreviations come from `Intl.DateTimeFormat`, and every zone computes its own calendar date for its accessible label. Mountain remains visibly identified as **SygShift system time**.
- Header clocks are informational. Server timestamps and protected database functions remain authoritative for punches, payroll, patrol hits, audit events, and all other secured records.
- The existing workspace alert component remains the only global alert lane. It retains its permission filtering, rotation, count, severity, and workflow links while flowing beneath the clocks with responsive wrapping.
- Wide desktop uses one 72-pixel integrated bar. At 1280 effective pixels and below, and on common 1366-by-768 laptop viewports, the fixed 276-pixel navigation rail becomes the existing full off-canvas drawer so every module receives the full content width; the employee's saved desktop collapse preference is retained and restored when the viewport widens. Constrained desktop keeps all four clocks on a compact second row, while ordinary tablet and mobile workspaces use a two-by-two grid without hiding a zone. On compact SygSphere laptops the alert lane becomes a concise single row. On the phone-width SygSphere route, the same four clocks use one readable horizontal strip with Pacific and Mountain system time first; the remaining zones stay reachable by a direct horizontal swipe so messaging and its composer retain the usable viewport.

## Identity and access control

- The employee directory is the source of truth for names, roles, employment type, status, contact details, and permanent usernames.
- Supabase Auth users are linked privately to employee records. The sign-in email is derived from the username and is never presented as a real employee email address.
- Authorized employees manage employee records and account state from the User Accounts console through effective permissions and MFA.
- `admin.users.invite` is the dedicated New User Invites permission for branded welcome and login-instruction email delivery. The Worker enforces it independently from account-security controls.
- Auth-user creation and password resets run through the Worker because they require the service-role key. That key is never available to browser code.
- Disabled accounts and separated employees are blocked at the database authorization boundary even if an Auth session exists.
- The workbook people import promotes only clear person records automatically; ambiguous source rows remain held for review.
- The protected Employee File is the authoritative index for one permanent employee identity. Start/hire and separation/termination dates are maintained directly in its Employment section by MFA-verified users with `hr.people.manage`.
- Employment-date changes update `public.employees` and append a superseding record to the existing HR effective-date evidence chain in the same transaction. Source reference, reason, actor, prior value, replacement value, and time remain auditable.
- Employment-date correction never rewrites schedules, punches, time cards, payroll rows, licenses, accounts, or other historical records. Future separation planning remains owned by Offboarding; other employee details remain owned by their connected specialized workspace.

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

## Login password recovery

- Signed-out employees request password recovery with their SygShift username. The Worker, not the browser, resolves that username to the internal authentication alias and the approved personal delivery address.
- The recovery boundary returns one generic accepted response for eligible, unknown, disabled, incomplete, and rate-limited accounts. Only an eligible active account receives a single-use Supabase recovery link.
- Recovery claims are rate-limited transactionally by one-way username and request-source hashes. The private claim ledger is forced-RLS, append-only, audited, and inaccessible to browser roles.
- Sygilant may submit the same public recovery workflow through a timestamped HMAC-signed bridge request. SygShift verifies the nonce, 90-second freshness window, signature, and one-way forwarded source fingerprint before using it for rate limiting. The shared secret is never transmitted, and SygShift still owns every identity, eligibility, email, token, and audit decision.
- Administrator-assisted recovery remains a separate MFA- and permission-protected workflow. Both workflows return through the existing Account Security password-recovery page and do not change MFA or security-key state.

## Automatic timekeeping compatibility

- Dispatch locations support explicit primary paid shifts (`standard`) and concurrent phone-duty blocks (`dispatch_phone_duty`). Primary Dispatch uses normal clock-in, auto-close, overtime, and payroll. Concurrent duty cannot start a duplicate paid session.
- Historical Dispatch-linked sessions created before that classification may receive exactly one system clock-out when an earlier valid clock-in or break event exists. This compatibility closure prevents one historical record from rolling back the atomic automatic timekeeping batch without weakening the current Dispatch rule.
- Equivalent shifts across schedule revisions are matched by week, location, and identical start/end. Missed-punch monitoring recognizes preserved punches on older revisions, while automatic clock-out stays linked to the original shift. A second revision cannot introduce a duplicate clock-in.

## Attendance reporting and employee pay-period history

- Accountability Tracker and Attendance & Call-Offs reporting share `private.get_attendance_events`. Linked native/legacy call-off records are deduplicated. Recorded event-type totals are separate from human review decisions; corrected records remain recorded, dismissed/voided records are excluded from type totals, and protected leave never becomes a discipline score.
- The attendance report requires `time.reports.view` and MFA. Excel/CSV exports additionally require `reports.export`, are audited, and include all matching records, not just the visible page. Excel separates employee totals from occurrence detail.
- Factual classification corrections require `accountability.manage`, MFA, a reason, row locking, and append-only before/after history. They preserve original notes, review decisions, punches, and payroll; they are not new call-off notifications.
- Employee-safe payroll context returns the current and two previous contiguous pay periods from the authoritative configuration. My Time keeps Today/This Week on the current period while the selected historical period controls the timecard list. Existing server-side employee scoping remains unchanged; historical records are not pay stubs or a payroll-edit mechanism.

## Support ticket system

- Every authenticated employee can submit and revisit their own support tickets from the persistent **Need Help?** workflow. Ticket handlers receive a permission-aware Administration workspace.
- Ticket category maps to the existing permission domain responsible for the work. Admin can access all tickets; other handlers require both a support-ticket permission and the routed operational permission.
- Priority is derived from factual impact answers rather than accepted directly from the requester. Safety impact, work stoppage, payroll impact, affected population, and deadlines feed the server-owned classification.
- Public messages and internal notes share one chronological conversation model, but internal notes are returned only to authorized handlers and never generate requester email.
- Lifecycle events queue both in-app and email notifications. The existing Worker notification processor claims, sends, audits, retries, and records delivery outcomes.
- Tickets, messages, events, and notification records deny direct browser table access. Authenticated security-definer functions provide the only application boundary.
- Binary attachments are release-gated until the support workflow can reuse the existing private, malware-scanned document pipeline.
- Opening requests have a browser-generated submission key and database retry lock; lifecycle notification deduplication is by event and recipient, independent of requester/handler overlap. No-op saves do not create events, and automatic reply/status changes share one notification. Ticket delivery claims hold a bounded lease.
- Resolved is the only completion status. Legacy Closed state normalizes without deleting closure evidence; a requester reply reopens a resolved ticket. Open-queue filters exclude completed tickets, and ticket reads synchronize the unified personal inbox.

## Employee notification center

- Every authenticated employee has a personal notification inbox. Inbox functions derive the recipient from the authenticated employee and never accept a recipient identity from browser input.
- Support Ticket lifecycle notifications are mirrored into the personal inbox through an idempotent database trigger. New producers can use the same private notification creation boundary without opening table access to browser roles.
- Read state and acknowledgment are distinct. Required messages remain actionable until explicitly acknowledged and cannot be dismissed beforehand.
- Authorized senders select active employees, roles, or both. The database expands and deduplicates recipients; only Admin may choose the company-wide audience.
- Recipient lookup and sending require the exact `notifications.manage` effective permission plus MFA. Employee inbox access itself remains available to every signed-in employee.
- Direct notification email uses a separate delivery queue claimed only by the service worker. In-app delivery is immediate; email delivery is queued, retried, audited, and never misrepresented as complete before provider success.

## Live updates and device push

- Authenticated shells subscribe to a private `employee:<auth user id>` Broadcast channel. The row policy matches both the authenticated identity and actual message topic. Payloads are invalidation signals, never ticket descriptions or internal notes; refreshed RPCs recheck access.
- Ticket reads used for synchronization are side-effect free. A separate visible-read RPC accepts a server-provided cutoff; acknowledgment remains explicit. Scoped cache cleanup prevents ticket/notification reuse after sign-out.
- A 30-second fallback and focus/reconnect synchronization preserve local drafts and current navigation. Popups and sound presentation are bounded and deduplicated across tabs and the push service worker.
- Device subscriptions and delivery leases remain private. Eligible active accounts must retain the authentication session associated with the registration. Background notifications contain generic text, not confidential ticket content.
- A Vault-authenticated asynchronous database wakeup dispatches encrypted Web Push through the Worker. Bounded retries run independently of timekeeping and email jobs. The push service worker has no fetch interception or offline application cache.
- Audio is a nonblocking browser enhancement: manual sign-in arms the login sound and completed security checks consume it once. Refresh and session renewal do not arm it. Device-local settings control login sound, notification sound, mute, and volume.

## SygSphere company messaging

- `/sygsphere` is a lazy-loaded authenticated workspace. A branded launcher above Need Help owns its separate unread-conversation badge and message alerts; ticket/system inbox producers are unchanged.
- Private SygSphere tables deny direct browser access. Authenticated RPCs require an active account, completed account security and current conversation membership. Owner actions are rechecked in the database; administrators do not implicitly join private chats.
- Recipient-specific private `sygsphere:<auth user id>` Broadcast topics carry invalidation identifiers only. The client reloads authorized records, with focus/reconnect and polling fallback. Visible-message IDs drive read receipts; drafts and client identifiers are scoped by employee, conversation and thread.
- The Worker checks membership before accepting bounded file bytes, validates content, stores private quarantine objects and uses the existing malware scanner. Service-only completion requires matching clean checksum evidence. Downloads require current membership and a clean attached, nondeleted message; no public Storage policy or signed public URL is introduced.
- A SygSphere-only release gate provides isolation without deleting history. Voice/video, Microsoft calendar integration and SygSphere background Web Push are not part of this release.

## SygTasks reminders and alarms

- Reminder definitions and recipient occurrences are private server-authoritative records tied to one task. A reminder fires once; an alarm remains active until its recipient stops, snoozes, opens the task locally, or completes the task when authorized.
- Employees may create private reminders for themselves. Authorized task editors may target the task's current assignees. Recipient expansion, active-account checks, task access, deduplication, cancellation and due-date recalculation are enforced in PostgreSQL rather than trusted to the browser.
- Relative reminders follow the current task due date. Task completion, cancellation, archive, assignment removal, or loss of eligible account access cancels future occurrences without deleting audit history.
- The scheduled Worker claims due occurrences with bounded, skip-locked service processing. It creates one SygTasks notification per occurrence, optionally queues the approved personal-first email route, and sends only a private Realtime invalidation signal.
- The SygTasks launcher owns a badge independent from SygSphere. A visible authorized shell displays the active alarm and uses a one-tab lease so multiple tabs do not overlap audio. The custom sound repeats about every eight seconds until the local or server action stops it; background or closed-browser delivery remains subject to browser and device notification behavior.
- Device sound preferences separate task alarms from ordinary notifications. Server acknowledgment and snooze persist across sessions and devices; opening a task only silences the current browser and never records a false acknowledgment.

## System status and release communication

- The application shell shows every signed-in user one compact service state: Online, Attention Needed, or Service Disruption.
- Detailed readiness and integration checks are restricted to the System Operations workspace and the `admin.maintenance.manage` permission.
- The Worker readiness endpoint returns sanitized booleans only. Secret values, private URLs, credentials, and request diagnostics are never rendered in the browser.
- Upcoming maintenance notices are dismissible. Active maintenance remains persistent until the protected window ends.
- Completed maintenance uses employee-safe language, automatically dismisses after 15 seconds, and stores dismissal per maintenance event so it does not reappear during navigation or a later session.
- Feature access continues to be enforced at the server and database boundaries; the service indicator is informational and never substitutes for authorization or health enforcement.
# HRIS Stage 8 protected workspaces

Talent, Learning, Employee Cases, Safety, and Assets are private HR domains with independent release gates. Their browser routes use the existing SygShift application shell, but protected data is read through authenticated Worker endpoints rather than direct browser access to private tables. Each endpoint requires its exact effective permission; Employee Cases and Safety additionally require recent MFA. Attachments remain in the Secure Document Platform, Licensing remains authoritative for credentials, and existing employee identities remain authoritative across every Stage 8 relationship. Compact worklists are bounded to 5, 10, or 20 records per page.

## Enterprise Document Studio

- The searchable HR forms library is one metadata catalog shared by employee **My Documents** and HR **Document Studio**. It indexes the controlled GS-HR code, title, category, record class, purpose, plain-language aliases, audience, sensitivity, and source filename; it does not copy completed employee records or create a second document store.
- Catalog results are filtered at the service-role database boundary to employee, supervisor, or HR scope and use bounded 5/10/20 pagination. A catalog entry becomes file-available only when it is deliberately linked to an immutable clean source in the existing protected document pipeline.
- Document Studio extends the existing private HR document vault. One canonical `hr_documents` record and its immutable versions may be associated with employee, client, site, post, shift, patrol, workflow, licensing, training, payroll, leave, contract, or other approved records without duplicating the binary.
- Policy versions define consent, authentication, routing, retention, completion, and regulated-document requirements. Template versions pin one clean source PDF and store normalized field definitions independently from the source.
- Signature envelopes pin an exact clean source version. Recipients, assigned fields, consent, recent identity evidence, signature appearance, trusted timestamps, events, final rendition, and audit certificate form one checksum-linked evidence chain.
- The Worker is the only file-stream and finalization boundary. Browser code receives protected same-origin responses, never service credentials or permanent public storage URLs.
- Finalization is idempotent and recoverable. Failed jobs use bounded exponential backoff, stale leases are reclaimable, five failures move the job to dead letter, and committed signature appearances are never removed during retry cleanup.
- Upload, processing, signature execution, advanced editing, regulated documents, external signers, and organizational seals have independent release gates. The UI exposes no unsupported editor or OCR control while those gates are closed.
