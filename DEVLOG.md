# SygShift Development Log

This file is the project handoff trail. Update it whenever production behavior, database functions,
deployment status, or major workflow assumptions change.

## Current production URLs

- Primary app: https://app.sygilant.us
- Worker fallback: https://sygshift.sygilant.workers.dev
- GitHub repo: https://github.com/Jbro9204/SygShift

## Operational notes

- Supabase is the production database.
- Cloudflare Workers serves the app and Worker API.
- Supabase remote migration history contains older remote-only migration entries that are not present locally.
  Because of that, `supabase db push --linked` has previously refused to run.
- For urgent production SQL fixes, targeted migrations have been applied with:
  `pnpm dlx supabase db query --linked --file <migration-file>`
- Do not run Supabase migration repair blindly. First reconcile remote migration history or intentionally apply
  a targeted SQL file.
- Button/action layout is protected by `src/buttonLayoutGuard.test.ts`. Do not add page/card action buttons
  with only generic `.primary-action` / `.secondary-button` sizing; use a local action wrapper or a proven
  shared action container so mobile and narrow-card layouts cannot overlap.

## 08/29/2026

### HRIS Stage 2 Controlled Backfill Plane — protected Run 3 controls

- Added a disabled-by-default database control plane for a future employee-identity canary; this release did not backfill any employee or enable an HR browser feature.
- Required authoritative hire and separation dates, current isolated-recovery evidence, recent MFA, `hr.people.manage`, a fresh preservation snapshot, a single-use 15-minute authorization, and service-only execution.
- Capped canary authorization at three employees and rejected stale approvals whenever protected employee, account, access, licensing, schedule, time, time-off, or payroll counts change.
- Added append-only authorization and execution evidence, cross-module before/after preservation assertions, a closed-gate installation assertion, validation tooling, focused tests, architecture documentation, and a controlled operating procedure.
- Applied forward-only production migration `20260830005500_hris_stage2_controlled_backfill.sql`; verified the production gate is disabled with zero effective-date authorizations, recovery-evidence records, backfill authorizations, or executions.
- Kept production execution blocked because authoritative dates and isolated recovery evidence have not been supplied; no dates were inferred or invented.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-29-2026_HRIS_STAGE_2_CONTROLLED_BACKFILL.md`.

### HRIS Stage 2 Reconciliation Proposal — Run 2 of 3

- Added a deterministic, service-only proposal layer that maps each existing `public.employees.id` to planned private HR person and worker identifiers without copying names, contact details, or authentication data.
- Added explicit blockers for identifier collisions, mismatched existing identifiers, mismatched source systems, and mismatched worker references; no ambiguity can be silently promoted into protected HR history.
- Added aggregate-only reconciliation reporting, a release assertion, and browser-role revocations while retaining service-role inspection for controlled administration.
- Applied only migration `20260829233000_hris_stage2_reconciliation_proposal.sql` through an isolated forward-only workspace; no migration repair or historical replay was performed.
- Production reconciliation evaluated 78 employee records: 78 deterministic proposals, zero identity blockers, 78 missing-hire-date warnings, and nine missing-separation-date warnings.
- Kept protected backfill, HR features, role mapping, and browser access disabled. No HR person or worker rows were created and no live employee, access, payroll, licensing, schedule, timekeeping, or audit history was changed.
- Added the `check:hris-reconciliation` validator, focused regression tests, architecture documentation, and an operating procedure for the final controlled backfill run.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-29-2026_HRIS_STAGE_2_RECONCILIATION.md`.

### HRIS Stage 2 Core Data Architecture — Run 1 of 3

- Extended the existing permanent `public.employees` identity with private one-to-one HR person and worker identifiers; no second directory or duplicate name/contact/authentication data was created.
- Added dormant private Core HR structures for legal entities, organization units, locations, job profiles, positions, employment, assignments, manager history, employment changes, and compensation history.
- Enforced row-level security, no direct browser access, append-only audits, no-delete reference/history controls, close-only effective records, overlap prevention, self-manager prevention, and required closing actor/reason metadata.
- Registered six deny-by-default HR permission definitions but assigned none of them to current roles or employees.
- Kept the Stage 1 protected-data gate, Stage 2 feature, protected backfill, role mapping, and browser access disabled.
- Added the `check:hris-core` contract validator and Stage 2 architecture regression tests.
- Applied only migration `20260829230000_hris_core_data_architecture.sql` through an isolated migration workspace after the normal command detected legacy remote-history drift; no migration repair or replay was performed.
- The migration transaction verified that employee count, employee role memberships, role permission assignments, and individual permission overrides remained unchanged before commit.
- Confirmed 104 test files / 518 tests, type checking, zero-warning linting, the production build, and focused HRIS contract validation pass.
- Full architectural and rollback details are recorded in `docs/changelogs/CHANGELOG_08-29-2026_HRIS_STAGE_2_CORE_ARCHITECTURE.md`.

## 08/28/2026

### Reports workspace redesign

- Rebuilt Reports as a compact library with exactly eight operational reports and focused nested workspaces.
- Added shared date-range persistence, report-specific search and filters, active/archive views, stable sorting, 10/25/50-row server pagination, bounded detail modals, and canonical workflow links.
- Kept Reports read-only and left Payroll in its dedicated HR & Finance workspace.
- Added the server-authoritative `get_timekeeping_operations_report_page(...)` RPC with a 50-row request cap, legal-name projection, validated inputs, stable ordering, total counts, and `time.reports.view` enforcement.
- Preserved every existing role assignment, employee role membership, individual grant, and individual denial.
- Applied targeted production migration `20260828203000_reports_workspace_server_pagination.sql` and verified the function and authenticated execution grant remotely.
- Confirmed 97 test files / 490 tests, type checking, linting, the production build, and Git whitespace validation pass.
- Released implementation commit `443deed` as Cloudflare Worker version `60587ba8-6ec9-44f9-94bb-6f5993869256`.
- Confirmed the primary and fallback health/readiness endpoints, the deployed Reports route, the branded login boundary, and a clean browser console after release.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_REPORTS_WORKSPACE_REDESIGN.md`.

### Compact operational exception queue

- Replaced the unbounded Operational Time Exceptions list with a compact queue that shows 10 records initially.
- Added progressive **Show next 10** controls, an exact **Showing X of Y** count, and a **Show first 10** collapse action so a large queue never takes over the page at once.
- Reduced row height without shrinking or truncating the employee, exception, location, date, or time information.
- Reset the queue to the first 10 whenever the operations date range changes and added full-width mobile controls.
- Added a regression guard that prevents the unbounded exception rendering from returning.
- Confirmed all 96 test files and 487 tests, linting, type checking, and the production build pass.
- Deployed Cloudflare Worker version `a29553a8-3ebd-4ce6-9891-8110499eb265`; public health and readiness checks passed.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_COMPACT_OPERATIONAL_EXCEPTION_QUEUE.md`.

### Prominent Home call-off action

- Replaced the weak low-contrast call-off link in the Home time-status strip with a dedicated high-contrast urgent-action control.
- Added an icon tile, explicit urgency context, and complete hover, focus, pressed, desktop, and mobile states while preserving the existing call-off route and permissions.
- Confirmed all 95 test files and 485 tests, linting, type checking, and the production build pass.
- Deployed Cloudflare Worker version `91f047ee-86fe-41d6-9c06-0a5f58210a1d`; public health and readiness checks passed.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_HOME_CALL_OFF_ACTION_VISIBILITY.md`.

### Permission-aware navigation and workflow controls

- Removed dead-end controls that were visible even when the signed-in employee could not open the destination workflow.
- Review Queue, Team Attendance, Time Operations, Daily Attendance Review, Accountability, Payroll, announcement actions, and operational-alert actions now use the same route-access policy that protects the destination page.
- Updated the primary sidebar and Time workspace navigation to derive visibility from the canonical route policy instead of maintaining separate permission lists that could drift.
- Prevented the application shell from loading operational attendance alerts for users who cannot access Time Operations.
- Preserved every existing role, role membership, individual permission grant, and individual permission denial; this release changes visibility only.
- Added route-policy and source regression tests to prevent unauthorized dead-end controls from returning.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_PERMISSION_AWARE_NAVIGATION.md`.

### Role-aware Home redesign

