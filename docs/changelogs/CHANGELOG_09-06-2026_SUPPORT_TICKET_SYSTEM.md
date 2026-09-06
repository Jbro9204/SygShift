# SygShift Support Ticket System

**Released:** September 6, 2026

## What changed

- Added a persistent, rounded **Need Help?** button directly above the Online system indicator for every signed-in employee.
- Added a guided four-step support form covering topic, detailed issue information, operational impact, privacy, and final review.
- The form captures category and subcategory, subject, description, steps already tried, expected and actual behavior, related record details, affected people, timing, recurrence, work stoppage, safety impact, payroll impact, deadline, contact preference, confidentiality, the originating SygShift page, and safe browser diagnostics.
- Added clear emergency guidance and warnings not to enter passwords, Social Security numbers, banking details, medical documents, or other unnecessary sensitive data.
- Added a professional **Support Tickets** workspace under Administration for authorized ticket handlers. Ordinary employees retain access to their own tickets through the Need Help workflow without receiving an Administration menu.
- Added searchable, filterable, paginated queues; ticket detail; assignment; priority and status controls; employee-visible replies; handler-only internal notes; unread counts; and a complete event history.
- Added database-derived category routing so tickets reach the role permissions responsible for Scheduling, Timekeeping, Payroll, HR, Benefits, Training, Sites, Equipment, Safety, Accounts, Technical Administration, Client Files, or general Administration.
- Admin retains access to every ticket. Other handlers must have both ticket access and the permission for the ticket's routed operational area.
- Added in-app and system-email lifecycle notifications for submission, replies, assignment, and status changes. Internal notes are never emailed to the requester.
- Added append-only ticket events and existing audit-log integration for every submission, public reply, internal note, and management update.

## Security and reliability

- Ticket tables deny direct browser table access and are exposed only through authenticated, permission-checked database functions.
- Submitter identity, routed permission, priority, and timestamps are derived on the server rather than trusted from the browser.
- Confidential HR tickets are restricted to Admin and HR handlers.
- Notification emails use the existing audited Cloudflare delivery worker and employee email-safety rules.
- Email rendering receives plain text only so ticket content cannot inject markup into a system message.
- The initial release accepts structured evidence and related-record context. Binary attachments remain disabled until they can use SygShift's malware-scanned private document pipeline.

## Production verification

- Applied production migration `20260906125806_support_ticket_system.sql` through an isolated migration workspace that previewed only this release.
- Type checking and zero-warning lint passed.
- All 167 Vitest files and 801 tests passed.
- The production Worker and client builds passed.
- All 112 desktop and mobile Playwright checks passed.
- Live Worker version and endpoint verification are recorded below after deployment.

