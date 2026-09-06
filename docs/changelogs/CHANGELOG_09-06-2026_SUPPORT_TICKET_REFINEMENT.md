# Support Ticket Lifecycle and Interface Refinement

Date: 09/06/2026

## Changes

- Ticket opening queues one email job and one in-app item per authorized recipient. Requester/handler overlap and retries share deterministic event-recipient keys. New browser submissions also carry a retry-safe request ID.
- Fixed the unconditional status email produced by assignment, priority, and unchanged saves. No-op saves create no activity or notification; priority-only edits remain audited. Actual status/assignment changes combine into one message when recipients overlap.
- Public replies include their automatic status transition in the same notification and retain before/after status evidence. Internal notes remain handler-only and queue no requester email.
- Added a delivery claim lease so overlapping processors cannot claim the same ticket email while it is already being processed. Existing provider, blocked-domain, retry, and delivery-audit safeguards remain unchanged.
- Fixed literal backslash-newline text in opening emails.
- Resolved is the single completion status. All other statuses remain available, including Assigned and Reopened in filters. Resolved tickets no longer remain in Open tickets. Legacy Closed requests map to Resolved; historical closure timestamps, messages, and original events are preserved, with normalization separately audited.
- Opening a ticket marks the matching personal inbox updates read. Ticket unread totals now use the unified inbox.
- Added consistent padding to Topic, Details, Impact, Review, and confirmation; rounded, readable inputs, selects, dates, and reply controls; and comfortable topic/impact cards.
- Added current-step highlighting, completed checkmarks, connecting arrows, short transition motion, and reduced-motion support. The ticket lifecycle displays actual status, handler/queue, next action, and latest update.
- Replaced monospace reply editing with the application font, normal-weight text, readable line spacing, and rounded conversation cards.
- Kept mobile pagination compact with side-by-side Previous/Next controls.
- Fixed the Continue-to-Review button reuse that could submit before the final Submit action. Pending submission prevents further editing, and failure retains the form. Ticket management failures now display a clear result, and reply state resets on ticket changes.

## Files and migration

- `src/components/SupportTicketForm.tsx`, `SupportProgress.tsx`, `src/pages/SupportTicketsPage.tsx`, `src/data/support.ts`, `src/lib/supportLifecycle.ts`, and scoped `src/App.css` styles.
- Forward-only migration: `20260906172200_support_ticket_lifecycle_and_delivery.sql`.
- Added SQL lifecycle/history regression fixtures, lifecycle unit tests, and an isolated real-component browser fixture with no production connection or email transport.

## Verification

- Final `pnpm check`: 176 test files / 841 tests passed; type checking, zero-warning lint, and production build passed.
- Playwright: 132 desktop/mobile checks passed, including real intake/reply interactions, validation and failure retention, both themes, accessibility, reduced motion, and measured progress/pagination/control bounds.
- Database: rolled-back linked rehearsal passed opening deduplication, retry behavior, unchanged/priority-only updates, combined replies, requester-assignee overlap, internal-note privacy, unrelated/anonymous/disabled-user denial, reopen behavior, queue filters, read synchronization, and delivery claim exclusivity.
- Seeded historical Closed fixture retained its original timestamps, message, and Closed audit event after normalization, with a separate normalization audit record.
- All seven changed database functions passed `plpgsql_check`; security advisor reported no error-level issues.
- No production test tickets or emails were committed/sent. Rolled-back submission tests may consume identity sequence numbers, leaving harmless ticket-number gaps.

## Release status

- Production migration applied with transactional before/after preservation assertions: 1 existing ticket, 5 messages, 9 events, and all delivery records retained. Registered only migration `20260906172200`; no older migrations replayed.
- Git push, deployment, and live health/readiness verification: pending.
- Live authenticated screen verification requires an active signed-in browser session; the available SygShift tab was signed out during preflight.
- Existing sent messages and notification/audit history are retained. Provider delivery remains an at-least-once transport: a provider-success/database-acknowledgment failure is still subject to the existing bounded retry policy.