- Replaced the shared operational landing page with two focused Home experiences: **Employee Home** for hourly and non-operational staff, and **Operations Home** for Administrators and Supervisors.
- Deployed production version `4928a460-05bc-4d06-80cf-a8ecb38f5b37` to `https://app.sygilant.us` on 08/28/2026.
- Employee Home now prioritizes current clock status, clock/break actions, the next shift, personal schedule, time-card help, time-off and shift-pool access, and a concise announcement preview.
- Operations Home now prioritizes payroll readiness, live attendance, schedule coverage, time-off and correction queues, and permission-filtered operational workspaces without removing personal schedule or time actions.
- Preserved all existing time-clock, schedule, request, announcement, payroll, and permission services; this release changes presentation and routing composition rather than creating parallel business logic.
- Moved Time-Off Requests into **HR & Finance** and prevented normal announcements from duplicating the urgent global banner.
- Added responsive layouts and regression guards for role mapping, greeting fallbacks, Sunday week boundaries, preview limits, announcement separation, permission filtering, canonical time actions, and mobile behavior.
- Rollback checkpoint: `dffac10`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_HOME_REDESIGN.md`.

### HR & Finance navigation and dedicated Payroll workspace

- Added a permission-aware **HR & Finance** navigation group and moved Payroll into its own focused workspace.
- Deployed production version `ef99ef8e-baf8-4e99-aa41-23d482965a0c` to `https://app.sygilant.us` on 08/28/2026.
- Added Payroll Overview, Review Queue, Employee Payroll, Export & History, and administrator-only Rules destinations.
- Preserved existing payroll calculations, Week 1/Week 2 separation, overnight attribution, exception resolution, workbook generation, official locks, and export history.
- Added one selected pay-period control shared through Payroll URLs and reloads, with current, previous, next, last-completed, and custom date-range workflows.
- Kept Payroll Overview concise with readiness metrics and no more than five priority records.
- Added searchable, filterable, sortable, paginated Review Queue and Employee Payroll workspaces with 10 rows by default and 25/50 row options.
- Added open-on-demand employee payroll detail with Week 1 and Week 2 totals and vertical punch detail.
- Reduced Time & Attendance list density by paginating Team Attendance and Review Queue at 10 rows by default and limiting live missing-clock-in summaries to five items.
- Kept Payroll Rules out of non-admin navigation, content, and data-query execution.
- Added `src/payrollWorkspaceGuard.test.ts` and `docs/PAYROLL_WORKSPACE_PRESERVATION_MATRIX.md` to protect the new boundaries and existing payroll behavior.
- Staged rollback points: `11cb93c`, `68eeaf4`, `a5aedcd`, and `15c4df1`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_HR_FINANCE_PAYROLL_WORKSPACE.md`.

### Time navigation and button polish

- Made the sidebar Back control inherit the same transparent navigation treatment and hover behavior as Home.
- Prevented Time workspace action labels from wrapping inside their buttons; complete buttons wrap as units when the action row runs out of space.
- Removed repeated Time Command Center links from nested Time pages because the persistent Time workspace tabs already provide that navigation.
- Preserved useful contextual actions and the existing full-width mobile button layout.
- Added `src/timeNavigationPolishGuard.test.ts` to prevent the navigation and wrapping regressions from returning.
- No database, permission, payroll, or time-record behavior changed.
- Full validation passed with type checking, linting, 90 test files / 458 tests, production build, and 10 desktop/mobile browser tests.
- Released Cloudflare production version `3b125a09-04a8-4d29-9ab6-e07ff32c37b7`; custom-domain and Worker-fallback health and readiness checks passed after deployment.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-28-2026_TIME_NAVIGATION_AND_BUTTON_POLISH.md`.

## 08/27/2026

### Time & Attendance workspace redesign

- Consolidated employee and operations timekeeping into one permission-aware Time & Attendance workspace with Overview, My Time, Team, Review Queue, Operations, and Accountability tabs.
- Added distinct Back and Home controls. Back follows safe in-app history and falls back to the last valid SygShift location; Home always returns to the role-appropriate landing page.
- Reorganized the primary sidebar into collapsible operational groups while preserving permission-based visibility and the mobile navigation boundary.
- Added a persistent clock-status strip across the Time workspace so employees can clock in/out or start/end a break without leaving their current time view.
- Simplified the employee My Time experience around the current pay period, prior-period navigation, punch and break history, worked totals, locations, and correction-request status.
- Rebuilt Team as a compact searchable employee summary with details opened only when needed instead of rendering every employee's punch history at once.
- Grouped Exceptions, Correction Requests, and Daily Reconciliation into a clear Review Queue and preserved deep links into each existing audited workflow.
- Kept Operations focused on missing starts, manual time entry, call-offs, and operational history; Accountability remains a distinct factual occurrence record.
- Added safe redirects from the superseded `/time/tools`, `/time/timecards`, and `/time/exceptions` routes so saved links do not strand users.
- Preserved payroll calculations and export behavior unchanged; the separate Payroll workspace remains an approved future initiative.
- No database migration or time-record mutation was required.
- Full validation passed with type checking, linting, 89 test files / 455 tests, production build, and 10 desktop/mobile browser tests covering accessibility, authentication boundaries, password visibility, Time Maintenance layout, and User Accounts containment.
- The staged rollback checkpoints are `b5bd343`, `5f4cfb3`, `7d761aa`, `19e1281`, `703d1b3`, `23235bf`, and `aeb4f1e`.
- Released Cloudflare production version `54001f50-93a4-4fb4-b7b9-576a25805144`; custom-domain and Worker-fallback health/readiness checks passed after deployment.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-27-2026_TIME_ATTENDANCE_WORKSPACE_REDESIGN.md`.

### Licensing Center redesign

- Rebuilt the Licensing Center into a compact active-employee worklist with clear priority cards, focused filtering, sorting, and separate historical access for non-active employees.
- Kept legal employee names authoritative throughout Licensing while expanding search to username, employee number, credential number, and credential type.
- Replaced the oversized nested credential workspace with a focused employee licensing profile using Credentials, Renewals, and Documents & Activity tabs.
- Added one-record-at-a-time credential disclosure and grouped standard guard licensing with armed endorsements without merging their underlying records.
- Preserved credential editing, renewal tracking, document handling, communications, onboarding, MFA enforcement, permissions, audit behavior, and server APIs.
- Current workload totals now include active employees only; inactive, leave, and separated records remain intentionally accessible through the employment filter.
- No database migration or credential data change was required.
- Full validation passed with type checking, linting, 88 test files / 451 tests, and the production build.
- Released Cloudflare production version `0bfb5ae9-7685-45e1-861d-1121bbda6ebb`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-27-2026_LICENSING_CENTER_REDESIGN.md`.

### My Account self-service workspace

- Added a dedicated My Account workspace for every signed-in employee with focused Profile & Contact, Employment, Security, and Notifications tabs.
- Moved the normal account-security entry point into My Account while preserving the protected first-login and MFA checkpoint route.
- Added audited self-service updates for preferred name, personal email, and mobile phone; company email and employment records remain read-only.
- Added private profile-photo upload, replacement, and removal with JPEG/PNG validation, a 5 MB limit, immediate header refresh, and protected object storage.
- Added personal-email verification and employee-controlled email preferences while preserving mandatory operational call-off delivery.
- Consolidated password, authenticator, trusted-device, session, recovery-code, and security-activity controls into the Security tab with confirmation and audit safeguards.
- Applied targeted production migration `20260827110000_my_account_self_service.sql`; all required RPCs, the verification column, and the private photo bucket were verified remotely.
- Full validation passed with type checking, linting, 87 test files / 442 tests, access-control inventory, and the production build.
- Released Cloudflare production version `e413f329-edc4-4ba3-9b24-65102ecf0327`; live health/readiness and protected-endpoint checks passed.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-27-2026_MY_ACCOUNT.md`.

### Sites & Posts directory redesign

- Rebuilt Sites & Posts as a compact, full-width operational directory with one expanded site at a time.
- Added search across sites, posts, codes, cities, and addresses plus All, Active, and Inactive filters.
- Added focused Add Site, Recently Deleted, Manage, Edit Site, Add Post, Edit Post, and protected Delete workflows.
- Kept new posts locked to their selected parent site and displayed post coverage times in civilian and military formats.
- Added responsive desktop, tablet, and mobile layouts without horizontal page scrolling.
- Preserved `sites.manage` authorization, existing API calls, validation, audit logging, protected deletion, and 14-day deleted-record retention.
- No database migration or operational data change was required.
- Added 10 focused Sites & Posts tests; full validation passed with 86 test files / 437 tests, type checking, linting, production build, Cloudflare packaging, and production health/readiness checks.
- Released Cloudflare production version `7c1e4ee0-9ba0-4b61-8302-ed42ace44679`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-27-2026_SITES_AND_POSTS_DIRECTORY_REDESIGN.md`.

## 08/26/2026

### User Accounts redesign

- Reorganized User Accounts into a compact summary, focused account filters, separate bulk actions, and a responsive five-column employee account list.
- Rebuilt the employee account workspace into Profile, Login & Security, and Onboarding tabs while preserving every existing account field, security action, onboarding action, permission check, and backend operation.
- Added explicit profile dirty-state handling, close/tab-change confirmation, and a sticky save bar without introducing autosave.
- Kept MFA reset, trusted-device revocation, password, account-status, invite, welcome-email, and login-instruction actions independent from profile saving.
- Moved sensitive separation and deletion controls into an administrator-only collapsed area and retained the Licensing Center boundary for credentials.
- Added responsive account cards, standardized modal and button layout, and expanded regression coverage.
- No database migration or account-data change was required.
- Full release validation and production version are recorded in `docs/changelogs/CHANGELOG_08-26-2026_USER_ACCOUNTS_REDESIGN.md`.

### Role and Employee Permission Center

- Rebuilt Roles & Permissions into two focused workspaces: **Role & Group Permissions** and **Employee Permissions**.
- Added compact, searchable permission categories; role summaries; employee search; additional role memberships; individual additive permissions; and effective-access totals.
- Replaced the normal employee deny workflow with a safer additive-only editor while preserving existing legacy restrictions.
- Added dirty-state save controls, required employee audit reasons, sensitive-access confirmations, and unsaved-navigation protection.
- Added server-authorized atomic employee access saves with active Admin, MFA, and `admin.roles.manage` enforcement.
- Added row locking, permission/role validation, inherited-access normalization, and before-and-after access audit records.
- Corrected active role assignment counts and kept legal employee names in the administrative access workspace.
- Applied and recorded targeted production migration `20260826230000_additive_employee_access_profile.sql` without changing existing employee access assignments.
- Full release validation and production version are recorded in `docs/changelogs/CHANGELOG_08-26-2026_ROLE_AND_EMPLOYEE_PERMISSION_CENTER.md`.

### Manage Employee Access workspace redesign

