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

## 09/03/2026

### Future queue reconciliation

- Reconciled Jordan's 09/02 meeting list and related evening decisions against completed production work so finished releases were not placed back into the active queue.
- Added grouped future programs for remaining HR operations and advanced document capabilities, role governance, workforce reconciliation, client import and visibility, Patrol field validation, TrackTik migration, Sygilant shared identity and convergence, SigSales, and trademark research.
- Preserved the existing security, Duo, HR suite, employee-local time, mandatory required-actions, Client Portal, and Indeed items without duplication.
- Added a consistent execution-instructions block to all 16 active initiatives covering prerequisites, named decisions and source inputs, safe implementation order, canary and rollback expectations, operational validation, and closure evidence.
- Made no production, database, permission, employee, scheduling, timekeeping, document, or client-data change.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-03-2026_FUTURE_QUEUE_RECONCILIATION.md`.

### Scheduled Overtime Forecast report

- Added a dedicated Sunday-through-Saturday planning report that identifies employees assigned above 40 hours before the week starts, separates armed and unarmed coverage, and shows every contributing Site/Post shift and approval note.
- Uses the latest draft schedule when present and otherwise the current published revision. Supplemental Dispatch phone duty is excluded so concurrent phone coverage does not duplicate scheduled hours.
- Added an armed Flex capacity planning section with explicit availability-review language plus an audited three-sheet Excel export for management review.
- Protected report access with verified MFA plus `time.reports.view`; export additionally requires `reports.export`. Anonymous and PUBLIC function execution are revoked.
- Preserved all employees, schedules, shifts, assignments, punches, and payroll records. Migration `20260903154821` was applied and reconciled after rollback compilation and live read-only validation.
- Live validation for 09/06–09/12 found four projected-overtime employees, including two with armed coverage, totaling 45 projected overtime hours on published revision 3.
- Full validation passed with 162 test files / 777 tests, zero-warning lint, TypeScript, and both production builds.
- Pushed implementation commit `d989764` and workbook-presentation refinement `71e40c5`, then deployed Cloudflare Worker version `1421a6b9-18fd-4430-9353-61a7e126132e`. Authenticated production verification confirmed the report, shift-detail modal, and audited Excel download; primary and fallback health/readiness checks returned HTTP 200.
- Rebuilt the report header and controls after visual review: Back is now compact navigation, the title/export action share a balanced two-column header, filters align on one desktop grid, and the selected week/revision and calculation note use separate compact status rows. Responsive layouts were rendered at 1440px, 1024px, and 390px plus dark mode; all four checks passed without overflow or accessibility violations.
- Pushed presentation commit `6320175` and deployed Cloudflare Worker version `1b2fbf0c-b6a3-440a-a687-827def14c5d3`; primary and fallback API health/readiness and the report route returned HTTP 200, and the live stylesheet contains the new report layout system.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-03-2026_SCHEDULED_OVERTIME_FORECAST.md`.


### Concurrent Dispatch phone-duty assignment

- Classified the existing **Dispatch Phone Coverage** schedule source as an explicit supplemental duty and now permit it to overlap one normal Site/Post responsibility for the same employee.
- Kept ordinary physical-shift overlaps blocked. Dispatch with Dispatch and Dispatch with Training also remain blocked.
- Excluded the supplemental Dispatch duty from clock eligibility, new time-event creation, missing-clock exceptions, attendance alerts, and scheduled-overtime minutes so the same elapsed time is not counted twice.
- Added auditable assignment evidence and visible **Dispatch phone duty** labels throughout the Schedule views. No new pay premium, stipend, or compensation rule was inferred.
- Preserved all existing employees, shifts, assignments, punches, and historical Dispatch-linked time events. Migration `20260903132400` was applied and reconciled; direct database checks confirmed Dispatch + Post is allowed while Post + Post remains blocked.
- Full validation passed with 159 test files / 767 tests, zero-warning lint, TypeScript, and both production builds. Pushed commit `376a093` and deployed Cloudflare Worker version `8d0b8974-8f05-4985-b448-3ac830f315be`; primary and fallback health/readiness checks returned HTTP 200.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-03-2026_CONCURRENT_DISPATCH_PHONE_DUTY.md`.

### Scheduler Leave Unassigned repair

- Restored the ability to save a draft shift as **Leave open / unassigned**. A disabled scheduled-overtime preview had been reported as pending by the query client and was incorrectly disabling the save action even though no employee required validation.
- Scoped overtime preview pending/error enforcement to actual employee assignments and cleared stale overtime error/approval presentation when the assignment is removed.
- Preserved the existing server-side draft update, assignment removal, overlap, overtime, credential, availability, publication, and audit controls.
- Added focused regression coverage; full validation passed with 158 test files / 763 tests and both production builds.
- Pushed implementation commit `bf4e570` and deployed Cloudflare Worker version `e4d89663-837b-415b-8a5d-e41fa4995b98`. Primary and fallback application, health, and readiness checks returned HTTP 200.

## 09/02/2026

### Document Studio Human Resources access boundary

- Restricted the complete Document Studio to the exact `documents.workspace.view` permission, assigned by default only to Admin, Human Resources Manager, and Human Resources Employee. Other roles require an explicit grant.
- Replaced the employee-facing Document Library entry with a separate **My Documents** workspace containing only the signed-in employee's assigned forms, signature actions, requested uploads, previews, downloads, and completed records.
- Enforced the boundary in navigation, both management routes, employee-file/onboarding deep links, every management Worker handler, service-only database functions, the template catalog wrapper, and HR employee-file document summaries.
- Preserved self-service document endpoints and all existing employee, access, document, workflow, and signature records. Migration `20260903020750` verified record counts and permission fingerprints before commit.
- Full validation passed: TypeScript, zero-warning lint, 157 test files / 760 tests, both production builds, 23/23 focused access guards, and 12/12 responsive light/dark browser checks with accessibility validation.
- Pushed implementation commit `2f5b143` and test commit `ba190d9`, applied and reconciled the migration, and deployed Cloudflare Worker version `5ce97fd2-b8d7-4e21-b530-187b78b5fbac`. Primary and fallback application, health, and readiness checks returned HTTP 200; anonymous Studio API access returned HTTP 401.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-02-2026_DOCUMENT_STUDIO_HR_ACCESS_BOUNDARY.md`.

### User Account role assignment cleanup

- Replaced the duplicated **Role** plus scrolling **Additional access roles** presentation with a clearly labeled **Workforce role** and a compact **Department & management access** control.
- Built-in roles no longer repeat in the specialized selector. Assigned packages appear once as removable cards and remaining specialized roles use one bounded add-role dropdown.
- Removed the redundant **Primary Supervisor** line from employee summaries and directory rows when a named package such as Human Resources Manager is already displayed.
- Preserved the underlying workforce-routing and effective-permission model, every existing assignment identifier, audited atomic saves, and MFA-sensitive access controls; no database or employee record was changed by the release.
- Full validation passed: TypeScript, zero-warning lint, 156 test files / 755 tests, both production builds, and 4/4 focused desktop/mobile accessible browser checks.
- Pushed implementation commit `d15753f` and deployed Cloudflare Worker version `2f81d99f-f42e-4dd2-b8c0-7ede951d2d44`; primary and fallback app, health, and readiness endpoints returned HTTP 200 and the production User Accounts bundle contains the new experience without the legacy labels.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-02-2026_USER_ACCOUNT_ROLE_ASSIGNMENT_CLEANUP.md`.

### Protected PDF preview repair

- Replaced the final iframe-based protected PDF previews in Licensing Center and Client Files with the shared PDF.js canvas viewer already used by Document Studio and employee signature documents.
- Fixed Chrome's blocked-page failure without weakening the application content-security policy or changing private storage, permission, recent MFA/FIDO, business-reason, no-store, download, or audit controls.
- Added an explicit protected-PDF loading state, widened the Client Files preview modal, and added guards that fail if iframe previews return.
- Full validation passed: TypeScript, zero-warning lint, 156 test files / 755 tests, both production builds, and 20/20 focused desktop/mobile light/dark browser checks.
- Pushed implementation commit `fe9e99e` and deployed Cloudflare Worker version `0e57e4a9-ff51-4c06-bcb3-16c49fc501ad`; primary and fallback app, health, and readiness endpoints returned HTTP 200 and the production bundles contain the shared viewer with no iframe token.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-02-2026_PROTECTED_PDF_PREVIEW_REPAIR.md`.

