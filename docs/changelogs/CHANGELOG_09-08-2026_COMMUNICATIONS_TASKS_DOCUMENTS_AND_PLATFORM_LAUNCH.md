# Communications, Tasks, Documents, and Platform Launch Release

Date: 09/08/2026

## Outcome

This release completes the approved SygShift communications and work-management run while preserving the existing scheduling, HR, payroll, patrol, notification, and time-clock workflows. It also installs the reciprocal Sygilant launch boundary so authorized employees can enter Sygilant from the permanent branded sidebar control without passing credentials through the browser.

## Support Tickets and Notifications

- Consolidated ticket creation into one **Ticket opened** notification/email instead of separate created and new messages.
- Routes operational ticket alerts to the exact effective role/permission owners, excludes the person who created the ticket from handler alerts, and uses Admin only as a fallback when no eligible handler exists.
- Normalizes the duplicate Closed lifecycle into Resolved while preserving existing ticket history.
- Added **Clear all** to the notification inbox. It dismisses ordinary notifications but preserves any unread item that still requires acknowledgment.
- Prevented the generic notification worker from claiming timekeeping, time-off, HR, or other queue rows owned by specialized processors.

## SygSphere

- Added authenticated Realtime delivery for messages, unread badges, mentions, and notification toasts, with bounded polling as reconnect protection.
- Added recoverable audible alerts using the supplied Franklin SygSphere tone. Browser-blocked audio now presents an explicit enable-sounds action and never double-plays during recovery.
- Added profile photos with initials fallbacks throughout conversations and participants.
- Added three local text-size choices and increased conversation-list readability without scaling the rest of SygShift.
- Added structured `@` mentions for valid conversation participants with targeted highlighting and notification delivery.
- Added private image, PDF, and bounded text previews plus audited private downloads.
- Added resumable scanned image uploads from over 25 MB through 100 MB for JPEG, PNG, and WebP. Other approved attachment types retain the established 25 MB protected limit.
- Preserved Enter-to-send and Shift+Enter-for-new-line behavior, draft recovery, retry, threads, search, saved messages, and independent SygSphere notification counts.
- Corrected narrow-phone overflow and kept the composer and Send control reachable when the mobile keyboard and full SygShift shell are present.
- Added a terminal-state safeguard so a completed clean file can never be returned to retry cleanup as deletion material.

## SygTasks

- Added SygTasks as an additive private work-management workspace with My Work, personal/team/company boards, list and kanban views, task owners, assignees, followers, status, priority, dates, labels, checklists, dependencies, comments, activity history, notifications, optimistic-version checks, Realtime refresh, and bounded pagination.
- Dispatcher, Scheduler, Supervisor, and Admin receive managed shared-board capability from the effective role system. Other active employees can use their own work and participate in shared boards according to membership and assignment.
- Preserved database-enforced visibility, immutable activity history, idempotent mutations, and direct-route authorization.

## Employee Records and Documents

- Added one privacy-safe employee email and one matching in-app notification when a write-up/corrective record is created or legitimately reclassified. The email links to the employee's universally available notification inbox and never includes restricted write-up details.
- Reworked Document Studio guidance so an authorized preparer can upload an outside document, choose or create the applicable active policy/template path, and send it internally for signature.
- Added employee access to preview and download the immutable completed signed PDF and its audit certificate.
- When a template has no placed signature field, finalization now appends a professional electronic-signature completion page so the employee's signature remains visibly represented in the signed PDF without altering the source document.
- Corrected signature database routines for unambiguous recipient resolution, qualified checksum generation, idempotent replay, and service-only grants.
- Increased the required audit-reason control size, contrast, and readability.

## Sessions, Roles, and Platform Entry

- Extended inactivity handling to a 55-minute warning and 60-minute sign-out, synchronized by employee across open browser tabs.
- Mapped Dispatcher to the protected `system_dispatcher` role and effective-permission model without mutating historical employee role values.
- Added the canonical transparent Sygilant sidebar launcher with the same expanded/collapsed behavior, spacing, keyboard access, and viewport reachability as the SygSphere launcher.
- Added a one-time, 60-second, server-signed SygShift-to-Sygilant launch with server-side introspection, protected session binding, exact issuer/audience/destination checks, replay prevention, independent secrets, and no password or session token in a URL or browser-readable storage.
- Scoped inbound shared identity to the exact `/sygsphere` destination; direct SygShift login, recovery, MFA, security keys, and native authorization remain unchanged.