- Replaced the two-step employee chooser and oversized access editor with one focused, responsive workspace.
- Added a searchable active-employee directory and clear tabs for role memberships, individual exceptions, and effective-access review.
- Grouped permissions by the established application categories and collapsed effective-access details so administrators can inspect them without scrolling through one continuous list.
- Kept role saves and exception actions beside the settings they change, with required audit reasons, loading states, success/error feedback, and immediate server-confirmed refreshes.
- Preserved all existing role assignments, employee-specific grants and denials, server-enforced Admin/MFA authorization, audit records, and protected Admin recovery rules.
- Added regression coverage for the complete workspace, mutation boundaries, refreshed state, responsive modal sizing, controlled scrolling, and button layout.
- Full validation passed: type checking, linting, 85 test files / 426 tests, and production build.
- Cloudflare packaging and startup validation passed; the deployed Worker started in 4 ms.
- Released Cloudflare production version `cd600e36-3420-4071-9226-c0a19f8d1634`.
- Verified HTTP 200 health and readiness responses on both the custom domain and Workers fallback, confirmed the public sign-in route loads, and confirmed the live access-control asset contains the new role-membership, individual-exception, and effective-access workspace.

### Production data connection recovery and actionable service diagnostics

- Restored browser-side data and authentication access after a production build supplied blank public connection values.
- Confirmed the incident was a frontend release-configuration defect, not a Cloudflare outage, Supabase outage, maintenance restriction, or loss of operational data.
- Production releases now recover from blank public build values using the approved public browser configuration; local/test disconnected-state coverage remains available.
- Expanded the protected System Operations health view so administrators see the affected service, detected problem, operational impact, and recommended next action.
- Added focused configuration and diagnostic regression tests plus responsive diagnostic presentation guards.
- Full validation passed: type checking, linting, 84 test files / 423 tests, production build, Cloudflare dry run, compiled release inspection, and live custom-domain/fallback health and readiness checks.
- Released Cloudflare production version `05625299-3dcd-4dc3-a785-8c90e0397911`.

### User Accounts and legal-name boundary

- Renamed the employee account-administration workspace from **Users & Access** to **User Accounts** across active navigation, headings, tests, and operating documentation.
- Kept usernames, account activation, login history, MFA recovery, onboarding messages, and account-state controls together while leaving role and permission design in the separate Roles & Permissions workspace.
- Removed preferred-name editing from User Accounts and preserved existing preferred-name values when an administrator updates account data.
- Standardized controlled account and current payroll-review records on the employee's legal/profile name, including a recorded middle name when present.
- Preserved preferred-name use and existing name-disambiguation behavior in schedule-facing workflows, including clear handling for employees who share a last name.
- Added a protected payroll-review database boundary so current review and export data uses legal/profile names without rewriting immutable historical export snapshots.
- Applied and recorded targeted production migration `20260826220000_user_accounts_legal_name_boundary.sql`.
- Removed the completed initiative from the active future queue; the separate Manage Employee Access workspace redesign remains queued.
- Full validation passed: type checking, linting, 84 test files / 420 tests, 20 focused browser tests across both configured viewports, production build, Cloudflare package dry-run, current Worker startup profiling, and live database authorization checks.
- Released Cloudflare production version `75f5bb9c-9b1a-4da6-95c9-13bcd4d5e018`; the custom domain and Workers fallback health/readiness endpoints returned HTTP 200, and the live User Accounts bundle passed the release-content checks.

### Operational alert lifecycle and backlog reconciliation

- Added stable occurrence identities so schedule revisions and repeated automation runs cannot create multiple unresolved alerts for the same employee, rule, shift window, and work location.
- Reconciled the production backlog from 693 active alerts to 22 current actionable alerts, moved 235 older unresolved occurrences to payroll review, retained 436 resolved occurrences in history, and reduced unresolved duplicate occurrence groups to zero.
- Automatically resolves missing-clock-in occurrences only when a valid clock-in, canceled shift, reassignment, or valid call-off proves the alert is no longer applicable.
- Keeps genuine missed clock-ins visible to Dispatch through the shift and for one hour afterward, then transfers unresolved occurrences to payroll review without deleting history.
- Added one-minute incremental reconciliation and a 02:00 Mountain Time full safety pass.
- Preserved original punches, schedules, acknowledgments, exception actions, and payroll history.
- Applied and recorded targeted production migration `20260826210000_operational_alert_lifecycle_reconciliation.sql`.
- Full validation passed: type checking, linting, 83 test files / 415 tests, production build, Cloudflare package dry-run, live data reconciliation, and production health/readiness checks.
- Released Cloudflare production version `14992d6d-2c02-4e7d-9446-a5c7b453ffbc`.

### Mixed coverage and additive guard assignment

- Added explicit **Total guards needed** and **Armed positions** controls so schedulers can create any supported armed/unarmed staffing mix for a Site/Post or event.
- Represented mixed coverage as separate armed and unarmed coverage blocks at the same location and time, preserving the existing schedule, qualification, publish, copy, and payroll architecture.
- Changed the focused staffing action to **Add guard to open position** so each save fills one remaining position without replacing or canceling guards already assigned.
- Kept intentional reassignment in the full-block editing workflow and left the existing Miss Fits schedule entry unchanged.
- Preserved permissions, MFA, availability checks, credential checks and documented overrides, capacity limits, audit history, and immediate post-save refresh behavior.
- Applied and recorded targeted production migration `20260826200000_scheduler_mixed_coverage_assignments.sql`.
- Passed a rollback-safe production database regression proving a 1-armed/2-unarmed plan and two retained additive assignments, with no residual test data.
- Full validation passed: type checking, linting, 82 test files / 410 tests, production build, Cloudflare package dry-run, live bundle inspection, and production health/readiness checks.
- Released Cloudflare production version `347b38fe-0091-4b57-a2af-2dd1a9734fa9`.

### Platform status and maintenance communication cleanup

- Removed the oversized technical data-connection banner from Home.
- Added one compact service indicator with plain-language `Online`, `Attention Needed`, and `Service Disruption` states.
- Limited detailed, sanitized platform checks to the protected System Operations workspace for authorized administrators.
- Added live checks for application delivery, data and authentication, protected integrations, and safe release controls without exposing credentials or private connection values.
- Replaced internal maintenance-test wording with the calm employee-facing message: `Maintenance complete. SygShift is available normally.`
- Added manual dismissal for upcoming and completed notices, 15-second automatic dismissal for completed notices, and event-specific persistence so dismissed notices do not reappear.
- Kept active maintenance persistent and preserved existing server enforcement, permissions, update prompts, unsaved-work protection, and automatic maintenance expiration.
- Removed the completed maintenance-communication item from the active future queue and synchronized the Desktop mirror.
- Full validation passed: type checking, lint, 80 test files / 401 tests, production build, Git whitespace validation, and live production health/readiness checks.
- Released Cloudflare production version `9a5858d8-8f86-47f2-9965-3c6da6c65298`.

### Live scheduled no-show visibility for dispatch

- Corrected the Time Command Center so Missing Punches includes employees who are currently scheduled but have not clocked in.
- Restored the operational missing-clock-in grace period to 15 minutes after a published shift starts.
- Kept the separate 14-hour guardrail for unusually long active clock-ins; the two rules no longer share one threshold.
- Added a focused dispatcher panel with the employee name, Site/Post, and scheduled start time, plus a direct route to the actionable Time Operations queue.
- Limited the live dashboard panel to shifts that are currently in progress; older missed starts remain in operational history instead of cluttering the current dispatch view.
- Preserved all punches, schedules, exception history, and audit data.
- Applied and recorded targeted production migration `20260826150000_missing_clock_in_dispatch_visibility.sql`.
- Verified the live 15-minute setting and confirmed production generated the expected current missing-clock-in record for Randall Hurst.
- Full validation passed: type checking, linting, 77 test files / 392 tests, production build, Cloudflare package dry-run, and live health/readiness checks.
- Released Cloudflare production version `ccd5a6ea-7e83-4700-9523-80ab530e49fd`.

### Timecard and Team Attendance current-week default

- Corrected Time Maintenance so it no longer reopens on the last completed payroll period.
- Corrected Team Attendance so it opens to the current Sunday-through-Saturday operational week instead of the full biweekly payroll period.
- Preserved deliberate Team Attendance ranges in the URL so browser navigation and saved links restore the selected dates.
- Kept employee changes from resetting the active review range.
- Preserved exact one-day/date-specific ranges opened from Exceptions, Payroll Review, and Daily Attendance.
- Left Payroll Export and payroll exception period logic unchanged.
- Full validation passed: type checking, lint, 77 test files / 390 tests, and production build.
- Released Cloudflare production version `e150c43e-edc5-4e8a-b380-9d5c85fb0ef8`; health and readiness returned HTTP 200 on both the custom domain and Workers fallback.

### Automatic clock-out schedule-revision continuity

- Corrected a production defect that could skip automatic clock-out when an employee clocked into a shift and the schedule was later republished as a new revision.
- Kept each punch linked to its original immutable shift for audit integrity; no punch or shift relationship was rewritten.
- Automatic clock-out now accepts the exact session-linked shift when its parent schedule is either published or superseded, while draft and archived schedules remain excluded.
- Missing-clock-in detection remains restricted to the current published schedule so obsolete revisions cannot create duplicate attendance alerts.
- Audited the live one-minute automation across all active employees: the scheduler was healthy, no job failures occurred, and one additional unambiguous overdue scheduled session was automatically closed at its authoritative scheduled end after the correction.
- Left one unrelated supervisor-entered session without a linked shift untouched for human review because no authoritative end time exists.
- Added a dedicated regression guard for revision continuity, exact shift matching, duplicate protection, excluded schedule states, and published-only missing-clock-in detection.
- Applied targeted production migration `20260826100000_auto_clock_out_revision_continuity.sql` and recorded it in remote migration history.
- Full validation passed: type checking, lint, 76 test files / 385 tests, production build, current Wrangler startup analysis, live health/readiness, and post-release automation reconciliation.