### Protected Document Studio production activation

- Added an isolated Cloudflare Container running pinned ClamAV 1.5.4, a one-file Cloudflare Queue consumer, bounded retry/dead-letter handling, checksum verification, and automatic deletion of rejected quarantined objects.
- Added an append-only production release-evidence ledger. Core document gates can activate only after the same canary run proves a clean file, known-malware rejection, and private-storage write/read/delete/restore verification.
- Enabled company/shared HR records, automatic inventory refresh while scans are pending, and safe browser-readable previews for clean Word and Excel files while retaining the exact original for authorized download.
- Core activation covers the protected workspace, processing, and internal employee signature routing. OCR, native PDF editing/redaction/page operations, regulated-document automation, external signers, and organizational seals remain fail-closed because those separate capabilities are not implemented.
- Production canary `361b9d1e-b63a-41f7-bf21-2319ddd5837a` passed clean-file detection, EICAR rejection, and private-storage recovery using ClamAV 1.5.4. The document pipeline, workspace, processing, and internal-signature gates are now enabled; every HR storage bucket remains private.
- Applied and reconciled both production release migrations, deployed Cloudflare version `933343fe-3975-485c-bf3e-94c50aec835f`, passed post-deployment lifecycle canary `69fdc03a-2e27-43b9-a9de-a5b0a23d0063`, and verified primary/fallback health and readiness at HTTP 200. Validation passed TypeScript, zero-warning lint, 155 test files / 750 tests, both production builds, four targeted release guards, and eight responsive light/dark Document Studio browser checks.
- Advanced editing, regulated-document automation, external signers, and organizational seals remain fail-closed because those separate capabilities are not implemented; the production interface does not advertise them as operational. Full evidence is recorded in `docs/changelogs/CHANGELOG_09-02-2026_DOCUMENT_STUDIO_PRODUCTION_ACTIVATION.md`.

### Searchable Guardianship HR forms library

- Indexed all 56 controlled forms from the supplied Guardianship HR Template Library v1.0 with authoritative code, title, category, record class, purpose, source filename, sensitivity, role audience, and plain-language aliases.
- Added one shared, server-filtered catalog in employee My Documents and HR Document Studio, plus an all-employee **Document Library** navigation entry.
- Added search, category/audience filters, expandable details, and compact 5/10/20 pagination with 10 rows by default.
- Kept completed employee records separate and left protected file upload, preview, and download gates unchanged; entries remain **Indexed** until their canonical clean source is deliberately released.
- The production rollback rehearsal compiled the complete migration and rolled back all 56 catalog rows and schema objects cleanly while preserving 78 employees, two role assignments, zero overrides, and the existing zero-document baseline.
- Applied and recorded migration `20260902232050_searchable_hr_template_library.sql`, pushed implementation commit `7834464`, and deployed Cloudflare Worker version `915f4548-ab9e-40ab-94af-b755d466c542`.
- Full validation passed: TypeScript, zero-warning lint, 154 test files / 746 tests, production builds, and all 100 desktop/mobile browser checks. Primary and fallback health/readiness returned HTTP 200 and the anonymous library endpoint returned the expected HTTP 401.
- Full release status is recorded in `docs/changelogs/CHANGELOG_09-02-2026_SEARCHABLE_HR_DOCUMENT_LIBRARY.md`.

### My Time pay-period total alignment

- Repaired My Time's pay-period query order: employee views now load authoritative payroll rules first, calculate the anchored range from the trusted server timestamp, and only then request review rows.
- The displayed period now comes from the returned review boundaries, so a card can no longer be labeled with one date range while totaling another. Time Command Center employee totals use the same rule-first boundary.
- Read-only production diagnosis confirmed the report: the correct 08/23–09/05 range contains 2,406 paid minutes (40.10 hours), while the incorrect 08/30–09/12 fallback contained 1,206 minutes (20.10 hours). No production records were changed.
- Full validation passed: TypeScript, zero-warning lint, 152 test files / 737 tests, both production builds, and all 88 desktop/mobile Playwright checks.
- Pushed implementation commit `f33b19f` and deployed Cloudflare Worker version `f42d7e80-a378-44fc-ac57-acdad654064a`; primary and fallback login, health, readiness, and deployed asset checks passed.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-02-2026_MY_TIME_PAY_PERIOD_TOTAL_ALIGNMENT.md`.

### Patrol route edit and address persistence repair

- Repaired the existing-route branch of `save_patrol_route`, which rejected every route edit with PostgreSQL `42702` because the local `route_id` variable conflicted with the route-version column.
- Kept the versioned-route model, permissions, audit history, and public function contract intact while giving the local identifier a distinct name and qualifying the version lookup.
- Rollback-only production saves before and after release confirmed that an existing route advances to its next version and retains street, city, state, and postal code without leaving diagnostic data behind.
- Production remains unchanged at 2 routes, 2 versions, 11 current stops, and zero populated stop addresses; real addresses must be re-entered once now that saves work.
- Full validation passed: TypeScript, zero-warning lint, 151 test files / 734 tests, and both production builds. Applied and recorded migration `20260902214839_patrol_route_update_persistence.sql` and deployed Worker version `a0bf6721-4fc6-458d-bf7e-61c1beda9e0f`.
- Primary and fallback login, health, and readiness returned HTTP 200. Full details are recorded in `docs/changelogs/CHANGELOG_09-02-2026_PATROL_ROUTE_EDIT_AND_ADDRESS_PERSISTENCE.md`.

### Enterprise Document Studio and electronic signatures

- Extended the dormant secure HR document platform into one shared Document Studio with versioned policies, templates, field definitions, record associations, signature envelopes, signer consent/authentication evidence, saved signatures, exact-version finalization, immutable signed PDFs, and audit certificates.
- Added protected management and employee interfaces, a PDF.js viewer, compact bounded worklists, homepage pending-document actions, FIDO/authenticator step-up, retry/backoff/dead-letter processing, and audit-safe downloads.
- Kept upload, processing, signatures, advanced editing, regulated documents, external signers, and seals fail-closed. No HR document, template, envelope, signature, or role assignment was created during installation.
- True OCR, native PDF content editing, irreversible redaction, page restructuring, and malware release remain blocked on an approved document-processing/scanner service and recovery canary; no fake controls were exposed.
- Applied and recorded production migration `20260902202948_enterprise_document_studio.sql`; preservation verification retained 78 employees and the existing access/document baselines, confirmed all seven release gates disabled, all new private tables under row-level security, and zero browser-role access to the service routines.
- Full validation passed: TypeScript, zero-warning lint, 151 test files / 733 tests, production builds, and all 88 desktop/mobile Playwright checks. Deployed Cloudflare Worker version `387f7f00-1527-4e87-bb97-e313f3901eab`; primary and fallback health/readiness returned HTTP 200 and ready.
- Full details and final release evidence are recorded in `docs/changelogs/CHANGELOG_09-02-2026_ENTERPRISE_DOCUMENT_STUDIO_AND_SIGNATURES.md`.

## 09/01/2026

### Action Center active/history separation

- Added clear **Needs Attention**, **In Progress**, and **History** views to the Action Center. Completed records now leave the active queue while remaining permanently traceable.
- Added a protected, read-only history query over the authoritative announcement acknowledgment, training assignment, schedule acknowledgment, and HR workflow task records; no duplicate history store was created.
- Added search, action/outcome/date filters, 5/10/20 pagination with 10 rows by default, compact light/dark layouts, and a read-only detail modal with original context, employee, timestamps, resolver, resolution source/note, and applicable site/post information.
- Self history requires `actions.self.view`. Authorized team history requires current MFA and remains independently restricted by each source's management permission.
- Migration preservation checks confirmed zero action-record or access-control mutations. Production retained 693 schedule acknowledgment records and the existing role assignment/override counts.
- Full validation passed: type checking, zero-warning lint, 146 test files / 707 tests, both production builds, and 62 responsive light/dark browser checks.
- Applied and reconciled forward migration `20260902080000_action_center_history.sql`, pushed implementation commit `57a2d78`, and deployed Cloudflare Worker version `9dd4d714-f1df-4f8f-bcdf-cb16f80c7f3c`.
- Primary and fallback login, health, and readiness returned `200`; live authenticated smoke tests confirmed 10-row paginated history and active-only queue states.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_ACTION_CENTER_HISTORY.md`.

