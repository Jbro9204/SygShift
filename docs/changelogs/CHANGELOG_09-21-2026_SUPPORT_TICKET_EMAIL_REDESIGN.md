+# Support Ticket Email Redesign

Date: 09/21/2026

## Outcome

Prepared a compact, information-rich SygShift support-ticket email that lets an authorized recipient understand the request and its urgency from a phone or desktop inbox without opening the application first.

The implementation is isolated on `codex/ticket-email-redesign-20260921`. It does not alter or interrupt the active SygSphere communications worktree and has not been deployed to production.

## Email experience

- Replaced the oversized ticket-email masthead with a compact SygShift header so the ticket information begins above the mobile fold.
- Added clear lifecycle wording for new tickets, replies, status changes, assignments, and other updates.
- Added a concise email subject containing the ticket number, lifecycle event, priority, and safe ticket subject.
- Added a structured summary containing:
  - ticket number and subject;
  - priority and current status;
  - employee name and employee number;
  - submission date and time in the Colorado operating time zone;
  - category and subcategory;
  - authorized routing destination;
  - reported impact, affected headcount, and important date when supplied;
  - affected page;
  - friendly browser, device, and viewport context for technical requests; and
  - a direct **Open ticket** action tied to the exact permission-protected ticket.
- Applied the same structured presentation to the complete support-ticket lifecycle rather than only the initial opened email.
- Preserved a complete plain-text alternative for email clients that do not render HTML.

## Privacy and security

- Recipient selection, exact permission routing, idempotency, retry behavior, delivery history, and the final authorization recheck remain unchanged.
- The protected claim RPC remains executable only by the service role.
- Confidential HR or workplace tickets replace the subject and description with protected wording before the content leaves PostgreSQL.
- Confidential emails omit impact, source-page, and technical-context details.
- All dynamic values are bounded and HTML-escaped by the Worker.
- The direct link is constructed by the Worker from the validated support-ticket UUID and the configured trusted SygShift origin.
- Internal notes remain excluded from employee email delivery.

## Files

- `supabase/migrations/20260921182231_support_ticket_email_redesign.sql`
- `supabase/tests/support_ticket_email_redesign_regression.sql`
- `worker/index.ts`
- `src/worker.test.ts`
- `src/supportTicketEmailRedesign.test.ts`

## Verification

- Focused Worker and email-contract tests: 48/48 passed.
- Full `pnpm check`: 292 test files / 1,528 tests passed, along with TypeScript, zero-warning application lint, and both production builds.
- Mandatory actual-component Time Clock workflow: 42/42 desktop and mobile checks passed.
- Rendered email inspection passed at 390-pixel phone width and 900-pixel desktop width.
- Long content, HTML escaping, direct-ticket routing, priority presentation, device context, and confidential redaction have explicit automated coverage.
- `git diff --check` passed.

## Release status

- Migration: prepared, not applied.
- Cloudflare Worker: prepared, not deployed.
- Production data and delivery queues: unchanged.
- Active SygSphere communications task: untouched.

