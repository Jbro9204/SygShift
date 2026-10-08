# Client Communications, Search, and SygSphere Viewport Repair

Date: 10/08/2026  
Status: Validated locally; production migration and deployment pending

## Outcome

This update makes internal client conversations easier to find without creating a second messaging system, keeps
the Client Directory search usable while results refresh, and confines SygSphere scrolling to message history so
the surrounding page no longer moves or leaves a large blank tail.

## Client Directory repair

- The directory keeps its current bounded results while a new search request is in flight instead of replacing the
  complete page with its initial-loading state.
- The search input therefore remains the same mounted control, retains keyboard focus, and accepts normal continuous
  typing without requiring the employee to click the field again after every character.
- A polite, screen-reader-only updating state reports the background refresh without disrupting the visible table.
- The oversized full-width Client File return bar is replaced with a compact, consistent Back to Client Files
  control.

## Internal Client Communications workspace

- Client Directory now has a dedicated Client Communications view, and each Client File has its own Communications
  tab.
- Authorized employees can search and page through linked conversations by client, client number, conversation, or
  operational purpose, then open the authoritative conversation in SygSphere or return to its Client File.
- Conversation candidates are searched and paginated independently. Only active, unlinked SygSphere conversations
  in which the employee currently participates are offered.
- Linking records the client, existing SygSphere conversation, operational purpose, actor, and time. Unlinking
  requires a reason and retires the relationship without deleting it, allowing a later audited reassignment.
- Direct-conversation labels resolve the other participant's current display name for the employee viewing the
  workspace.
- The SygSphere About panel shows the linked client shortcut only after the same protected relationship lookup
  succeeds.

## No parallel message store

- SygSphere remains authoritative for conversations, messages, attachments, members, read receipts, archives, and
  unread state.
- The Client Communications relationship does not copy message bodies or participant lists into Client Files.
  Latest-message preview and unread status are read from SygSphere only after current authorization is rechecked.
- Linking never adds or removes a SygSphere participant, sends a message, emails a client contact, or publishes
  anything to a future client portal.
- A client link is an internal operational shortcut, not a client-facing conversation.

## Permission and database boundary

- Added the exact, locked, MFA-protected permissions `clients.communications.view` and
  `clients.communications.manage`.
- Communications view requires live `clients.view`. Communications management requires live `clients.view`,
  `clients.manage`, and communications view; a base-permission denial therefore removes the dependent capability.
- Existing role cohorts inherit the matching Communications capability from their current Client Files capability.
  Deliberate person-specific Client Files grants are preserved through audited backfills without overriding an
  existing person-specific Communications denial.
- Role permission saves normalize the dependency chain in PostgreSQL, while the Access Control interface performs
  the same normalization before submission. Removing a base selection cannot leave a stale dependent capability.
- Reads and mutations additionally require an active account, AAL2, effective `sygsphere.comms.use`, the enabled
  SygSphere release gate, and current membership in the referenced conversation. Client Files or Admin access alone
  never creates chat access.
- `private.client_sygsphere_conversation_links` is forced-RLS and unavailable to browser roles. Narrow authenticated
  functions use a controlled empty search path, enforce bounded search/page sizes, and recheck permissions and
  membership at the database boundary.
- Link, unlink, permission-backfill, and role-save changes retain explicit audit evidence. Retired relationship rows
  are preserved rather than overwritten or deleted.
- A private forced-RLS request ledger binds every accepted operation to one actor, normalized payload, request UUID,
  and exact link generation. Matching retries are harmless; delayed link retries cannot resurrect a retired
  generation, and delayed unlink retries cannot retire a later replacement.
- The release generator requires exactly one explicit `--rehearsal` or `--release` mode and rejects missing,
  mistyped, or conflicting modes instead of defaulting to commit-capable SQL.

## Browser identity isolation

- Client Communications workspace, candidate, and SygSphere association caches are scoped by employee identity.
- Cached Client Communications and session context are removed on logout, account change, shared-session teardown,
  and inactivity logout. Previous-data placeholders cannot cross employee or Client File scope.
- This prevents a second employee using the same browser from receiving the prior employee's client or conversation
  metadata while a new authorized request is loading.

## SygSphere viewport and scrolling repair

- The SygSphere route now owns exactly one viewport through the deterministic `app-shell--sygsphere` layout chain
  instead of depending on a fragile `:has()` selector and exact DOM shape.
- The layout remains valid when one inert route-transition or error-boundary wrapper surrounds the workspace.
- The application header, SygSphere toolbar, conversation header, and composer remain stationary. Wheel and touch
  scrolling move only the message-history pane.
- Regression coverage uses the reported ultra-wide/short sizes (2410×643, 2359×714, and 2418×621) plus a
  1205×322 high-zoom equivalent, and verifies that the composer and Send control stay inside the viewport without a
  document-level scroll tail.

## Data preserved

This update does not rewrite or delete:

- SygSphere messages, files, reactions, receipts, drafts, threads, or members;
- Client Files, contacts, sites/posts, documents, activity, source rows, or publication state;
- employee identity, schedules, punches, time cards, payroll, attendance, tickets, or notifications.

The new relationship history is additive and forward-only.

## Verification completed so far

- `pnpm check`: **368 test files passed / 1 skipped; 2,065 tests passed / 1 skipped**, including strict TypeScript,
  zero-warning app/Worker lint, production builds, and the static-asset contract.
- Combined desktop/mobile browser release suite: **138/138 passed**, covering Client Files and Client
  Communications responsiveness, the reported SygSphere viewport sizes, message-history-only wheel scrolling, and
  the mandatory actual-component Time Clock workflow.
- Focused component coverage verifies continuous Client Directory typing, prior-result preservation during refresh,
  exact Communications permission gates, employee-scoped cache isolation, logout purging, candidate freshness,
  and stable retry request UUIDs.
- The linked-production rollback-only migration plus SQL regression passed with PL/pgSQL assertions explicitly
  enabled. Post-rehearsal checks confirmed that migration `20261008124500`, both private ledgers, and all fixtures
  were absent after rollback.
- SQL lifecycle regressions cover immediate and delayed link/unlink retries, unlink/relink generations, stale target
  rejection, request UUID payload reuse, RLS/grants, MFA, exact permissions, and current SygSphere membership.

## Release work still required

The following work remains pending and is not claimed as completed:

- apply and verify migration `20261008124500_client_sygsphere_communications_workspace.sql`;
- promote the intended source revision to `origin/main`;
- deploy the Cloudflare Worker and verify health, readiness, exact live assets, and authenticated Client
  Communications/SygSphere workflows.

## Deployment record

- Production database migration: **pending**.
- Source revision: **not yet promoted**.
- Cloudflare Worker version: **not yet deployed**.
- Production health/readiness and authenticated workflow verification: **pending**.

This record must be updated with exact migration, test, revision, Worker, and production-verification evidence before
the release can be described as deployed or complete.