### Mandatory authenticated cursors and restored Human Resources Employee role

- Added one centralized six-state premium-gold cursor system for authenticated fine-pointer sessions: default, action, text, busy, move, and blocked. Signed-in desktop users cannot opt out; public login, touch/coarse devices, and forced-colors accessibility environments retain appropriate native cursors.
- Kept all assets local and 24 by 26 pixels, supplied semantic native fallbacks, preserved resize cursors, and added no JavaScript cursor follower, pointer tracking, animation loop, or dependency.
- Restored **Human Resources Employee** as the normal protected, MFA-required HR role with the exact original 78-permission scope and moved the one prior HR assignment back to it while preserving assignment metadata.
- Kept **Human Resources Manager** separate and unchanged with 110 enabled permissions and no current assignment. Migration assertions preserved every unrelated role, permission bundle, assignment, override, and catalog record and added private audit evidence.
- Full validation passed: type checking, zero-warning lint, 145 test files / 702 tests, Worker/client builds, and 60 desktop/mobile browser checks. Cursor-specific checks passed in Chrome, Edge, and Firefox, including forced-colors, coarse-pointer, scaling, and zoom coverage. Safari requires physical validation outside the Windows release host and retains native fallbacks.
- Applied and reconciled forward migration `20260902070000_human_resources_employee_role_split.sql`, pushed implementation commit `259c940`, and deployed Cloudflare Worker version `d4792c75-e14a-4579-a984-9d04984aeaa0`.
- Primary and fallback login, health, and readiness returned `200`; all six live cursor assets returned `200` as SVG, and the deployed JavaScript/CSS contain the authenticated trigger and centralized accessibility-safe mappings.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_AUTHENTICATED_CURSOR_SYSTEM_AND_HR_ROLE_SPLIT.md`.

### Human Resources Manager and role-category controls

- Upgraded the existing protected `human_resources` role in place to **Human Resources Manager**, preserving its role ID and existing one-employee assignment.
- Granted every current active HR & Finance permission plus supporting employee-lifecycle, licensing, communications, reporting, payroll-preparation, and time-management access; roles/security administration, maintenance/backend controls, destructive deletion, account-security administration, sites, patrol, and schedule management remain excluded.
- Production verification confirmed 110 intended permissions, 110 enabled, zero missing, and zero extra; the migration also verified that assignments, individual overrides, every other role, every other permission bundle, and the permission catalog were unchanged.
- Added category-level **Select all** and **Clear all** to Create Role and existing-role editing. Actions use the complete category even during a filtered search and preserve selections in unrelated categories.
- Full validation passed: type checking, zero-warning lint, 143 test files / 695 tests, access-control inventory, HR Admin baseline, Worker/client builds, and responsive desktop/mobile browser checks.
- Applied forward migration `20260902050000_human_resources_manager_complete_authority.sql`, reconciled only that exact migration marker, and deployed Cloudflare Worker version `ffbd5c87-b5e0-4f40-9758-c5a8710a25fc`.
- Primary and fallback login, health, and readiness returned `200`; the live Roles & Permissions asset contains the category controls.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_HUMAN_RESOURCES_MANAGER_AND_ROLE_CATEGORY_CONTROLS.md`.

### System-wide identity verification triggers

- Replaced protected-access MFA dead ends with one shared application-level identity checkpoint that opens automatically on explicit server `*_mfa_required` responses and retries the blocked action once after successful verification.
- Extended the verified FIDO-first/authenticator-fallback workflow across all Worker-backed HR modules, protected User Administration actions, notification processing, and attendance reporting while preserving the existing context-aware Licensing workflow.
- Coordinated concurrent protected requests behind one modal, rebuilt session/assurance headers for every retry, preserved entered state, and retained the existing 15-minute recent-verification boundary.
- Kept authentication and permission failures blocked, excluded raw `aal2_required` security-key management actions from automatic FIDO authorization, and made cancellation fail closed.
- Added a visible **Verify and retry** recovery action to the Employee File Compensation card for a dismissed or unsuccessful checkpoint.
- No database migration or production record change was required.
- Full validation passed: type checking, zero-warning lint, 142 test files / 693 tests, Worker/client builds, and all 52 responsive light/dark browser checks.
- Deployed Cloudflare Worker version `7ba88d1a-a665-4334-b979-e7bbc5c2e8c6`; primary and fallback login/health/readiness returned `200`, live bundle checks passed, and unauthenticated Compensation and Admin Security Keys routes returned `401`.
- Full details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_SYSTEM_WIDE_IDENTITY_VERIFICATION_TRIGGERS.md`.

### Identity verification and FIDO workflow repair

- Replaced protected Licensing document MFA dead ends with one forced identity-verification modal that supports a registered FIDO2 key and authenticator fallback.
- Preserved selected uploads and written access reasons, then automatically resumed list, upload, preview, or download after successful verification.
- Made account-security key discovery explicit and recoverable so a temporary lookup failure cannot silently hide a registered key or sign the employee out.
- Confirmed Jordan's existing production FIDO credential remains active; no re-enrollment or credential mutation was performed.
- Preserved password-first login, exact Licensing permissions, the 15-minute recent-MFA boundary, authenticator fallback, session-bound FIDO assurance, document audit evidence, and raw-authenticator verification before key-management changes.
- Full validation passed: type checking, zero-warning lint, 140 test files / 685 tests, Worker/client builds, and all 52 responsive light/dark browser checks.
- Deployed Cloudflare Worker version `85034419-a055-4554-9f23-a31611f48f4c`; primary and fallback login/health/readiness returned `200`, live asset checks passed, and protected unauthenticated Licensing and Security Keys routes returned `401`.
- Post-deployment verification confirmed one active and zero revoked keys for `jbrown`. The first physical key touch remains the final real ceremony check because production `last_used_at` is still empty.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_IDENTITY_VERIFICATION_AND_FIDO_WORKFLOW_REPAIR.md`.

### Secure Licensing Center document workflow

