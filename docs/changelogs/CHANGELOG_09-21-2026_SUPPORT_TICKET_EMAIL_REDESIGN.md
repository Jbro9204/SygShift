# Support Ticket Email and Notification Repair

Date: 09/21/2026

## Outcome

Repaired support-ticket delivery so authorized Administrators and route handlers receive both in-app notifications and email jobs. Ticket notifications now contain enough safe context to understand the request and its urgency before opening the protected ticket workspace.

## Root cause

The recipient function treated Administrators as a fallback. When any non-Admin employee qualified for a ticket route, Administrators were excluded from both the notification center and email queue even though they could still open the Support Tickets workspace.

## Notification experience

- Administrators, employees with the active System Admin role, and active handlers with the complete ticket and route permission set now receive the work.
- Notification titles include the ticket number, lifecycle event, and safe subject.
- Notification details include submitter, employee number, priority, status, category, subcategory, route, reported impact, and a useful summary.
- Every notification links directly to the exact protected ticket.
- Existing read, acknowledged, and dismissed states remain unchanged when notification details are refreshed.
- Recent open tickets that missed an authorized recipient under the old routing rule are restored through a bounded 14-day backfill without duplicating existing event-recipient jobs.
- The existing Realtime trigger and polling fallback continue to surface new inbox records without adding another notification system.

## Email experience

- Email subjects identify the ticket number, lifecycle event, priority, and safe subject.
- The email body carries the same useful operational context as the in-app notification.
- The complete ticket lifecycle supports new-ticket, reply, status, assignment, and update wording.
- A protected direct link opens the exact ticket after the normal authorization check.
- Plain-text delivery remains supported, and the prepared Worker presentation adds a compact mobile-friendly HTML layout when it is integrated with the active Worker line.

## Privacy and security

- Final recipient authorization is rechecked against the current ticket before an inbox record is written or an email job is claimed.
- Confidential HR or workplace tickets use protected wording and omit sensitive subject, summary, impact, source-page, and technical-context details.
- Internal notes remain excluded from employee email delivery.
- Database synchronization functions remain in the private schema and are revoked from public, anonymous, and authenticated browser roles.
- Ticket workflow state, access rules, retries, idempotency, and delivery history remain intact.

## Files

- `supabase/migrations/20260921182231_support_ticket_email_redesign.sql`
- `supabase/migrations/20260921185816_support_ticket_notification_detail.sql`
- `supabase/tests/support_ticket_email_redesign_regression.sql`
- `supabase/tests/support_ticket_notification_detail_regression.sql`
- `worker/index.ts`
- `src/worker.test.ts`
- `src/supportTicketEmailRedesign.test.ts`
- `src/supportTicketNotificationDetail.test.ts`

## Verification

- Focused ticket email and notification tests: 3 files / 52 tests passed.
- Full `pnpm check`: 293 test files / 1,532 tests passed, plus TypeScript, zero-warning application lint, and both production builds.
- Mandatory actual-component Time Clock workflow: 42/42 desktop and mobile checks passed.
- Production database migration dry run listed only the two asserted ticket migrations.
- Both migrations applied successfully to the linked production database.
- The next production email-processing cycle delivered 2 restored ticket notifications with 0 failures and 0 suppressions.
- Database security and performance advisors reported no new ticket-specific error finding.

## Release status

- Notification and email routing repair: live in the production database.
- Detailed in-app notification content: live.
- Restored email jobs: processed successfully by the active production Worker.
- Cloudflare application deployment: intentionally not performed, so the separate active SygSphere Worker release was not overwritten.
- Compact custom email HTML presentation: committed on the isolated branch and retained for safe integration with the active Worker line.

