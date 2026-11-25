# Sygilant Requests — shared ticket foundation — 11/24/2026

Status: shared database migration installed and independently verified. The Sygilant application promotion is a separate release step. No production ticket, schedule, time, payroll, account or permission was changed. No test email was sent.

## Changes

- Added three narrowly granted queues, detail/eligible-handler, and action RPCs in migration `20261124231044`. The existing SygShift ticket UI, canonical APIs, ticket numbering, lifecycle, audit history, and delivery remain authoritative; no legacy endpoint or permission was replaced.
- Staff requests are scoped before search, totals, sorting, or pagination. IT, Cybersecurity, Finance, HR, Scheduling, Timekeeping, Operations, and Admin use existing app access, MFA, support grants, and applicable route permissions. HR alone can view confidential staff requests, and only when authorized for that route. Employees see only their own requests, across all categories, including their own confidential records.
- The workbench uses the canonical message and update operations. Ticket updates and transfers compare the full prior timestamp under the ticket lock. Matching retries return the original result via a private per-actor receipt; different content under a reused key or stale state fails explicitly. Receipts retain no message bodies.
- Transfers are limited to open, non-confidential, non-HR requests with no private note history, and require source and destination authority. The existing ticket number and public thread stay intact; an assignee carries over only if authorized for the destination desk. The reason is stored in the private audit, not the user-visible event. Transfers and internal notes do not queue requester messages.

## Verification and handoff

- `pnpm test:support-technology-native` runs as part of `pnpm check`. All 57 isolated PostgreSQL checks passed against the checked-in canonical ticket routines. Coverage includes count and title isolation, owner-only access, protected HR boundaries, exact route and MFA checks, handler eligibility, canonical add/assign/reply/note/resolve/reopen, safe transfer and repeat handling, audit and notification preservation, and complete synthetic transaction rollback. No production connections.
- The SygShift migration retry-safety scan passed for 424 sources, including all six immutable reviewed exceptions. The exact hosted rollback rehearsal left the 474-entry predecessor ledger intact and did not leave the candidate installed.
- Production activation added only migration `20261124231044` to the shared project, with 33 ordered statements (MD5 `058817cbce3d2a38b2232da50138bf4c`). Independent readback confirmed 475 entries, predecessor digest unchanged (`c708816466177bbdbca3566de418c50d`), installed ledger digest `25800ee0212550b0b0eabd6ef545c7fb`, exact authenticated-only entry points, and forced RLS on the private receipts. Existing support functions were fingerprinted and unchanged.
- Read-only production staffing counts found eligible handlers for all 13 existing request topics. No role assignments, route permissions, or notification configuration were changed. This migration does not require a new SygShift Worker bundle.
- Confirm the exact Sygilant production promotion and authorized/denied session boundaries separately. Do not create a live ticket just to test delivery. The existing SygShift ticket UI remains the fallback; if Sygilant must roll back, restore its previous verified build and retain all canonical ticket, audit, and receipt history.