- Repaired the credential/license upload failure caused by the old browser-to-Storage RLS boundary by routing upload, list, preview, and download through one authenticated Worker workflow.
- Kept credential files private, removed direct authenticated Storage access, and exposed no storage paths or public URLs to the browser.
- Required exact Licensing or credential-editing permission plus recent authenticator or FIDO2 security-key verification; file access additionally requires a written reason and creates an append-only audit event.
- Added signature/MIME/extension validation, active-PDF rejection, 25 MB limits, SHA-256 checksums, idempotent upload requests, and hidden failed-upload states.
- Added compact five-row document lists with 5/10/20 pagination, responsive light/dark styling, upload progress, in-browser PDF/image preview, and download controls in the credential editor and employee licensing profile.
- Applied and recorded production migration `20260902030000_secure_licensing_document_workflow.sql`; its preservation assertions passed and post-apply verification confirmed five secure functions, no direct browser Storage policy, no browser service-RPC grants, and no existing licensing document/object to alter.
- Full validation passed: type checking, zero-warning lint, 139 test files / 680 tests, Worker/client builds, and all 48 desktop/mobile browser checks.
- Deployed Cloudflare Worker version `137f2bbb-03f8-4e41-9d9e-4734fce4d57a`; primary and fallback health/readiness returned `200`, protected licensing routes returned `401` without authentication, and the live bundle contains the new document workspace.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_SECURE_LICENSING_DOCUMENT_WORKFLOW.md`.

### Full Employee File editing, protected pay rates, and urgent red actions

- Replaced the former mostly read-only Employee File presentation with audited editors for legal identity, employee number, job title, Hourly/Salary timekeeping treatment, Full Time/Part Time/Flex classification, personal/company contact details, home address, and emergency-contact name, relationship, phone, and email.
- Kept start/hire and separation/termination dates in the established audited date editor and kept role, login, permissions, onboarding, leave, and offboarding data in their existing authoritative modules so the release did not create duplicate employee records.
- Required verified MFA, exact HR permissions, a written reason, server validation, and append-only audit evidence for every Employee File mutation; restricted contact information additionally requires `hr.people.restricted`.
- Released base pay only to exact compensation permissions through verified Worker operations sessions and recent MFA. Added effective-dated Hourly, Weekly, Biweekly, Semimonthly, Monthly, and Annual rates with independent maker-checker approval; Human Resources and Operations Manager roles did not receive compensation access.
- Added compensation permissions to the existing system Admin role, preserving the established requirement that Admin has the full permission catalog. No pay amount, work classification, contact, or emergency-contact value was inferred or backfilled.
- Restyled Clock Out and both Report Sick / Call-Off entry points with a shared rounded, raised red treatment, white content, strong focus state, hover lift, and pressed state in light and dark modes.
- Applied production migration `20260902010000_employee_file_editing_and_pay_rates.sql`. Its first attempt rolled back before commit after a preservation assertion referenced the obsolete `private.payroll_batches` name; the corrected migration used `private.payroll_export_batches`, applied successfully, and the remote migration check reports up to date.
- Preservation assertions verified employees, contacts, accounts, roles, individual permission overrides, schedules, time events, payroll export batches, compensation records/proposals/events, and non-Admin permissions were unchanged.
- Full validation passed: type checking, zero-warning lint, 138 test files / 676 tests, Worker/client builds, targeted Employee File, Stage 7 compensation, and Admin validators, plus 44 rendered desktop/mobile browser tests with accessibility and overflow checks.
- Deployed Cloudflare Worker version `ca7d270d-cea9-449d-bef2-0e86bb1679f1`; primary and Worker fallback health/readiness endpoints returned `200`, the production login rendered successfully, and an unauthenticated compensation request returned `401`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_EMPLOYEE_FILE_EDITING_PAY_RATES_AND_URGENT_ACTIONS.md`.

### Guard Licensing Status report

- Added a dedicated report under Reports for current, expiring, expired, not licensed, pending-review, and restricted guard-license states.
- Kept Licensing Center authoritative and used legal names only; no duplicate license record or alternate editor was created.
- Added active-guard defaults, status totals, focused filters, ten-row pagination, employee detail, and a direct route back to Licensing Center.
- Added a professional two-sheet Excel workbook with an employee summary and complete credential detail, frozen/filterable headers, status colors, and report-scope metadata.
- Excluded emails, phone numbers, notes, document contents, SSN, PHI, payroll, compensation, banking, and tax information from the workbook.
- Enforced `licensing.view`, verified MFA, and `reports.export` at the database boundary and added a private append-only export audit event.
- Applied production migration `20260901230000_licensing_status_report_export.sql`; preservation checks confirmed no employee, credential, role membership, or individual override changed.
- Full validation passed: type checking, zero-warning lint, 134 test files / 659 tests, Worker/client builds, 34 browser tests, and rendered workbook inspection.
- Deployed Cloudflare Worker version `604d6b83-bf35-4239-ae4f-1c1342255209`; the primary and Worker fallback health/readiness endpoints returned `200`, the release is active at 100% of traffic, and the live report bundle/style checks passed.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_GUARD_LICENSING_STATUS_REPORT.md`.

### Global operational time header

- Extended the single authenticated `AppShell` header with Eastern, Central, Mountain, and Pacific analog/digital clocks; no second header or alert system was created.
- Anchored the one-second display timer to the existing maintenance-status server timestamp, with automatic 30-second resynchronization through the shell's existing query. Browser time remains display-only and cannot authorize or record punches, payroll, patrol, or other secured events.
- Added cached IANA-zone formatters with dynamic daylight/standard abbreviations and zone-specific calendar dates.
- Added compact digital formatting that shows parenthetical 24-hour time only during `00:xx` and `13:xx–23:xx`, without changing established time formatting elsewhere in the application.
- Kept Mountain visibly identified as the operational default and preserved employee identity, My Account, Sign Out, sidebar, session, MFA, maintenance, update, and service-status behavior.
- Repositioned the existing rotating alert strip beneath the clocks with inset spacing, rounded containment, immediate text wrapping, and unchanged count, severity, permission, destination, and rotation behavior.
- Verified 1920, 1440, 1280, 1024 expanded, 1024 collapsed, 768, 390, and 320 pixel layouts with no horizontal overflow or clipped clock text. Reduced motion hides the decorative second hand while retaining digital information.
- Full validation passed: type checking, zero-warning lint, 132 test files / 653 tests, Worker/client builds, 32 full browser tests, focused responsive screenshots, and automated accessibility analysis.
- Deployed Cloudflare Worker version `f786e0dd-6337-48ab-9bdf-5bd0ffffafdf`; production app, login, health, readiness, main script, and stylesheet returned `200`, and the live bundle contains the four-zone header and responsive alert treatment.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_GLOBAL_OPERATIONAL_TIME_HEADER.md`.

### Unified editable employment-date workflow

- Removed the obsolete locked employment-date modal from Employment Data Readiness after HR reported that existing dates could not be clicked or corrected.
- Added one shared employment-date editor used by both Employment Data Readiness and the authoritative Employee File.
- Existing start/hire and separation/termination dates are editable from either entry point by MFA-verified users with `hr.people.manage`; every save still requires evidence and a written reason.
- Both entry points now use the same protected database transaction, permanent employee record, and append-only date evidence chain. No duplicate date record or alternate save path was introduced.
- Preserved schedules, punches, active clock sessions, time cards, payroll history, access records, and HR identity backfill controls.
- Added regression guards that reject a return of the legacy disabled inputs or the obsolete “permanent dates cannot be overwritten” notice.
- Full validation passed: type checking, zero-warning lint, 130 test files / 644 tests, Worker build, and client production build.
- Deployed Cloudflare Worker version `7f7d93c5-6cf7-4797-ade9-1cc2e1d925b5`; production app, login, health, readiness, shared editor, Employee File, and Employment Data Readiness assets returned `200`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_UNIFIED_EDITABLE_EMPLOYMENT_DATES.md`.

### Employee File employment-date maintenance

- Made start/hire and separation/termination dates directly maintainable from the protected Employee File Employment card.
- Required MFA-verified `hr.people.manage`, server validation, a verified evidence source, source reference, and a written reason for every change.
- Updated the permanent employee dates and appended a superseding record to the existing HR effective-date evidence chain in one transaction; no duplicate date-history table was created.
- Added a compact five-entry employment-date history with actor, evidence source, reason, timestamp, and current-evidence status.
- Allowed future start dates only for onboarding employees, required a termination date for separated employees, rejected impossible date order, and kept future separation planning in Offboarding.
- Preserved schedules, punches, active clock sessions, time cards, payroll history, employee access, and all other employee-file modules.
- Applied production migration `20260901210000_employee_file_employment_date_maintenance.sql` through an isolated one-migration workspace. The first syntax-validation attempt rolled back fully before any commit; the corrected migration then applied successfully and post-apply verification reported the database up to date.
- Full validation passed: type checking, zero-warning lint, 130 test files / 644 tests, Worker build, client production build, migration preservation assertions, and live application health/readiness checks.
- Deployed Cloudflare Worker version `742d6601-5182-4123-804e-c816ace33591`; production app, login, health, and readiness returned `200`.
- Removed the completed Employee File start/hire date item from the active future queue.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_EMPLOYEE_FILE_EMPLOYMENT_DATE_MAINTENANCE.md`.