## 08/25/2026

### Future work queue categorization

- Rebuilt `docs/future-items/FUTURE_ITEMS.md` as an active queue containing only unfinished or intentionally retained work.
- Assigned every active item an owning category, priority, target window, status, and added date.
- Added the approved operational-alert lifecycle, employee-access redesign, User Accounts consolidation, employee timecard history, and dedicated payroll workspace initiatives that had been discussed but were missing from the file.
- Retained supervisor-scoped workforce visibility and Indeed integration research in their proper long-term categories.
- Removed completed initiatives from the active queue; their history remains in dated changelogs and this development log.
- Updated the Build and Handoff Guide to reflect the completed permission-enforcement audit and Guard access hardening.
- Synchronized the repository queue with the Desktop Future Items mirror.
- Added the urgent Platform Operations follow-up for employee-safe maintenance banner wording, audience controls, and 15-second completion-message expiration.
- No production behavior, permissions, schedules, time records, payroll data, or employee information changed.

## 08/24/2026

### Large payroll preview download repair

- Reproduced the production `Maximum call stack size exceeded` error with a 1,200-row payroll workbook fixture.
- Replaced unsafe large-array expansion in the XLSX ZIP writer with bounded typed-array writes and one final allocation.
- Added explicit ZIP-format limit checks so unsupported sizes fail with a controlled explanation instead of creating a broken workbook.
- Preserved workbook layout, Week 1 / Week 2 separation, employee detail sheets, and all payroll calculations.
- No production punches, schedules, payroll records, locked exports, or audit history were modified.
- Full validation passed: type checking, lint, 72 test files / 370 tests, and the production build.
- Deployed Cloudflare Worker version `18034a71-2c86-419c-b52e-b6368e9db473`; custom-domain and Worker-fallback health/readiness checks passed, and the live payroll asset contains the bounded workbook packager.

### Payroll web week separation and preview download reliability

- Separated the browser payroll summary into distinct Sunday-through-Saturday Week 1 and Week 2 sections instead of presenting only one combined pay-period total.
- Added a clear weekly payable total and employee count to each section, with employee detail opening in the correct payroll week.
- Made the browser summary and Excel workbook use the same weekly grouping and total-calculation source so the two views cannot silently disagree.
- Kept overnight work entirely in the payroll week containing its authoritative scheduled start or clock-in.
- Repaired preview downloads by validating the generated workbook, attaching the download element to the page, and retaining its object URL long enough for Chrome and Edge to finish the save.
- Added visible download progress, success, and actionable failure feedback instead of allowing the download button to appear unresponsive.
- Hardened workbook XML generation against illegal control characters while retaining correct XML escaping for names and other text.
- No punches, schedules, payroll calculations, locked exports, or audit records were rewritten.
- Full validation passed: type checking, lint, 72 test files / 369 tests, production build, workbook XML/package validation, and Git whitespace validation.
- Deployed Cloudflare Worker version `59ee2599-8e27-467c-9eb1-06050a98269a`; custom-domain and Worker-fallback health/readiness checks passed, and the live payroll asset contains the weekly-summary release.

### Weekly payroll export by payroll week

- Reorganized payroll workbooks so Finance receives one employee row for each Sunday-through-Saturday payroll week in the selected range, followed by separate Week 1, Week 2, and pay-period totals.
- Added clear weekly columns for scheduled, worked, training, regular, overtime, sick, PTO, other paid, and total payable hours.
- Added separate `Week 1 Detail` and `Week 2 Detail` worksheets for a standard biweekly export, with additional numbered weekly worksheets when a custom range spans more weeks.
- Added weekly rollups to every employee detail worksheet while preserving the full punch-level audit trail.
- Kept each overnight occurrence entirely in the payroll week containing its authoritative scheduled start or clock-in; Saturday-night work is not split at Sunday midnight.
- Preserved the distinction between worked punch time, scheduled comparison hours, and approved paid-time categories.
- No production punches, schedules, payroll batches, locked exports, or audit history were rewritten.
- Full validation passed: type checking, lint, 72 test files / 367 tests, production build, Cloudflare deployment dry-run, and live production health/readiness checks.
- Generated and visually reviewed all eight worksheets in a representative workbook; workbook formula-error inspection returned zero errors.
- Deployed Cloudflare Worker version `1992a2c1-7d46-4870-86f6-0e966e56d354`.

### Authoritative overnight occurrence resolution

- Consolidated overnight punch assignment, workday grouping, Time Maintenance, team attendance totals, payroll review, and exports onto one canonical occurrence resolver.
- Made the session clock-in authoritative so later break and clock-out events remain on the workday and assignment where the session began, including across midnight and payroll boundaries.
- Invalid stored shift links are now rejected; only a single deterministic assigned candidate is repaired automatically, while unsupported or ambiguous events remain unscheduled for human review.
- Updated live and supervisor-entered punch paths to use the same occurrence relationship and timestamp guardrails.
- Updated Time Maintenance to display the canonical Shift/Site/Post instead of an obsolete raw event link.
- Preserved every source punch and stored historical repairs in the append-only audited occurrence-override ledger.
- Production verification found zero resolved punch links outside their shift working window and confirmed real overnight clock-in/out pairs share one occurrence and operational date.
- Full validation passed: type checking, lint, 70 test files / 356 tests, and the production build.
- Applied targeted production migrations `20260824224500_authoritative_overnight_occurrence_resolution.sql` and `20260824230000_time_maintenance_canonical_occurrence_display.sql`.

### Overnight manual-punch workday integrity

- Corrected Gaston Musambay's 08/13/2026 6:00 PM clock-in so it belongs to the 08/13/2026 operational shift and pairs with the 08/14/2026 6:00 AM clock-out.
- Preserved the original punch record and added a separate append-only occurrence correction with its own reason, source, and audit history.
- Added an explicit operational date to Time Maintenance shift choices and limited manual-punch Site/Post choices to shifts that start on the selected workday.
- Added a database guard that rejects a new manual punch when the selected shift is outside the punch's permitted working window.
- Confirmed production now groups 08/12/2026 6:00 PM–08/13/2026 6:00 AM as the 08/12 workday and 08/13/2026 6:00 PM–08/14/2026 6:00 AM as the 08/13 workday.
- Full validation passed: type checking, lint, 69 test files / 351 tests, and the production build.
- Applied targeted production migration `20260824213000_time_event_operational_shift_integrity.sql`.
- Deployed Cloudflare Worker version `76f367b7-1c8d-44f4-a17e-bde2b14525f1`.

### Role and permission QA with Guard least-privilege hardening

- Audited the live permission catalog, all six system roles, 47 active employee assignments, route/navigation policies, protected page actions, public database functions, and row-level database policies.
- Reduced the Guard role to the approved 11-permission self-service baseline: Home, own action center, own published schedule, own time and time clock, own availability, own requests, employee announcements, eligible events/open shifts, and assigned training.
- Removed team-wide time visibility and accountability-event creation from Guards.
- Made Guard request, availability, and announcement viewing usable without MFA while keeping each database read restricted to the signed-in employee or the intended announcement audience.
- Restricted raw employee, schedule, shift, assignment, availability, site, post, event, and announcement reads at the production database boundary.
- Made the existing Scheduler and Supervisor `Edit credentials` permission functional by allowing credential editors into the Licensing Center while independently hiding employee-profile, configuration, and communication actions they are not permitted to use.
- Preserved all employee role assignments: 35 Guards, 3 Dispatchers, 1 Scheduler, 5 Supervisors, 2 Admins, and 1 Recruiting & Licensing employee. No additional access-role assignment or person-specific override exists.
- Verified all 47 active employees have an enabled account.
- Production role impersonation confirmed a Guard can see only their own published assignment records and cannot access team or Licensing Center data; Scheduler and Supervisor credential editing succeeds only in an MFA-verified session.
- Full validation passed: type checking, lint, 68 test files / 347 tests, production build, and access-control inventory.
- Deployed Cloudflare Worker version `5d17d26a-e401-460b-8847-914bfa77281f`; live health, readiness, login-route, and static-asset checks passed.

### Time Maintenance scheduled-hours boundary

- Corrected the scheduled-hours range rule so an overnight shift belongs to the operational date on which it starts.
- Prevented a prior-day overnight shift from leaking into the next selected Time Maintenance range merely because its clock-out occurs after midnight.
- Excluded canceled shifts from the scheduled-hours summary.
- Verified Bernard Petermon's 08/09/2026 through 08/22/2026 production data: the former overlap rule returned 9 shifts / 64.00 hours; the corrected operational-date rule returns 8 shifts / 56.00 hours.
- Confirmed `Needs attention: 0` is correct for this record: 56 hours are divided across two payroll weeks at 28 hours per week, worked time matches scheduled time, and no correction or payroll exception is pending.
- Added regression coverage for the operational-date boundary and the removal of the old overlap rule.
- Full validation passed: type checking, lint, 67 test files / 339 tests, and the production build.
- Applied targeted production migration `20260824170000_time_maintenance_operational_schedule_range.sql`; this database-only correction became live immediately and did not require a Worker redeployment.

### Personal and company-wide schedule access

