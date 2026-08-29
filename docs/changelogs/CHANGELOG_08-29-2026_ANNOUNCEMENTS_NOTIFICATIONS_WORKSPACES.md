# SygShift Change Log — Announcements and Notifications Workspaces

**Date:** 08/29/2026  
**Status:** Released to production  
**Production URL:** https://app.sygilant.us  
**Cloudflare version:** `94fecbf4-5a09-49ad-b062-16a4af578018`

## Outcome

Announcements and Notifications are now two focused communication workspaces instead of long, recipient-by-recipient pages. Authorized staff can create, target, preview, schedule, publish, monitor, and retry communications while employees receive only the messages intended for them.

Every list is bounded. Work queues show 5 items by default, history shows 10 by default, and users may deliberately choose 5, 10, or 20 items per page. Site searches are limited to 5 visible matches. No communication workspace renders an unrestricted employee, recipient, delivery, or history list.

## Announcements workspace

- Rebuilt the page around **Overview**, **Banner Alerts**, and **History & Acknowledgments**.
- Added a staged composer covering template, message, audience, and preview.
- Added focused actions for **New Announcement** and **New Banner Alert**.
- Added targeting for everyone, roles, sites, qualified employees, and shift-eligible employees.
- Added email, employee-home, and workspace-alert delivery channels.
- Added draft, scheduled, published, and cancelled work-item states.
- Added recipient-count preview before publication.
- Added configurable employee visibility with a 14-day default expiration.
- Added immutable recipient snapshots so later employee or role changes do not rewrite the audience of a published communication.
- Added acknowledgment totals and bounded history instead of loading every recipient record into the browser.
- Kept onboarding and login-instruction emails outside the normal announcement composer.

## Notifications workspace

- Rebuilt Notifications as an operational delivery center grouped by message batch rather than by individual recipient.
- Added delivery summary cards, search, status, and date filters.
- Added bounded pagination with 5, 10, and 20-item page sizes.
- Added a focused detail modal for one delivery job at a time.
- Added authorized retry for one failed job or all eligible failed jobs.
- Added controlled processing for queued delivery work.
- Preserved server-enforced notification-management permissions.

## Delivery and automation

- Added scheduled publication processing to the Cloudflare Worker schedule.
- Scheduled announcements are published only when due and only once.
- Email delivery uses the exact recipient snapshot associated with the published work item.
- Added durable retry history for notification delivery attempts.
- The normal blocked-domain routing and personal-email preference remain enforced.

## Data and security controls

- Added announcement work items, recipient snapshots, retry events, and communication history contracts.
- Added protected RPCs for workspace summaries, work-item management, audience counts, publication, cancellation, history, grouped notifications, and retries.
- Added a service-only recipient lookup for Worker email delivery.
- Existing announcement, notification, employee, role, and permission records were preserved.
- Production migration `20260829120000_communications_workspaces.sql` was applied and its three primary protected RPC families were verified.

## Quality controls

- Added regression guards for bounded lists and pagination.
- Added tests for grouped notification jobs, recipient snapshots, delivery retries, scheduled publication, permission boundaries, and Worker delivery.
- Full validation passed:
  - TypeScript type checking
  - Linting with warnings denied
  - 98 test files / 493 tests
  - Production build
  - Production database RPC verification
  - Cloudflare deployment
  - Production root, Announcements, Notifications, health, and readiness route checks

## Rollback

The application can be rolled back to the preceding Cloudflare version while leaving the additive database objects in place. The migration does not remove existing communication data or alter existing role memberships. If a database rollback is later required, revert application callers before removing the new communication RPCs and tables.