### Continental U.S. employee schedule time zones

- Added employee profile time zones for Eastern, Central, Mountain, and Pacific operations.
- Personal Home, My Time, and Schedule views now use the employee's supported browser time zone, with the employee profile as the controlled fallback.
- Future one-person assigned shifts are entered in that employee's profile time zone; open and multi-person coverage continue to use the Site/Post time zone.
- Updated Zach Ward's employee profile fallback to Central Time without changing his existing shift, punch, workday, or payroll records. His existing 7:00 AM Mountain occurrence therefore presents as 8:00 AM Central while retaining the same absolute shift instant and clock-in window.
- Added transactional User Accounts time-zone maintenance, database audit evidence, shift time-zone provenance, and a migration preservation guard that rejects the release if any existing shift or time-event fingerprint changes.
- Applied production migration `20260901190000_continental_employee_time_zones.sql` through an isolated one-migration workspace after dry-run verification.
- Full validation passed: type checking, zero-warning lint, 129 test files / 640 tests, Worker build, client production build, production migration preservation checks, and live application health/readiness checks.
- Deployed Cloudflare Worker version `400b7dbe-cd07-4e6b-9d4e-7a7a5c8781cb`; production app, login, health, and readiness returned `200`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_CONTINENTAL_EMPLOYEE_TIME_ZONES.md`.

### Forced early clock-in acknowledgment

- Replaced the passive early clock-in guidance with a prominent red blocking dialog on both Home and My Time.
- Kept Clock In visible before the allowed window so an early attempt produces clear guidance instead of a disabled control or navigation detour.
- The dialog states the exact hours/minutes until the scheduled shift begins, shows the scheduled time and location, and can be closed only with **I understand**; there is no close button and Escape is ignored.
- Preserved the server-enforced five-minute clock-in window and all existing punch, schedule, workday, and payroll behavior.
- Added shared modal support for explicitly non-dismissible acknowledgment workflows without changing the default behavior of any existing dialog.
- Full validation passed: type checking, zero-warning lint, 127 test files / 634 tests, Worker build, and client production build.
- Deployed Cloudflare Worker version `a783fbe6-65ef-4234-aa08-43e9cddd2518`; the production login loaded with no browser console errors.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_FORCED_EARLY_CLOCK_IN_ACKNOWLEDGMENT.md`.

### Salaried missing-clock alert exclusion

- Excluded salaried employees from missing-clock-in operational exceptions and alerts at the database boundary because salaried staff do not use the shift punch workflow.
- Automatically resolved existing salaried missing-clock exceptions and cleared their live alerts while preserving the original exceptions and append-only action history.
- Added immediate reconciliation when an employee is reclassified to salary, plus a second database guard against direct missing-clock alert insertion.
- Preserved all schedules, assignments, punches, payroll records, employee records, and non-missing-clock alert types.
- Applied production migration `20260901170000_salary_missing_clock_alert_exclusion.sql` through an isolated one-migration workspace after dry-run verification.
- Full validation passed: type checking, zero-warning lint, 126 test files / 630 tests, Worker build, client production build, and production login/health/readiness checks.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_SALARY_MISSING_CLOCK_ALERT_EXCLUSION.md`.

### Human Resources role

- Added a protected, MFA-required Human Resources access role covering the ordinary employee lifecycle without granting Admin, Finance, payroll, compensation, or security authority.
- Included HR People, recruiting, onboarding, ordinary documents, leave, benefits, talent, learning, employee cases, non-medical safety, assets, offboarding, self-service, HR automation, reporting, licensing, communications, and limited account recovery.
- Excluded SSN/PHI vaults, identity/medical/financial documents, protected leave, compensation, total rewards, payroll integration/export/reassignment, security administration, roles/permissions, maintenance, schedule editing, and time correction.
- Preserved every existing role membership, individual override, role definition, and unrelated role permission bundle; assigned the new role to no employee and enabled no dormant HR release gate.
- Applied production migration `20260901150000_human_resources_role.sql` through an isolated one-migration workspace after dry-run verification.
- Full validation passed: type checking, zero-warning lint, 125 test files / 627 tests, Worker build, and client production build.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_HUMAN_RESOURCES_ROLE.md`.

### Operations Manager role

- Added a protected, MFA-required Operations Manager access role for companywide operational leadership between Supervisor and Admin.
- Preserved every existing employee role membership and individual permission override; no employee was assigned automatically.
- Included scheduling, attendance, patrol, sites/posts, licensing management, communications, reports, training, basic HR visibility, and limited account recovery.
- Excluded roles/security administration, MFA and security-key controls, maintenance/backend controls, protected HR, compensation, payroll integration, official payroll export, and locked payroll reassignment.
- Split audited employee password recovery into the exact `admin.users.password_reset` permission so operational support does not confer MFA or login-security administration.
- Applied production migration `20260901120000_operations_manager_role.sql` through an isolated one-migration workspace after a dry run proved no historical migration replay.
- Full validation passed: type checking, zero-warning lint, 124 test files / 624 tests, Worker build, and client production build.
- Deployed Cloudflare Worker version `eed799e3-b840-4b66-ab7b-d662e9895ceb`; production login, health, and readiness returned `200`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_09-01-2026_OPERATIONS_MANAGER_ROLE.md`.

## 08/31/2026

### Comprehensive Employee File

- Expanded the Employee File into a single secure index across identity, employment, documents, onboarding, leave, benefits, compensation status, talent, learning, employee relations, safety, assets, offboarding, and employee requests.
- Kept every fact in its authoritative module and routed authorized users to the owning workspace for changes, preventing duplicate employee records and competing editors.
- Added server-enforced permission and release-gate checks for every connected section; unreleased or unauthorized modules expose neither data nor counts.
- Kept compensation amounts out of the general Employee File and preserved anonymous-access denial at the database boundary.
- Applied and verified production migration `20260831234500`; confirmed 123 test files / 620 tests, type checking, linting, and production builds pass.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-31-2026_COMPREHENSIVE_EMPLOYEE_FILE.md`.

### Sidebar collapse tab refinement

- Moved the desktop collapse control back inside the sidebar brand area so it no longer protrudes into the workspace.
- Reduced the control to a compact gold rectangular tab that peeks inward from the sidebar edge.
- Preserved its accessible name, tooltip, keyboard focus, saved collapse state, and mobile exclusion.

### Sidebar collapse control and active-backlog cleanup

- Rebuilt the desktop sidebar collapse/expand control as a visible 44-by-44-pixel SygShift control attached to the sidebar edge, with consistent hover, active, tooltip, and keyboard-focus behavior.
- Preserved desktop collapse preference and the existing mobile navigation pattern without resetting routes or page state.
- Removed the completed My Time/Review Queue navigation and sidebar-collapse tasks from the active future-items list.
- Updated the FIDO2 pilot record to show Jordan Brown's physical-key enrollment while keeping only the remaining validation work active.
- Added a source regression test covering control placement, accessibility, and mobile exclusion.
- Full details are recorded in `docs/changelogs/CHANGELOG_08-31-2026_SIDEBAR_COLLAPSE_AND_BACKLOG_CLEANUP.md`.

### Duo authentication feasibility added to the active queue