- Added the locked baseline permission `schedule.self.view` (`View own schedule`) for every system role so active employees can always reach their own published schedule without an individual permission grant.
- Redefined the existing `schedule.view` permission as `View all schedules`. It remains the elevated company-wide schedule permission and now requires MFA.
- Removed inherited company-wide schedule access from Guard and Recruiting & Licensing while preserving every other role and person-specific permission.
- Kept Dispatch, Scheduler, Supervisor, and Admin access to company-wide schedules through their existing elevated roles.
- Enforced the separation in the production schedule database function: personal-only users receive only shifts assigned to their employee record, while authorized team viewers retain all schedule coverage and draft access.
- Confirmed Zachary Ward receives personal schedule access through the Recruiting & Licensing role; no person-specific grant was added.
- Added route, navigation, UI, SQL-boundary, and regression tests for the access split.
- Full validation passed: type checking, lint, 66 test files / 337 tests, and the production build.
- Applied targeted production migration `20260824113000_schedule_self_view_permission.sql`.
- Deployed Cloudflare Worker version `cc3cecf7-a3c9-4565-a43b-ac5514bb1e8c`.
- Live production health returned `ok` and readiness returned `ready` on the custom domain; the Worker fallback health endpoint also returned `ok`.

## 08/23/2026

### MFA-aware onboarding emails

- Replaced the older rollout-era Welcome email with the approved, permanent SygShift introduction and Jordan Brown's current title, `IT and Business Development Engineer`.
- Kept Welcome and Login Instructions as separate admin actions so a new employee receives no more than two deliberate onboarding messages.
- Added mutually exclusive standard and MFA Login Instructions. Employees without an MFA requirement receive the short password-setup path; employees with protected access receive the authenticator setup path.
- Tied the MFA email decision to the same effective-access sources used by authenticated sessions: base system role, assigned access roles, and person-specific MFA-sensitive permission grants.
- Added prominent Microsoft Authenticator and Google Authenticator instructions, including that codes come from the app rather than email or text and that the QR code must be scanned inside the authenticator app.
- Preserved the existing `admin.users.invite` + MFA sending boundary, approved personal-email routing, blocked company-domain safeguard, branded email shell, and one-time temporary-password controls.
- Applied targeted production migration `20260823200000_mfa_aware_onboarding_email_targets.sql` and verified the installed database functions.
- Full validation passed: type checking, lint, 65 test files / 333 tests, and the production build.
- Deployed Cloudflare Worker version `38c0aa11-dbb2-4dbf-91ef-4d48e7cc1b43`; live health, readiness, and login-route checks passed.

### Professional title update

- Updated Jordan Brown's active SygShift title to `IT and Business Development Engineer`.
- Updated the branded Welcome email signature and stored Welcome announcement template to use the current title.
- Removed the former abbreviated title from the active Users & Access job-title guidance.
- Added a regression guard to keep the employee record, email signature, and active administration surface aligned.
- Applied targeted production migration `20260823193000_jordan_brown_title_update.sql`.
- Deployed Cloudflare Worker version `0b415a56-c5ac-412c-a60e-c65d00ef4e94`; live health, readiness, and login-route checks passed.

### Personal-first employee email delivery

- Made personal email the primary employee delivery address across onboarding, announcements, schedule publication, call-off alerts, and automatic clock-out notifications.
- Excluded `@guardianshipsecurity.net` during database recipient selection and retained the independent Worker-level provider suppression safeguard.
- Added preflight protection so login creation or temporary-password reset does not occur when an employee lacks an approved delivery address.
- Updated Users & Access recipient messaging and added routing, database-boundary, and Worker regression coverage.
- Applied targeted production migration `20260823190000_personal_email_delivery_routing.sql`.
- Deployed Cloudflare Worker version `9b5da939-b8f0-4686-b90c-a8bd88f19f0f`; live health, readiness, and login-route checks passed.

### Manual punch Site/Post completion

- Added a required Site/Post step directly to the supervisor-entered time event form so an authorized user no longer has to create a punch and then repair its location afterward.
- The form now separates employee-assigned shifts from other scheduled Site/Posts for the selected date and also supports a verified Other location when no schedule block applies.
- Punch and location are saved together in one audited database transaction; a partial save cannot leave a new punch without its chosen location.
- Preserved database-enforced `time.manage` permission and MFA requirements, append-only maintenance notes, original punch history, and the existing Site/Post correction workflow.
- Added unit, database-boundary, desktop-layout, mobile-layout, type, lint, full regression, and production-build validation.
- Applied targeted production migration `20260823170000_manual_time_event_site_post.sql`.
- Deployed Cloudflare Worker version `6b959ca8-ca47-411b-baa4-c96d700126a7`; live health, readiness, and application route checks passed.

### Overnight operational workday and Time Maintenance workflow

- Fixed Time Maintenance range filtering so an overnight occurrence stays on the workday and payroll week where it started, even when the clock-out occurs after midnight or outside the selected calendar-date boundary.
- Verified Daron Jones's 08/15/2026 11:00 PM through 08/16/2026 7:00 AM occurrence remains one 08/15/2026 workday, belongs to the week ending 08/15/2026, totals 480 paid minutes, and produces no missing-punch exception.
- Added operational workday context to each punch row so the physical punch date remains visible without misrepresenting payroll ownership.
- Made the employee's Needs Attention total open that exact employee and date range in Time Exceptions.
- Moved all punch correction choices into a centered, responsive modal that stays at the point of work and retains the existing audited correction functions.
- Simplified the employee punch table to five fixed-layout columns and removed the unnecessary horizontal scrollbar at desktop and phone widths.
- Clarified worked-versus-scheduled totals: only completed punches count as worked time, and actual clocked-out gaps remain unpaid without requiring a fabricated schedule break.
- Preserved existing MFA and `time.manage` enforcement, original punches, correction history, payroll rules, employee access, roles, and permissions.
- Applied and recorded production migration `20260823123000_time_maintenance_operational_workday.sql`.
- Full validation passed: type checking, lint, 59 test files / 312 tests, production build, and two Chrome viewport checks.
- Deployed Cloudflare Worker version `dcc75844-a009-4de2-b3ee-25dd75e0a456`.

## 08/22/2026

### Accountability Tracker

- Added a permission-controlled Accountability Tracker inside the Time Command Center for authorized operations users.
- Added factual occurrence entry for late arrivals, early departures, no-call/no-show events, and other documented attendance events.
- Kept sick reports and call-offs in Time Operations and time-off requests in their existing approval workflow.
- Added occurrence-specific review outcomes: confirmed, excused/protected, corrected, dismissed, voided, and reopened.
- Added an append-only decision history recording the actor, action, time, reason, and before/after state.
- Added schedule, worked-segment, unpaid-gap, variance, and time-rule context to each review without changing original punches.
- Limited negative reliability totals to reviewed and confirmed call-offs, no-call/no-show events, late arrivals, and early departures.
- Excluded protected sick time, vacation, excused events, dismissed events, corrected events, voided events, and open reviews from negative reliability totals.
- Kept hard payroll/timekeeping blockers in Time Exceptions instead of allowing them to be bypassed in Accountability Tracker.
- Updated the missing-clock-in grace period to 14 hours to support 12-hour operations before creating a missing-punch exception.
- Preserved all production roles, effective permissions, employee access, and individual overrides exactly.
- Added database, permission, UI-state, audit-history, and reliability-total regression coverage.
- Applied and recorded targeted production migration `20260822143000_accountability_tracker_workspace.sql`.
- Full validation passed: type checking, lint, 58 test files / 308 tests, and production build.
- Live health and readiness checks passed, and the protected route correctly redirected an unauthenticated browser session to sign-in.
- Deployed Cloudflare Worker version `f3a8c659-8836-4034-b9a5-14f71636fd59`.

## 08/21/2026

### Full permission enforcement and access preservation

- Made effective permissions authoritative for navigation, direct routes, protected page actions, Worker endpoints, database functions, row-level policies, and protected storage.
- Removed reviewed fixed-role authorization bypasses while preserving role names for defaults, labels, targeting, eligibility semantics, and protected Admin-role safety.
- Applied migration `20260821203000_permission_enforcement_integrity.sql` with a fail-closed transaction fingerprint over roles, grants, assignments, overrides, employee roles, and status.
- Verified the production before/after access projection matched exactly: 47 active employees, 6 roles, 64 permissions, no additional role assignments, and no person-specific overrides.
- Confirmed zero current row-level policies retain role-name authorization checks.
- Added central route policy tests, live access-boundary capture, and production access-preservation verification.
- Full validation passed: type checking, lint, 56 test files / 295 tests, and production build.
- Live smoke checks passed for the application and `/api/v1/health` with HTTP 200 responses.
- Deployed Cloudflare Worker version `abaa7292-382c-4c6d-b861-7bc1d5ed63e4`.

### Payroll review timeout repair

- Fixed the Payroll Export readiness failure caused by the full review exceeding the database statement timeout.
- Consolidated effective punches, corrections, voids, shift/location overrides, manual entries, occurrence identity, and payroll assignment into reusable set-based sources.
- Preserved occurrence-aware handling for incomplete, mapped, overnight, and multi-segment work without changing original punches or append-only audit history.
- Reduced the protected 08/09/2026–08/22/2026 production payroll review from approximately 34 seconds to approximately 3.2 seconds.
- Verified 196 returned rows, unchanged paid-minute totals, and passing reconciliation for the complete range and both individual payroll weeks.
- Added regression guards covering performance structure, complex occurrences, immutable identity, and audit preservation.
- Applied targeted production migrations `20260821173000_payroll_review_set_based_performance.sql`, `20260821174500_payroll_review_context_equivalence.sql`, `20260821175000_occurrence_context_effective_event_performance.sql`, and `20260821175500_set_based_occurrence_identity.sql`.
- Full validation passed: type checking, lint, 54 test files / 287 tests, and production build.

