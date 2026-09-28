# SygSphere Unread Target Contract

Date: 09/28/2026
Status: Released to production

## Outcome

SygSphere inbox responses now identify the exact newest unread message for the
viewer, including the parent message when that unread item is a thread reply.
This lets Sygilant open content that can actually be viewed and acknowledged
instead of showing a badge for a hidden reply or older unloaded message.

## Root cause

The existing inbox correctly counted every unread message, but returned only the
latest message overall. The default message request returns root messages, so a
thread reply or an older unread root could keep the badge active without giving
the client a routable unread identifier.

## Changes

- Added forward migration
  `20260928010352_sygsphere_latest_unread_target.sql`.
- Added `latestUnreadTarget` to every listed conversation and to the inbox:
  `{ conversationId, messageId, parentId } | null`.
- Targets exclude the viewer's own messages, deleted messages, acknowledged
  messages, nonmember conversations, and conversations whose membership was
  removed.
- Preserved the canonical private messaging function, structured mention wrapper,
  fixed empty search path, authenticated-only execution, and every existing
  message/read row.
- Updated the rollback-only rehearsal builder to include the foundation,
  attachments, structured mentions, and unread-target migration chain.

## Security and data protection

- The global target joins the viewer's active membership. Per-conversation
  targets enrich only conversations already returned by the protected private
  list implementation.
- The response is metadata only. It does not expose message contents, expand
  membership, bypass MFA or permissions, or change receipt/history data.
- The migration is transactional with bounded lock and statement timeouts.

## Verification

- Independent migration review found no functional or security defect.
- `pnpm check`: 321 test files / 1,691 tests, strict TypeScript, zero-warning
  application/Worker lint, Worker build, client build, and static-asset contract.
- Mandatory Time Clock preservation: 42/42 desktop and mobile browser checks.
- SygSphere preservation: 72/72 desktop and mobile browser checks across phones,
  keyboard-height screens, high-zoom laptops, realtime messages, badges, threads,
  attachments, mentions, and the composer.
- The generated fresh and installed rollback-only SQL files each contain one
  outer transaction, no COMMIT, and one final ROLLBACK.
- The isolated linked-project dry run selected exactly the single unread-target
  migration.
- Database regression covers root/reply routing, newer own/read messages, unread
  reduction to zero, and nonmember/removed-member exclusion.

## Release status

- Production migration and Worker postflight are complete.

## Production status

- Applied and recorded migration
  `20260928010352_sygsphere_latest_unread_target.sql` in the linked production
  project after an isolated dry run selected that migration alone.
- Released source `6a35c05` as Cloudflare Worker version
  `3334c535-bc1f-47e1-adc3-f7c9509b2828`.
- Both `app.sygilant.us` and `sygshift.sygilant.workers.dev` returned HTTP
  200 for health and readiness after the release.
- Paired Sygilant source `8ba65af` is live as Pages deployment
  `aed55a46-29b2-4a39-a11c-a65b8f9e07a1`; its custom and immutable origins
  passed 13 page checks, 28 protected-read denials, one hostile-origin mutation
  denial, and 80 versioned asset checks.
- Remote rollback tag:
  `rollback/pre-sygsphere-unread-target-20260928`. The additive response
  metadata should remain installed if application source is rolled back.