- Added a separate High-priority feasibility and controlled-pilot item for evaluating Cisco Duo against the current Supabase Auth, Cloudflare Worker, PostgreSQL, authenticator MFA, remembered-device, recovery, and FIDO2 architecture.
- Required an explicit compatibility, security, privacy, licensing, outage, recovery, support, and rollback review before any production login change or user enrollment is authorized.
- This update changed planning documentation only; the existing SygShift login and MFA experience remains unchanged.
- Full planning details are recorded in `docs/changelogs/CHANGELOG_08-31-2026_DUO_AUTHENTICATION_FEASIBILITY_FUTURE_ITEM.md`.

### Enterprise breach-protection program added to the active queue

- Added an Urgent, eight-stage security-hardening program covering credential containment, Cloudflare perimeter protection, identity and session controls, database authorization, restricted-data handling, detection, secure releases, incident response, recovery, and governance.
- Kept the ordinary employee login experience unchanged as an explicit constraint while preserving privileged-role MFA and the Jordan-only FIDO2 pilot.
- This update changed planning documentation only; no production security setting or application behavior was changed.
- Full planning details are recorded in `docs/changelogs/CHANGELOG_08-31-2026_ENTERPRISE_BREACH_PROTECTION_FUTURE_ITEM.md`.

## 08/30/2026

### Protected Admin complete-permission baseline

- Established the protected Admin role as the complete administrative baseline for the active permission catalog: 135 of 135 permissions after adding 69 previously missing HRIS permissions.
- Confirmed both active Admin accounts inherited the baseline through their existing role without changing any employee identity, username, primary role, extra role membership, individual grant, or individual denial.
- Preserved every non-Admin role exactly as configured and kept all dormant HRIS release gates disabled; the access update did not activate unreleased modules.
- Added transactional production assertions, protected-role enforcement, a reviewed repair function, dedicated validation, and independent before/after production verification.
- Applied and recorded production migration `20260831210000`; confirmed 119 test files / 603 tests, type checking, linting, and production builds pass.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-30-2026_HRIS_ADMIN_PERMISSION_BASELINE.md`.

### HRIS Stage 8 talent, learning, cases, safety, and assets — dormant foundation

- Added private, row-level-secured foundations for talent and performance, learning and training, restricted Employee Cases, Safety and workers' compensation, and asset custody and reconciliation.
- Added compact permission-aware workspaces with bounded 5/10/20 worklists, exact server-side permissions, service-only database access, independent release gates, and recent MFA for Employee Cases and Safety.
- Applied and recorded forward-only production migration `20260831120000`; verified all five gates remain disabled, all 15 permissions remain unassigned, no individual override exists, and all five Stage 8 workspaces contain zero business records.
- Preserved existing employees and access assignments; no current user received a new route, permission, role, or navigation item.
- Confirmed 116 test files / 583 tests, type checking, zero-warning linting, Stage 8 validation, access inventory, access preservation, production builds, and Git whitespace validation pass.
- Deployed implementation commit `8a34f42` as Cloudflare Worker version `6ad77790-b974-4271-b8bb-31bdaaee2e85`; both production domains returned healthy and ready, login returned `200`, and unauthenticated Stage 8 APIs returned `401`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-30-2026_HRIS_STAGE_8_TALENT_LEARNING_CASES_SAFETY_ASSETS.md`.

### HRIS Stage 6 recruiting and onboarding — dormant foundation

- Added protected recruiting records for requisitions, applicants, applications, interviews, scorecards, offers, dispositions, and append-only recruiting history.
- Added duplicate-aware candidate conversion with two-person approval; conversion creates one onboarding-state employee record without creating login access or assigning permissions.
- Added reusable onboarding templates, task dependencies, cases, reminders, readiness evidence, and links to the existing User Accounts, Licensing, Training, equipment, document, and site-access systems.
- Added compact Recruiting and Onboarding workspaces, permission-controlled routes, service-only APIs, private row-level-secured tables, architecture documentation, and an activation/emergency-stop runbook.
- Applied and reconciled forward-only production migrations `20260831010000`, `20260831020000`, and `20260831030000`; verified 19 of 19 Stage 6 tables have RLS, all six permissions exist with zero role assignments, and both release gates remain disabled.
- Confirmed 113 test files / 565 tests, type checking, zero-warning linting, production build, Stage 6 validation, Cloudflare dry run, and post-deploy live boundary probes pass.
- Deployed implementation commit `b265c19` as Cloudflare Worker version `d33a4d9a-cfbf-4576-aaab-f5f2891feba7`; production health and readiness returned `200` and unauthenticated Recruiting and Onboarding APIs returned `401`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-30-2026_HRIS_STAGE_6_RECRUITING_ONBOARDING.md`.

### HRIS Stage 4 document workflows — dormant Run 4 completion

- Completed the Secure Document Platform lifecycle with service-only document requests, assignment review, exact immutable-version employee access, acknowledgments, signatures, and append-only request, assignment, completion, and access evidence.
- Added separate compact manager and employee workspaces with bounded 5/10/20-item pagination, focused dialogs, legal-name boundaries, and no unbounded document lists.
- Required clean scan state, active assignment, recent authenticator or security-key verification, and exact assigned document version before employee preview, download, acknowledgment, or signature.
- Preserved original files and versions; completion evidence is independent and immutable, and no workflow mutates or replaces a source document.
- Applied forward-only production migration `20260830200000_hris_stage4_document_workflows.sql`; the post-apply dry run reported the database fully up to date and the migration ledger recorded the new version.
- Kept the database release gate disabled, left `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED` unconfigured, and assigned no document permissions or employee documents. Manager and employee workflow boundaries return the expected closed-gate `503` response.
- Confirmed **112 test files / 562 tests**, type checking, zero-warning linting, all ten HRIS validators, both production builds, and Git whitespace validation pass.
- Deployed implementation commit `2ef6dd3` as Cloudflare Worker version `a2f3c1b9-64de-404e-a5b9-359dd092afe0`; live health and readiness returned `200`.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-30-2026_HRIS_STAGE_4_DOCUMENT_WORKFLOWS.md`.

### HRIS Stage 4 secure document pipeline — dormant Run 2 controls

- Added exact server-side validation for supported HR document formats, including extension/MIME/signature agreement, a 25 MB limit, active-PDF rejection, and macro/embedded/external Office content rejection.
- Added quarantine-only upload operations, append-only scanner evidence, an authenticated scanner callback, and explicit clean/rejected/error states.
- Added recent authenticator or security-key verification, permission-scoped one-time document access, hashed 60-second single-use tokens, and access-time revalidation of document version, clean scan state, active account, and vault permission.
- Added operating and rollback runbooks, the `check:hris-document-pipeline` release validator, and focused pipeline regression tests.
- Applied forward-only production migration `20260830120000_hris_stage4_secure_document_pipeline.sql` and verified 78 employees, 68 accounts, zero document/version/upload/access records, zero document permission assignments, and a disabled document release gate.
- Kept the Worker feature switch unconfigured and added no employee-facing document controls; the new platform remains dormant until scanner integration, UI authorization tests, recovery evidence, permission assignments, and controlled canary activation are complete.
- Confirmed 110 test files / 551 tests, type checking, zero-warning linting, both production builds, and both Stage 4 validators pass.
- Deployed release commit `1cdba1c` as Cloudflare Worker version `8a03d031-18bd-457f-9a98-b169049ff3df`; production health and readiness returned `200`, and an upload-boundary probe returned the expected disabled-gate `503` response.
- Full release details are recorded in `docs/changelogs/CHANGELOG_08-30-2026_HRIS_STAGE_4_SECURE_DOCUMENT_PIPELINE.md`.

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

## 08/30/2026 — HRIS Stage 5 Automation and Action Center