## Database

Applied and recorded individually against the linked production project without using the unsafe broad migration history:

1. `20260908143000_support_notification_routing_and_session_foundation`
2. `20260908233000_sygsphere_experience_mentions_previews`
3. `20260909010000_sygtasks_work_management_foundation`
4. `20260909220000_employee_writeup_and_signature_delivery`
5. `20260909233000_sygilant_platform_shared_launch`
6. `20260910010000_scope_shared_identity_to_sygsphere`
7. `20260910020000_redact_clean_sygsphere_resumable_object_keys`

The reciprocal Sygilant-owned migration `20260908235900_sygshift_to_sygilant_shared_sessions` was also applied and recorded from the Sygilant repository before its consumer gate was enabled.

The three Sygilant-owned production versions `202609080001`, `20260908235644`, and `20260908235930` were preserved untouched. Before/after counts remained unchanged for support tickets, notification outbox rows, SygSphere conversations/messages, and signature envelopes; SygTasks began with zero boards as expected.

## Verification

- `pnpm check`: passed TypeScript, lint, production build, 207 test files, and 1,027 tests.
- `pnpm inventory:access`: passed with 36 navigation items, 66 routes, and 79 permissions.
- Full Playwright matrix: 236/236 desktop and mobile workflows passed.
- Mandatory Time Clock workflow: 38/38 passed, including the real Early Clock-In acknowledgment, clock-in, break, resume, clock-out, active-control restoration, multiple-shift selection, permission denial, and cross-page synchronization.
- SygSphere experience and notification-claim database rehearsals passed against production inside explicit rollback transactions.
- Disposable PostgreSQL rehearsal passed signature creation/action execution, idempotency, finalization, evidence, and grant boundaries.
- Global linked-database lint still reports older unrelated functions outside this release; none of the reported functions belongs to this change set. The changed functions compiled during transactional application and passed their exact database workflow regressions.

## Deployment

- SygShift source commit `48e4fcb1a13477ed40f3d3a6ea4b3c3b4632e94d` (runtime implementation `799f0a3`) was released as Cloudflare Worker version `ce87a2cc-7027-43b3-a0a7-12799e5a44cb` on `app.sygilant.us`.
- Live health and readiness returned HTTP 200. Readiness confirmed the asset binding, Supabase configuration, both inbound shared-identity secrets, both outbound Sygilant secrets, and provider/consumer key separation.
- The custom domain served the exact release asset `index-skssZa_a.js`, and the production content-security policy permits form submission only to self and the exact `https://sygilant.us` handoff destination.
- The live outbound launch boundary returned HTTP 401 without a SygShift session, HTTP 403 for a hostile origin, and HTTP 401 for introspection without the independent consumer authorization.
- Worker version `ce87a2cc-7027-43b3-a0a7-12799e5a44cb` completed its minute cron successfully after deployment. `service_run_timekeeping_automation` returned `completed` with no exception, and the remaining scheduled processors completed normally.
- The mandatory post-release Time Clock matrix passed all 38 desktop/mobile workflows on the deployed source commit.
- Reciprocal Sygilant runtime commit `6e05075` was released through Pages deployment `c5ca2023-a1f1-4503-af16-59f3a3dc6867`. Its custom domain remained healthy and rejected missing assertions, hostile origins, and unauthenticated sessions; subsequent documentation-only deployment `bfa25753-3e66-426a-8fc5-cfaa9be3b3cf` serves the same runtime bundle.
- A real employee handoff remains a user-present acceptance canary because no signed-in production employee session was available to release automation, and credentials were neither requested nor extracted. Both direct-login recovery paths remain available.

## Scope Boundary

SygTasks now covers the requested in-product assignment and tracking foundation. Recurring work, drag ranking, dashboards, task attachments, and external automation connectors remain later parity expansions rather than being represented as complete. Direct SygShift login remains available as the independent recovery and rollback path.
