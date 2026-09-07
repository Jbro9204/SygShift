# SygSphere Messaging

Date: 09/06/2026 (production release continued 09/07/2026 UTC)
Status: Database installed and verified behind disabled gate; final application release pending

## Delivered scope

- Always-visible branded SygSphere launcher above Need Help, with a separate unread-conversation badge, collapsed emblem, and compact mobile access.
- Searchable company account directory; direct messages, named groups and team channels; duplicate direct conversations are reused.
- Live conversation updates, threaded replies, visible-message read receipts, recent presence and typing, bookmarks, pins, reactions, search, and exact-message links.
- Account/conversation/thread-scoped drafts, explicit failed-send recovery, server idempotency, owner-managed membership, favorites, mute, and group/channel archive.
- SygSphere-only in-app popups and sound preference. No message email queue and no ticket/system notification producer changes.
- Rounded, padded light/dark desktop/mobile workspace with inherited readable typing fonts and bounded scroll areas.
- Private, membership-authorized PDF/image/text/Office file sharing, maximum 25 MB. Files remain quarantined until clean malware-scan evidence is committed; downloads reauthorize membership and stream through the Worker.

## Preservation and recovery

- Additive SygSphere database objects and one recipient-specific Realtime read policy. Existing operational functions are fingerprinted before the exact installation transaction and asserted unchanged before commit.
- Authentication, password-change and MFA requirements remain authoritative. Private chats are membership-only, including for Admin. New-member confirmation explicitly warns that conversation history and files become visible.
- No existing clock, scheduling, payroll, attendance, ticket or employee account record is rewritten. Test conversations and file metadata are enclosed in rollback-only database transactions.
- Checkpoints: `ec6ad36` implementation plan; `dcb30f2` database foundation; `4c692d9` workspace/live integration; `e4dc139` protected attachments. Concurrent committed employee-role improvements are preserved.
- Application fallback Worker version: `7b63ab4e-4e7c-4a50-aa51-d5a97d456a00`. If isolation is needed, disable `private.sygsphere_gate.enabled` and restore the recorded application version. Retain the additive schema, message history and memberships; never delete user data as rollback.
- The separately deployed employee-role visual refinement (`183456b`) and its release documentation were incorporated before the final combined checks, preserving the latest production interface.

## Verification

- Full `pnpm check`: TypeScript, lint, 923 unit/component/Worker tests, and production build passed.
- Full Playwright suite: 208/208 passed across desktop and mobile, including all 38 actual-component time-clock workflow checks and 12 SygSphere checks.
- SygSphere UI checks cover group creation, sending, draft reload, failed-send retry, real thread navigation, saved/search links, two-account live transport, separate badge, light/dark controls and no horizontal overflow. The two-account test uses controlled fixture transport, not messages sent to live employees.
- Database rollback rehearsals passed for membership denial, cross-conversation reply denial, duplicate prevention, read/search/save/revision evidence, recovery gate, service-only file completion, checksum evidence, clean-only downloads and removed-member file denial.
- Exact release/history-registration transaction also rehearsed with final rollback and existing-function preservation assertions.
- Static-markup races in licensing, role-library, employee-file and HR pagination fixtures were isolated from React's live root without changing those production workflows or weakening accessibility assertions.
- Added optional `PLAYWRIGHT_PORT_OFFSET` isolation for all test servers and fixture URLs, preserving default ports. The final combined run uses offset 1000 after another run's localhost server became unavailable; no other task's processes were stopped.

## Database and deployment

- Exact forward migrations: `20260907023825_sygsphere_messaging_foundation.sql` and `20260907025451_sygsphere_private_attachments.sql`.
- Standard database push detected pre-existing migration-history gaps. Old migrations were not replayed. The exact SygSphere-only installer registers the two new migration versions atomically with their schema changes.
- Both production migrations installed and recorded atomically; all existing operational function fingerprints remained unchanged. Installed-function rollback tests passed again after installation.
- Security audit: all 10 SygSphere private tables have RLS and no anonymous/authenticated direct table privileges; no anonymous messaging RPC; browser roles cannot complete file scans; the Storage bucket is private.
- Post-test production counts were zero conversations, zero messages and zero files, confirming no committed test chat data. The release gate remains disabled until application cutover.
- Release-gate enablement, Worker version, health/readiness and signed-in acceptance: pending, to be recorded after verification.

## Boundaries and usage

- Live alerts require SygShift to be open; this release does not deliver SygSphere closed-browser OS push. Browser audio may require user interaction and respects mute/volume.
- Voice/video, Outlook authorization/calendar synchronization, external guests, legal-hold/eDiscovery and configurable retention are deferred. Meeting links can be shared as normal URLs.
- Mention-name insertion is a composer convenience, not a separate mention-notification delivery system. Presence is recent activity, not a guaranteed employee availability status.
- Adding participants grants the full conversation history. Removed access cannot recall files already downloaded. Message deletion retains a marker and protected revision evidence.
- Instructions: `docs/operations/SYGSPHERE_USER_GUIDE.md`.