- Added a dormant, private HR workflow engine with immutable versions, instances, human tasks, reminders, escalations, due dates, append-only events, schedules, jobs, retries, and dead letters.
- Added bounded, idempotent Worker processing with concurrency leases and notification-outbox handoff.
- Connected eligible HR tasks to the existing Action Center and added a compact administrative workspace with server-side 5/10/20 pagination.
- Added separate HR automation view, manage, operate, and override permissions without assigning them to any current role or employee.
- Applied three additive production migrations and verified all nine new private tables have row-level security enabled.
- Preserved employee, account, role-membership, role-permission, and employee-override counts exactly.
- Kept the database and Worker release gates disabled; production contains zero workflow definitions, jobs, and tasks.
- Full validation passed: Stage 5 contract checks, type checking, zero-warning lint, 113 test files / 565 tests, production build, Cloudflare dry run, database verification, deployment, and live HTTP checks.
- Production Cloudflare version: `f7baf887-f7e1-4cd7-83bc-918094fef097`.

## 08/30/2026 — HRIS Stage 7 Leave, Benefits, and Compensation Foundation

- Added independently protected Leave Administration, Benefits Administration, and Compensation workspaces.
- Kept operational time-off requests authoritative and linked protected leave cases without duplicating employee requests.
- Added explicit downstream authorization records so a leave decision cannot silently change Schedule, Time & Attendance, or Payroll.
- Added separately protected medical and leave records connected to the private HR document vault.
- Added effective-dated benefits and compensation foundations with append-only event history.
- Required exact permissions for every workspace, recent MFA for Compensation, and database-enforced separation between compensation proposers and approvers.
- Added compact 5/10/20 worklists, private row-level security, service-only data access, and independent database and Worker release gates.
- Applied production migration `20260831040000_hris_stage7_leave_benefits_compensation_foundation.sql` with preservation assertions.
- Left all three release gates disabled and created no policies, balances, plans, enrollments, grades, bands, compensation records, proposals, or approvals.
- Assigned no Stage 7 permissions and changed no existing role or employee access.
- Full validation passed: Stage 7 contract checks, type checking, zero-warning lint, 114 test files / 571 tests, and production build.
- Deployed Cloudflare Worker version `47a38110-9c5f-4833-9420-d2ac77bc993a`; the live login surface returned `200` and all three unauthenticated Stage 7 API probes returned the expected `401`.

## 08/30/2026 — HRIS Stage 9 Offboarding, Self-Service, and Reporting

- Added protected separation and rehire cases, explicit approvals, preserved history, and auditable handoffs to User Accounts, Schedule, Payroll, Licensing, documents, training, and assets.
- Added permission-scoped employee and manager HR self-service foundations.
- Added permission-aware report definitions, schedules, asynchronous export runs, and append-only report history.
- Added nine exact permissions without assigning them to any current role or employee.
- Applied production migration `20260831160000_hris_stage9_offboarding_self_service_reporting_foundation.sql`; all three database and Worker release gates remain disabled and all Stage 9 workspaces remain empty.
- Preserved existing employee, account, role-assignment, schedule, and time-event records.
- Full validation passed: Stage 9 contract checks, type checking, zero-warning lint, 117 test files / 589 tests, Worker and client production builds, production database verification, and live health/readiness checks.
- Deployed Cloudflare Worker version `ed79e5e6-1f9d-4ab6-a148-92b93d3e81db`.

## 08/30/2026 — HRIS Stage 10 Payroll Integration Hardening

- Added a dormant, protected HR-to-Payroll integration control plane while keeping SygShift Payroll authoritative.
- Added versioned contracts, payroll-impacting proposals, maker-checker approvals, locked-snapshot reconciliation, immutable events, disabled HTTPS-only webhooks, rollback evidence, and enterprise verification runs.
- Added six exact permissions without assigning them to any current role or employee.
- Kept integration, webhook delivery, and enterprise cutover disabled in both the database and Worker configuration.
- Applied production migration `20260831200000_hris_stage10_payroll_integration_hardening.sql` with preservation assertions for access, schedules, punches, and payroll records.
- Full validation passed: Stage 10 contract checks, type checking, zero-warning lint, 118 test files / 597 tests, and production builds.
- Deployed Cloudflare Worker version `850b1311-73c3-4007-a512-c6688ac201b8`; the live login surface returned `200` and the unauthenticated Stage 10 API returned the expected `401`.
## 08/31/2026 — Active Admin Count Alignment

- Corrected the User Accounts Admin summary so it counts only active employees whose current primary role is Admin.
- Aligned the summary with the active account list and Role Library without changing any employee, role, permission, membership, grant, or denial.
- Preserved inactive and separated Admin-role records for audit history while removing them from the current-access headline.
- Added regression tests covering active and non-active employee statuses.
- Full validation passed: type checking, zero-warning lint, 122 test files / 615 tests, Worker build, and client production build.
- Deployed Cloudflare Worker version `9dee6d0a-6313-479e-90cc-f7d9b8ba925f`; production login, health, and readiness checks returned `200` and readiness was confirmed.

## 08/31/2026 — Sidebar Collapse Tab Placement

- Lowered the compact gold collapse/expand tab to the seam beneath the SygShift logo.
- Prevented the control from covering the brand mark in the collapsed sidebar.
- Preserved desktop keyboard access, saved collapse state, and the existing mobile navigation behavior.

## 09/01/2026 — Global Theme and Header Refinement

- Combined the approved full-site dark appearance and authenticated utility-bar refinement into one shared-shell release.
- Added flash-free OS-aware light/dark initialization, persistent explicit selection, dark login/security surfaces, and coordinated dark tokens for shared cards, forms, tables, modals, alerts, and statuses.
- Replaced the separate account controls with one photo/initials profile link and compact appearance/sign-out controls while preserving the existing account, clock, alert, session, and logout behavior.
- Removed the redundant Mountain-default sentence from the utility bar; the clock strip retains the explicit Mountain operational-default badge.
- Full validation passed: type checking, zero-warning lint, 135 test files / 663 tests, production builds, Wrangler dry run, and all 38 desktop/mobile Playwright checks.
- Deployed Cloudflare Worker version `b06bf981-bd42-4148-99d2-49be0968c254`; production app, login, theme bootstrap, health, and readiness returned HTTP 200 and readiness reported ready.

## 09/01/2026 — System-Wide Dark Theme Correction

- Replaced remaining light-only page and component surfaces with explicit light/dark color pairs across the full SygShift interface.
- Corrected white cards, translucent gradients, sticky bars, controls, tables, modals, and semantic states in Communications, HR, Time, Schedule, Payroll, Licensing, Reports, User Accounts, and Roles & Permissions.
- Removed broad class-name overrides that were flattening component-specific active, warning, success, and danger treatments.
- Preserved the exact existing light presentation and added an explicit compiled light-scheme boundary.
- Added source contract protection plus desktop/mobile rendered checks for dark surfaces, light preservation, contrast, modals, controls, semantic states, and horizontal containment.
- Full validation passed: type checking, zero-warning lint, 136 test files / 666 tests, production builds, and all 42 desktop/mobile Playwright checks.
- No migration or production-data change was required.
- Deployed Cloudflare Worker version `ed12f19f-9d55-40ed-9f3e-5d54b8bb5f0b`; production app, login, theme bootstrap, compiled stylesheet, health, and readiness returned HTTP 200 and readiness reported ready.
- Live explicit light and dark login renders resolved to the correct surface colors with zero horizontal overflow and zero console errors.

## 09/01/2026 — Scheduler Overtime Override Repair

- Corrected the new-coverage overtime warning so schedulers can see existing, added, resulting, and overtime hours plus the exact active shifts included in the calculation.
- Added the missing required approval-note field and preserved the existing audited override authority.
- Excluded canceled shifts and canceled assignments from overtime calculations.
- Made new coverage creation and assignment atomic, including employee-local-time coverage.
- Full validation passed: type checking, zero-warning lint, 137 test files / 671 tests, production migration, Worker and client production builds, deployed-asset inspection, and live health/readiness checks.
- Applied production migration `20260901233000_scheduler_new_coverage_overtime_override.sql` and deployed Cloudflare Worker version `d7c72a80-c078-4977-b9ac-a7720be6b0b4`.