## 08/19/2026

### Audited punch type corrections

- Time Maintenance can now correct Clock In, Clock Out, Start Break, and End Break without voiding a valid punch.
- Original punches remain immutable; effective type, actor, reason, and approval details are stored in append-only correction history.
- Corrected types now drive clock state, attendance, reconciliation, payroll, exports, exceptions, and automation consistently.
- Void is explicitly reserved for duplicate or accidental punches.
- Added a regression guard covering authorization, audit preservation, database consumers, and the maintenance UI.

### Time Maintenance overnight and patrol clarity

- Fixed Time Maintenance so newer audited actions, including automatic clock-out history, cannot make the entire employee timecard unreadable.
- Ordered Time Maintenance employee choices by preferred/first name with username as a stable fallback.
- Grouped unlinked supervisor-entered clock-in/clock-out activity into a bounded work occurrence that can cross midnight without changing either original punch.
- Anchored unlinked overnight payroll assignment to the actual session clock-in, so a 10:00 PM to 6:00 AM occurrence remains assigned to the Sunday work/payroll week in which it began.
- Added Site Code to Time Operations Site/Post choices and explicit guidance to select the client/accounting location for patrol work.
- Applied targeted production migration `20260819123000_time_maintenance_overnight_and_patrol_clarity.sql` and recorded it in migration history.
- Production verification confirmed Joseph Lee's reported 10:00 PM to 6:00 AM pair remains two original events, one work occurrence, and one 08/09/2026 payroll-week assignment.
- Full validation passed: type checking, lint, 49 test files / 266 tests, and production build.
- Deployed Cloudflare Worker version `e5dbe73d-492e-4f74-8ec5-db2defbe60e4`.

## 08/17/2026

### Attendance-review performance and seven-day Schedule layout

- Fixed Daily Attendance Review date-range timeouts that could leave the missed-punch queue empty or incomplete.
- Added an optimized read-only snapshot for published schedule occurrences with no recorded activity while retaining the full reconciliation path for occurrences with punches, overrides, call-offs, or attendance events.
- Production verification for 08/09/2026 through 08/16/2026 returned 739 review rows, including 737 no-recorded-time occurrences and 35 distinct scheduled employees missing time, in approximately 4.4 seconds.
- Verified sampled optimized results exactly matched the existing detailed reconciliation output.
- Updated the desktop Schedule to fit the Site/Post column plus all seven days without horizontal scrolling, while preserving the dedicated mobile layout.
- Applied targeted production migration `20260817120000_attendance_review_missing_time_fast_path.sql`.
- Full validation passed: type checking, lint, 45 test files / 223 tests, and production build.
- Production health and readiness checks passed.
- Deployed Cloudflare Worker version `a0a18990-425b-404b-b99d-27e759dbf47b`.

## 08/16/2026

### Attendance review coverage consolidation

- Fixed Daily Attendance Review so identical published coverage slots no longer appear as repeated review cards.
- Consolidation is based on the same published schedule, Site/Post or event, start, end, time zone, and armed requirement.
- Repeated copies of the same employee assignment now remain one scheduled position instead of inflating the required headcount.
- Legitimately different employees assigned to the same coverage window remain separate people under one combined occurrence.
- The combined review preserves every underlying shift ID, employee assignment, worked segment, unpaid gap, call-off, punch, and audit record.
- Attendance decisions now resolve the canonical combined occurrence and remain protected by the current occurrence fingerprint.
- Applied targeted production migration `20260816170000_attendance_review_coverage_grouping.sql`.
- Production verification confirmed the reported MG Properties Patrol and Neon Local duplicate groups now calculate as one scheduled employee for one required position.
- Full validation passed: type checking, lint, 45 test files / 219 tests, and production build.

### Daily attendance reconciliation

- Added a next-morning review workspace that compares ended published shifts with effective SygShift punches and recorded call-offs after a two-hour grace period.
- Preserved the published schedule as the original staffing plan and preserved all original punches.
- Added planned-versus-actual employee lists, worked segments, unpaid gaps, schedule variance, call-off context, and plain-language rule explanations.
- Added controlled outcomes for replacement coverage, call-offs, uncovered work/client impact, legitimate variances, incorrect findings, and reopened reviews.
- Made review decisions append-only, audited, MFA-protected, permission-enforced, and specific to a fingerprint of the exact underlying occurrence.
- Kept incomplete or impossible punch sequences as hard correction blockers and linked authorized reviewers directly to Time Maintenance.
- Applied production migrations `20260816120000_daily_attendance_reconciliation.sql`, `20260816123000_daily_attendance_review_permission_alignment.sql`, and `20260816124500_daily_attendance_resolution_grace_guard.sql`.
- Full validation passed: 45 test files, 217 tests, type checking, lint, and production build.
- Production health and readiness checks passed.
- Deployed Cloudflare Worker version `00118503-b231-46fd-aea4-8ba789fbf2dc`.

## 08/13/2026

### Scheduled paid training

- Removed the global Post Time and Training Time setup from payroll review and removed its export gate.
- Made regular scheduled work the automatic default without requiring a payroll classification step.
- Added a Paid training time checkbox to Add Shift/Event and Edit Shift so training is identified where the schedule is created.
- Replaced visible Post Time terminology with Worked Time across employee time, exceptions, team attendance, payroll review, CSV, and Excel exports.
- Kept Paid Training separate in payroll totals and employee detail sheets while hiding empty training totals.
- Retained authorized, audited time-category correction for genuine classification mistakes.
- Applied and verified targeted production migration `20260813120000_scheduled_paid_training.sql` without changing existing shifts, punches, or payroll history.
- Full validation passed: 43 test files, 207 tests, type checking, lint, and production build.
- Production health, readiness, login route, and deployed asset verification passed.
- Deployed Cloudflare Worker version `f6410166-3c88-45cf-8ef3-2c28238ef816`.

## 08/12/2026

### Schedule name disambiguation

- Updated Schedule and Scheduler employee names so a one-character preferred name is never shown as an ambiguous initial-only identity.
- Employees with a normal preferred name continue to use it; for example, `Zachary` with preferred name `Zach` still appears as `Zach Ward`.
- Employees with a one-character preferred name now include the full first name and preference; for example, `Jainique` with preferred name `J` appears as `Jainique (J) Lee`.
- Applied the same rule to shift cards, assignment dialogs, employee selectors, staffing suggestions, and employee-specific training assignments.
- Added employee numbers to scheduling selectors and selected-assignment details as a second identity check when employees have similar names.
- Kept schedule and builder permission boundaries intact while extending the production database payloads.
- Applied and verified production migration `20260812153000_schedule_name_disambiguation.sql`.
- Full validation passed: 42 test files, 204 tests, type checking, lint, and production build.
- Deployed Cloudflare Worker version `245945a4-2071-4f5b-b57b-84e34b308263`.
- Verified production health, readiness, Schedule route delivery, and the live login surface without browser console errors.

### New User Invites permission

- Added the configurable `New User Invites` permission (`admin.users.invite`).
- Separated Welcome and Login Instructions email delivery from broad login-account management access.
- Added a dedicated onboarding-email card in each employee's Users & Access dialog.
- Added `Send new user invites` as the protected batch action for active employees who still need login accounts.
- Kept login creation, password resets, account disabling, MFA resets, and remembered-device controls under `Manage Login Access`.
- Enforced the new permission on all three Worker email routes, including individual welcome emails, individual login-instruction emails, and batch new-user invitations.
- Effective per-person denies are honored for these email routes even when the employee has an Admin app role.
- Granted the new permission to the protected system Admin role so existing Admin workflows continue after deployment.
- Updated the Users & Access directory permission boundary so custom roles or individual grants can use the invitation workflow without receiving login-security controls.
- Added regression tests for denied delivery, authorized delivery, route coverage, catalog registration, interface separation, and prevention of account-security changes by invite-only users.
- Applied and verified production migration `20260812133000_new_user_invites_permission.sql`.
- Full validation passed: 41 test files, 199 tests, type checking, lint, and production build.
- Cloudflare startup analysis passed with the current Wrangler runtime.
- Deployed Cloudflare Worker version `2fb56772-a659-4c83-bf52-83f80f03a536`.

## 07/31/2026

### Directory and Licensing Center workflow cleanup

- Widened the Directory profile modal so employee records have room to breathe on desktop while staying responsive on smaller screens.
- Removed credential/license management from the Directory profile modal.
- Kept scheduling availability inside Directory because schedulers need that information beside the employee profile.
- Replaced the old Directory credential summary with a clean profile snapshot focused on employment, role, title, contact, and schedule availability.
- Moved credential workflow ownership into Licensing Center:
  - Added an Employee List view for the licensing workflow.
  - Added a Credential List view for record-level review.
  - Added a cleaner employee licensing profile workflow where the licensing user selects one employee, selects one credential/license, and manages that item without scrolling through every credential card at once.
- Updated navigation so Directory no longer advertises credential-editing access. Licensing Center remains the credential workspace.
- Added guardrail tests to prevent credentials from being reintroduced into Directory and to protect the new Licensing Center employee/credential layout.
- Validation completed:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test` — 32 files / 143 tests passing
  - `pnpm build`
- Production deployment completed to `https://app.sygilant.us`.
- Cloudflare Worker version: `58d7a0cc-df54-4645-838a-97e86b405387`.

