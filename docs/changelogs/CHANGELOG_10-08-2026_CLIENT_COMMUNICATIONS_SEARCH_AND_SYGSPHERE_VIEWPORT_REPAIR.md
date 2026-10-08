# Client Communications, Search, and SygSphere Viewport Repair

Date: 10/08/2026  
Status: Deployed and verified in production

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
- The production-only blank tail was traced to the screen-reader presence label inside each direct-conversation
  row. Those labels were absolutely positioned against the document at wide desktop sizes, so a long inbox silently
  enlarged the browser scroll root even though the visible conversation list was clipped.
- Each presence label is now contained by its own conversation row. The SygSphere shell is also fixed to the dynamic
  viewport and both conversation-list and message-history boundary scrolling are contained.
- The application header, SygSphere toolbar, conversation header, and composer remain stationary. Wheel and touch
  scrolling move only the intended conversation or message-history pane.
- Regression coverage uses the reported ultra-wide/short sizes (2410×643, 2359×714, and 2418×621) plus a
  1205×322 high-zoom equivalent, and verifies that the composer and Send control stay inside the viewport without a
  document-level scroll tail.
- A realistic full AppShell regression overflows 36 conversation rows and 24 messages, verifies the accessible
  presence labels remain row-owned, and confirms the document stays exactly viewport-height.

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
- After the final live-only overflow cause was isolated, the complete SygSphere desktop/mobile suite passed
  **84/84**, including the full shell, oversized inbox, phone, mobile-keyboard, short-laptop, high-zoom, upload,
  image, thread, read-receipt, and composer workflows.
- Focused component coverage verifies continuous Client Directory typing, prior-result preservation during refresh,
  exact Communications permission gates, employee-scoped cache isolation, logout purging, candidate freshness,
  and stable retry request UUIDs.
- The linked-production rollback-only migration plus SQL regression passed with PL/pgSQL assertions explicitly
  enabled. Post-rehearsal checks confirmed that migration `20261008124500`, both private ledgers, and all fixtures
  were absent after rollback.
- SQL lifecycle regressions cover immediate and delayed link/unlink retries, unlink/relink generations, stale target
  rejection, request UUID payload reuse, RLS/grants, MFA, exact permissions, and current SygSphere membership.

## Deployment record

- Production migration `20261008124500_client_sygsphere_communications_workspace` was applied in one transaction.
  Postflight checks found one migration record, both private forced-RLS ledgers, the two protected permissions, five
  authorization-checked RPCs, zero browser table grants, zero invalid dependent roles, and no retained test rows.
- Installed production SQL regressions passed with PL/pgSQL assertions enabled.
- Source revisions `7937944` and final viewport containment revision `380e1c2` were promoted to `origin/main`.
- Cloudflare Worker version `418bdcbd-ad37-41bf-95af-8acc75c07949` was deployed to the custom and fallback origins.
- Health and readiness returned HTTP 200 / ready on both origins, including successful asset-binding and Supabase
  readiness checks.
- Both origins served the exact six-entry production asset set. The live bytes matched the release build for
  `/assets/index-C1Ij0oU-.js`, `/assets/index-2FDQBd7j.css`, `preload-helper`, `schemas`, `supabase`, and `useQuery`.
- Authenticated production verification confirmed continuous Client Directory typing retains focus, Client
  Communications renders without duplicating SygSphere data, and SygSphere now reports document `855/855` while its
  1,742-pixel conversation list and 7,901-pixel message history remain independently scrollable. The composer ended
  at pixel 834 inside the 855-pixel viewport.