## 09/02/2026 — Enterprise Patrol Operations

- Rebuilt Patrol as a connected operational workspace for guards, route managers, exception review, protected evidence, and reporting.
- Added versioned and editable armed/unarmed routes, Schedule-linked assignments, per-day hit requirements, optional time windows/location rules, makeup work, and separately tracked extra hits.
- Added meaningful required notes, configurable photo/video evidence, private signed resumable uploads, file-signature validation, protected audited preview/download, and configurable standard/incident video limits.
- Added compact 5/10/20 lists and Patrol Activity CSV, Excel, and PDF exports in Reports.
- Closed the full makeup loop with same-route assignment, a guard-facing completion action, and required/extra/makeup rows in reporting and exports.
- Bound evidence completion to the exact actor-owned private object authorized for that evidence record.
- Seeded the supplied MG Properties and Armed route information as editable drafts without inventing addresses or patrol times.
- Applied production migration `20260902110000_enterprise_patrol_operations.sql`; preservation assertions passed and production verified 2 draft routes, 11 stops, 61 requirements, a private evidence bucket, and 5 service functions.
- Added a focused forward hardening migration so Admin Patrol management follows the same recent-MFA permission boundary as every other privileged role.
- Full validation passed: type checking, zero-warning lint, 147 test files / 715 tests, and Worker/client production builds.
- Deployed Cloudflare Worker version `5c272129-50de-4b21-beac-b8279de4d070`; the app shell, Patrol route, health, and readiness checks returned HTTP 200 and readiness reported ready.

## 09/02/2026 — Supervisor Scope, My Time Readability, and Live Clock Roster

- Added an explicit, audited Assigned Supervisor relationship maintained from the Employee File without changing role or permission authority.
- Added My Employees, All Employees, Unassigned, and By Supervisor Directory views with a 10-row default and 5/10/20 pagination.
- Added a dedicated `/time/on-duty` roster for only currently clocked-in or on-break employees; Home and Team Attendance live-count links now open it instead of broad Time Operations.
- Increased shared Time snapshot label readability and renamed the employee Corrections label to Needs Review.
- Applied production migration `20260902160000_supervisor_scope_and_live_time_roster.sql` after a successful rollback rehearsal and verified both protected RPC contracts under an MFA-authenticated Admin context.
- Full validation passed: type checking, zero-warning lint, 148 test files / 718 tests, production builds, all 68 desktop/mobile Playwright checks, and focused Firefox coverage.
- Deployed Cloudflare Worker version `0530a0ad-e53d-46ea-92aa-b8e7d301b225`.

## 09/02/2026 — Enterprise Client Files

- Added a full Client Files workspace with client identity, contacts, lifecycle, renewals, billing channels, authoritative Site/Post links, editable Site/geofence details, and connected Schedule/Patrol/Event/service history.
- Added a private client-document vault with protected upload, in-browser preview, download, recent authenticator/security-key verification, contract/pricing separation, business-reason capture, and audit history.
- Added ten exact permissions, permission-aware navigation/routes, a Reports entry, audited CSV activity export, portal-ready publication states, and compact bounded lists throughout.
- Staged 261 nonblank rows from the supplied Sales workbook in a private checksum-controlled review queue without creating an operational Client File or changing existing Site, Schedule, Patrol, employee, Time, or Payroll records.
- Applied production migrations `20260902180918_enterprise_client_files.sql`, `20260902185602_client_activity_export_cap.sql`, and `20260902190456_client_document_mfa_volatility.sql` after successful rollback rehearsals.
- Production verification confirmed the schema, permissions, private bucket, source queue, and rollback-only MFA Admin workflow.
- Full validation passed: type checking, zero-warning lint, 149 test files / 722 tests, production builds, all 72 full Playwright checks, and eight focused Client Files desktop/mobile light/dark accessibility checks.
- Deployed Cloudflare Worker version `82e0fe7d-c0e7-4fb0-8ccb-b9d09776cd5d`.

## 09/02/2026 — Production Early Clock-In Restriction

- Replaced the incomplete client-side early-clock warning with one server-driven `EARLY_CLOCK_IN_BLOCKED` domain response and a mandatory premium alert dialog.
- Wired Home, My Time, and the Time & Attendance workspace header—including responsive layouts—to the same reusable workflow.
- Enforced the five-minute early window with trusted server time before punch insertion, allowed the exact boundary, and added deduplicated blocked-attempt audit records.
- Added precise timing and shift context, a single required **Acknowledge & close** action, focus management, Escape/backdrop protection, and post-acknowledgment guidance.
- Applied production migration `20260902194500_structured_early_clock_in_restriction.sql` after an isolated linked dry run.
- Full validation passed: type checking, zero-warning lint, 150 test files / 726 tests, production builds, and all 80 desktop/mobile Playwright checks.
- Deployed Cloudflare Worker version `ed096da4-e91a-4940-bfe6-f6657d76e44d`; production health, readiness, login, and release assets verified successfully.

## 09/02/2026 — HR Termination and Complete User Role Assignment

- Added a protected **Terminate employment** workflow to the authoritative HR Employee File, using the same account-separation engine as User Accounts.
- Added required date, reason, and exact-username confirmation while preserving historical employee, schedule, timekeeping, payroll, and account records.
- Enforced recent MFA plus exact HR management/offboarding permissions; blocked self-termination and protected Admin targets from non-Admin HR users.
- Replaced User Accounts' six-role assumption with the complete active Roles & Permissions library and an atomic, audited additional-role selector.
- Applied production migration `20260902222001_hr_employee_termination_and_user_role_assignment.sql` after a successful linked rollback rehearsal.
- Full validation passed: type checking, zero-warning lint, 153 test files / 741 tests, production builds, and all 92 desktop/mobile Playwright checks.
- Deployed Cloudflare Worker version `b6718bb1-20ef-462a-bcec-80aaf79a18a8`; both production endpoints passed health/readiness and the live release assets were verified.

## 09/02/2026 — Access Control Visual Refinement

- Replaced long sensitive-access confirmation lists with compact, expandable category summaries and a bounded internal review area.
- Added consistent modal cushion, a visible theme-aware scrollbar, responsive permission details, and stable confirmation actions.
- Corrected the Role Library layout so its scrollable list and **Create role** footer stay inside the card.
- Added explicit space before the **Rule of record** banner to prevent touching or overlap.
- Full validation passed: type checking, zero-warning lint, 153 test files / 742 tests, production builds, and all 96 desktop/mobile Playwright checks.
- No database, role membership, permission, employee, or authentication change was required.
- Deployed Cloudflare Worker version `6cc7bb2b-cdcb-4bd3-8a75-a7bac648b762`; production health, readiness, and live release assets verified successfully.

## 09/02/2026 — Time Self-Service Access Repair

- Restored My Time and Time Command Center totals for ordinary employees after the pay-period alignment release incorrectly called an operations-only, MFA-protected payroll-rule function.
- Added a narrow active-employee payroll-period context endpoint that returns only the server-resolved current range and non-sensitive calendar labels.
- Preserved the protected `get_payroll_rules()` authorization boundary and all existing clock, time-event, payroll, employee, role, and permission records.
- Production AAL1 verification returned the correct 08/23/2026–09/05/2026 period and eight own-time rows totaling 2,406 minutes for the reported employee.
- Full validation passed: TypeScript, zero-warning lint, 156 test files / 754 tests, and production Worker/client builds.
- Deployed Cloudflare Worker version `949aa361-be36-435d-be42-5431674002bd`; production login, repaired assets, health, and readiness verified successfully.