### Employee Overview, Break Controls, and Time-Card Correction Requests

- Reworked the Overview landing page so non-operations employees see a personal dashboard instead of company-wide operational totals.
- Employees now see simple cards for their next shift, their own time card, and time-card help.
- Operations/Admin/Supervisor/Scheduler/Dispatcher users still keep the broader operations metrics.
- Added a break action beside the time-clock action:
  - While clocked in: `Clock out` and `Start break`.
  - While on break: `End break`.
- Added employee time-card correction requests inside My Time:
  - Employees can request a correction from a recent punch or time-card row.
  - Requests preserve the original punch until reviewed.
  - Requests route into the existing pending time-correction workflow for supervisor/admin handling.
- Added UI guard coverage for employee Overview behavior, break controls, correction request wiring, and the supporting layout styles.
- Validation completed:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test` — 32 files / 142 tests passing
  - `pnpm build`
- Production deployment completed to `https://app.sygilant.us`.
- Cloudflare Worker version: `928240b6-4279-42f7-aa62-e84d7074ca2e`.

### Added employee-scoped schedule publishing

- Added a focused Scheduler workflow for publishing one employee's schedule without publishing the entire week.
- When the Scheduler is in Employee Schedule view and a specific employee is selected, SygShift now shows a
  `Publish [employee] only` action beside the normal full-week publish option.
- The scoped publish copies the selected employee's active draft assignments into a new live schedule revision
  while preserving the rest of the team's current live schedule.
- The remaining working draft is automatically rebased afterward, so other scheduler work stays in draft and is
  not accidentally pushed live.
- The normal full-week publish path remains available as `Publish full week`.
- The publish workflow now closes the employee week/full shift editing surfaces after a successful save/publish
  so users are not left inside stale windows.

### Production deployment

- Applied targeted Supabase migration: `supabase/migrations/20260731161500_employee_scoped_schedule_publish.sql`.
- Deployed Cloudflare Worker/site version `c6b8fbae-e5d3-4542-836f-f23dbdaf028a`.
- Live app: https://app.sygilant.us

### QA completed

- `pnpm vitest run src/schedulerBehaviorGuard.test.ts` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 31 files, 138 tests.
- `pnpm build` passed.

## 2026-07-27

### Added scheduler-safe shift removal

- Added a controlled “Remove duplicate/open shift” action to the Scheduler selected-shift panel.
- Added a matching “Remove from draft” action inside the full shift editor so the action is available from both scheduler workflows.
- Removal now uses a confirmation dialog with an optional note field, so schedulers can record why a block was removed.
- If a scheduler is looking at a live published schedule, SygShift opens a working draft first, removes the matching draft shift, and keeps the live schedule unchanged until the draft is published.
- Removed shifts no longer show on the Schedule/Scheduler board, no longer count in staffing suggestions, and no longer enter Events & Openings / Shift Pool.
- Pending requests attached to a removed shift are canceled, and active assignments are canceled with the removal reason.
- The database now keeps a soft-removal audit trail on shifts instead of hard-deleting operational history.

### Scheduler access/responsibility clarification prepared

- Prepared scheduler-facing guidance for Michael’s questions about duplicate shift cleanup, employee setup, contract/site setup, time editing, manual current-week schedule additions, and Denver license/armed credential ownership.
- Recommendation: Admin/Ops owns official employee setup and contract/site records; Schedulers maintain schedule coverage, assignments, open shifts, availability, and credential updates needed to schedule armed work.

### Production deployment

- Applied targeted Supabase migration: `supabase/migrations/20260727103000_scheduler_shift_removal.sql`.
- Deployed Cloudflare Worker/site version `764edcd1-bbc7-4951-a5e8-b5edfd85d0c0`.
- Verified live URL responded with HTTP 200: https://app.sygilant.us

### QA completed

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 23 files, 78 tests.
- `pnpm build` passed.

## 2026-07-23

### Added Flex employment and Directory-based availability controls

- Added `Flex` as a first-class employment type in frontend schemas, Users & Access, Directory, timekeeping, import mapping, operations metrics, Worker auth typing, and the Supabase enum.
- Moved practical availability management into the Directory profile dialog so schedulers, supervisors, and admins can manage a person’s credentials and scheduling availability from one place.
- Added a compact weekly availability snapshot to each Directory profile, plus a polished form for adding approved available/unavailable rules and removing active/pending availability rules.
- Kept the UI intentionally contained: no new sidebar clutter, no crowded card controls, and responsive styling for narrow screens.
- Added database-backed availability cancellation through `public.cancel_employee_availability`.

### Added availability override guardrails to scheduling

- Added inline availability conflict warnings when assigning an employee from the scheduler panel, full shift editor, or Add shift/event form.
- Schedulers/admins can override availability only by entering a written reason; the save button stays disabled until that reason exists.
- Added `public.schedule_assignment_overrides` so availability overrides are stored with shift, employee, note, actor, and timestamp for history/audit.
- Updated schedule assignment RPCs so the database rejects assignments against approved unavailable time unless an override note is supplied.
- Updated staffing suggestions so Flex employees are labeled and scored intentionally, while approved unavailable windows continue to exclude employees from automatic suggestions.

### Production deployment

- Applied targeted Supabase migration: `supabase/migrations/20260723143000_flex_directory_availability_overrides.sql`.
- Deployed Cloudflare Worker/site version `57d80885-0b71-4eb0-925c-f665398fa46a`.
- Verified live URL responded with HTTP 200: https://app.sygilant.us

### QA completed

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 23 files, 77 tests.
- `pnpm build` passed.

### Reconciled the July 26-August 1 operational schedule

- Loaded the scheduler-provided CSV for the upcoming 07/26/2026-08/01/2026 week into the live SygShift schedule.
- Published the corrected week as schedule revision 8 with 142 shifts.
- Replaced the older week data where the new CSV differed, because the scheduler sent the newer file as the source of truth.
- Added missing operational sites/posts needed by the new schedule data, including 3300 Tamarac, Stone Cliff, and Patrol-daytime PERA lunch/day-hit coverage.
- Removed stale schedule rows that were not in the new CSV week.
- Kept operational wording clean: no visible `Bible`, `Import`, or `Source` schedule notes remain in the published week.
- Preserved scheduling safeguards instead of forcing unsafe assignments. Unresolved people, missing armed credentials, and overlapping assignments were left open with plain review notes so a scheduler can resolve them intentionally.
- Added `tools/schedule-sync/reconcile_dispatch_csv.py` so this specific CSV reconciliation can be audited or rerun without hand-editing production data.

### Improved save feedback and immediate admin refresh

- Added a global progress cursor while database-backed saves are running, so users get immediate visual feedback that the system is working.
- Updated Users & Access employee create/update/enable/disable flows to refresh the open employee dialog immediately after save instead of requiring users to close and reopen it.
- Tightened the Availability form layout so date fields, repeat selectors, and save buttons stay inside the card without overlap on narrower screens.

### QA completed

- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 23 files, 77 tests.
- `pnpm build` passed.

## 2026-07-22

### Hardened button layout guardrails site-wide

- Removed the mobile rule that made every `.primary-action` full-width globally, which was the recurring
  source of action buttons stretching or crowding inside cards and toolbars.
- Added shared button safeguards: bounded width, stable line-height, wrapped approval/history action rows,
  and shrink-safe action children.
- Kept intentional full-width mobile buttons targeted to standalone page-intro, data-state, route-error,
  connection-banner, and direct request-form submit actions.
- Added `src/buttonLayoutGuard.test.ts` so the build fails if the global full-width button pattern or missing
  action-row safeguards are reintroduced.

### Corrected Availability-specific action layout

- Replaced Availability's remaining generic approval action wrapper with a dedicated
  `availability-card__actions` wrapper for approve/decline controls.
- Wrapped the Availability submit action in `availability-form__actions` so it is no longer caught by generic
  direct request-form button behavior.
- Updated `src/buttonLayoutGuard.test.ts` to fail if Availability regresses back to generic action wrappers.

## 2026-07-21

### Enlarged the scheduler shift editor

- Increased the Shift Edit dialog from roughly 610px to 920px wide on desktop.
- Consolidated date, start time, end time, and headcount into one row, with employee assignment and notes
  side by side, so the complete editor and action buttons remain visible without dialog scrolling.
- Preserved a single-column responsive layout for narrow screens so fields and buttons remain usable.
- The first deployment was rolled back after QA caught missing client-side Supabase configuration.
- Verified production deploy version: `521bfff9-0983-40b0-90b9-8095a54a2ad9`.

### Preserved legacy armed assignments when opening schedule drafts

- Issue: Opening any shift for editing could fail with an armed-qualification error, including unarmed and
  dispatch shifts, because draft creation revalidated every copied assignment in the week.
- Fix: An unchanged armed assignment inherited from the prior published revision can now be copied into the
  editable draft while certificate records are still being uploaded.
- Guardrails remain in place for new armed assignments, employee changes, changed shift blocks, and armed
  shift requests; those actions still require a valid armed credential for the shift date.
- Existing Bible-derived assignments were not removed or changed.
- Applied directly to production Supabase with migration
  `20260722003300_allow_inherited_legacy_armed_assignments.sql`; no Cloudflare deployment was required.

## 2026-07-16

### Added payroll rules and salary default payroll rows

- Added centralized payroll rules in Supabase:
  - Payroll week starts Sunday at 12:00 AM and ends Saturday at 11:59 PM.
  - Pay frequency is bi-weekly with a known pay-date anchor of July 17, 2026.
  - Daily OT starts after 12 paid hours in a day.
  - Weekly OT starts after 40 paid hours in the Sunday-Saturday payroll week.
  - Breaks are unpaid with a 30-minute typical break reference.
  - Salary employees receive a 40-hour weekly payroll default.
  - Approved time off reduces salary default hours.
- Payroll review now receives and displays active payroll rules.
- Salary employees now appear as `Salary default` payroll rows instead of fake clock punches.
- Payroll export CSV now includes row type, week start/end, regular hours, overtime hours, salary default hours, time-off deductions, and payroll notes.
- The payroll review default date range now opens on the active Sunday-Saturday payroll week.
- Overtime calculations avoid double-counting by allocating daily OT first, then weekly OT on remaining non-daily-OT hours.

### Added operations time maintenance workbench

- Added a live Time Maintenance workspace inside Time & Attendance for dispatcher/scheduler/supervisor/admin roles.
- Operations users can now:
  - filter employee time by date range and employee,
  - view detailed punch events,
  - add a missing supervisor-entered punch with a required reason,
  - prefill a related punch from an existing event so missing clock-ins/outs stay attached to the same shift when available,
  - change a punch time through an approved correction,
  - void an incorrect punch through an approved correction.
- Added Supabase function support:
  - `get_time_maintenance(date, date, uuid)`
  - `supervisor_record_time_event(uuid, time_event_kind, timestamptz, uuid, text, text)`
  - `supervisor_correct_time_event(uuid, timestamptz, boolean, text)`
- Added `public.time_event_maintenance_notes` so manual time work keeps actor, reason, action, timestamp, and audit history.
- Original punch records remain append-only; maintenance actions create auditable events/corrections instead of silently rewriting history.
- Fixed Add Missing Punch form layout so the button, reason field, and optional shift-link context do not crowd or drift.
- Payroll review rows now include a direct "Review / edit time" action that filters Time Maintenance to that employee/date and scrolls to the editable records.

## 2026-07-15

### Hid legacy import tools from daily navigation

- Import Review and Operational Import were removed from the normal sidebar because the Bible import has become legacy source data, not the operating system of record.
- The underlying pages/code/data were intentionally left in place as maintenance/reference tools if a future admin cleanup requires them.
- Production navigation now points users toward the live workflows: Schedule, Scheduler, People, Sites, Time-Off Requests, Events/Openings, Announcements, Time, and Reports.

### Fixed MFA remembered-device persistence

- Issue: "Remember this device for 14 days" still required MFA after each normal logout/login.
- Root cause: the browser trusted-device token was being cleared during regular sign-out.
- Fix:
  - Normal sign-out now keeps the remembered-device token so the next login can satisfy MFA with the trusted-device record.
  - Remembered devices are still removed by expiration, the user's Remove action, or admin revoke.
  - Account Security copy now explains that signing out does not remove a remembered device.
- Note: browsers that already lost the token before this fix must complete MFA one more time and check "Remember this device" again.

### Fixed time-off approval/decline permissions

- Issue: Approving/declining time-off requests failed with `permission denied for schema private`.
- Root cause: `public.decide_time_off_request` was still running as `security invoker` while the workflow depends
  on private account lookup helpers.
- Fix: Added migration `20260715100000_fix_time_off_decision_private_schema_permissions.sql`.
- New behavior:
  - Function runs as `security definer`.
  - Actor is resolved with `private.current_employee_id()`.
  - Only MFA-verified operations roles can approve/decline.
  - Decline still requires a decision note.
  - Approved time off blocks future scheduling through existing assignment guardrails.

## 2026-07-14

### Confirmed MFA requirement for operations roles

- Verified live Supabase `get_session_context()` requires MFA for:
  - Dispatcher
  - Scheduler
  - Supervisor
  - Admin
- Guards are not forced into MFA unless the policy changes later.

## 2026-07-09

### Priority operations workflow fixes

- Added `scheduler` role across app schemas/navigation/data access.
- Confirmed scheduler/dispatcher operational access uses MFA.
- Fixed Events & Openings access by moving to a controlled database payload.
- Added credential editing for guard license and armed guard credential in Users & Access.
- Added inactivity logout:
  - Warning at 8 minutes.
  - Logout at 10 minutes.
- Improved mobile MFA setup persistence when switching apps.
- Normalized main operational date displays toward MM/DD/YYYY.
- Time-off approval no longer forces current shift resolution before approval.
- Time-off decisions optimistically clear from the request queue and restore on failure.
- Past shift requests/call-offs are filtered out of action queues.

### Scheduler draft assignment fix

- Issue: Opening a schedule draft could fail with `schedules_week_revision_unique`.
- Root cause: draft creation picked the next revision from draft/published only, ignoring superseded/archived
  revisions that still occupy the unique `(week_starts_on, revision)` key.
- Fix:
  - `ensure_schedule_draft()` now locks by week and uses `max(revision)+1` across all statuses.
  - Manual assignment can open a draft and then apply the assignment instead of appearing dead.
- Production deploy version from that fix: `969c5668-81f4-4911-9b14-1e911b052534`.

## Standard QA before saying an update is done

Run these before deploy when code changes:

```powershell
pnpm lint
pnpm test
pnpm build
```

Deploy with:

```powershell
pnpm exec wrangler deploy --keep-vars
```

## 08/28/2026 — Home Time-Off Request Workflow

- Added a universal Home time-off request action for every authenticated user with an active employee record.
- Kept planned leave separate from urgent sick/call-off reporting.
- Added server-enforced Salary, Hourly, and Flex leave-type eligibility.
- Added affected-shift and estimated-hours review, immutable submission snapshots, audited reviewer decisions, and employee decision notifications.
- Reused the established Time-Off Requests queue, history, cancellation, permission, MFA, and audit boundaries.
- Added migration `20260828180000_home_time_off_request_workflow.sql` and full workflow regression coverage.
- Full validation passed: 95 test files, 485 tests, lint, type checking, and production build.

## 08/29/2026 — Announcements and Notifications Workspaces

- Rebuilt Announcements around Overview, Banner Alerts, and History & Acknowledgments.
- Added staged message creation, audience targeting, recipient-count previews, drafts, scheduling, controlled publication, expiration, and immutable recipient snapshots.
- Rebuilt Notifications as a grouped delivery center with bounded filters, focused detail, queued processing, and audited retries.
- Enforced compact lists throughout: 5-item work queues, 10-item history, selectable 5/10/20 pagination, and 5-result site searches.
- Added scheduled publication to the Worker and service-only delivery from the published recipient snapshot.
- Applied production migration `20260829120000_communications_workspaces.sql`.
- Full validation passed: 98 test files, 493 tests, lint, type checking, production build, database verification, deployment, and live route checks.
- Production Cloudflare version: `94fecbf4-5a09-49ad-b062-16a4af578018`.

## 08/29/2026 — FIDO2 Hardware Security Key Pilot

- Added optional FIDO2/WebAuthn hardware-key authentication after the existing username-and-password step.
- Preserved authenticator MFA as the fallback and left every non-pilot user's login behavior unchanged.
- Restricted the initial production pilot to `jbrown` through a server-enforced feature flag and allowlist.
- Fixed the production relying-party boundary to `sygilant.us` and accepted only `https://app.sygilant.us`; preview and `workers.dev` origins cannot use production credentials.
- Added **My Account > Security** controls to register, name, rename, inspect, and remove a physical key.
- Required fresh raw authenticator AAL2 before adding, renaming, or removing keys.
- Added browser-session-scoped security-key sessions bound to the current Supabase authentication session, with a maximum 12-hour lifetime and sign-out revocation.
- Added authorized User Accounts visibility, individual lost-key revocation, and MFA reset integration that revokes all keys and key sessions for the employee.
- Added security notices and append-only audit records for registration, rename, successful verification, removal, administrator revocation, and recovery.
- Added migrations `20260829163000_security_key_mfa.sql` and `20260829213000_security_key_pilot_controls.sql` and verified both production control functions.
- Full automated validation passed: type checking, zero-warning lint, 102 test files, 508 tests, Worker build, and client production build.
- The only remaining pilot step is the physical key ceremony and Chrome/Edge validation by Jordan Brown; the allowlist must not be expanded before that evidence is recorded.

## 08/29/2026 — HRIS Stage 1 Discovery and Security Foundation

- Completed the current-system inventory and authoritative source-of-truth map for the approved HRIS/HCM program.
- Defined HR data classifications, six isolated document-vault families, deny-by-default authorization, recent-MFA controls, audited break-glass requirements, recovery, maintenance, feature-flag, and rollback rules.
- Added a machine-readable foundation contract, validator, and regression tests.
- Kept the protected HR production-data gate closed until later stages supply their required authorization, quarantine, backup/restore, production-verification, and rollback evidence.
- No production database, employee data, role assignments, or deployed runtime behavior changed in this stage.

## 08/29/2026 — HRIS Stage 2 Employment Data Readiness

- Added a protected HR & Finance workspace for authoritative hire- and separation-date verification before any HR identity backfill.
- Enforced active identity, recent MFA, `hr.people.manage`, bounded server-side results, immutable evidence, future-date rejection, and closed-gate visibility.
- Kept all identity execution controls unavailable from the browser and left the production backfill gate closed.
- Preserved all 78 source employees and existing access, schedule, timekeeping, payroll, licensing, and audit relationships without creating protected HR identities.
- Applied migration `20260830013000_hris_stage2_identity_readiness_workspace.sql` and deployed Cloudflare version `9a31c43f-c457-40e0-9316-5a2a349cc3d1`.
- Full validation passed: 107 test files / 534 tests, type checking, zero-warning lint, production build, HRIS validators, live database checks, and Worker deployment.
