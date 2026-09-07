# SygSphere implementation and recovery

Date: 09/06/2026

## Baseline and stages

Baseline: `346d774` on `main`; `pnpm check` passed with 900 tests. Existing uncommitted changelog-location documentation is preserved separately.

1. Additive, membership-authorized messaging database and rollback-only database tests.
2. Branded launcher and responsive messaging workspace: direct conversations, groups, channels, threads, reactions, saved/pinned messages, search and drafts.
3. Separate messaging live updates, unread state, presence, typing and sound controls. No system/ticket notification or email producer is changed.
4. Private, malware-scanned attachments and usable sharing workflows.
5. Full regression verification, fresh production build, deployment, live checks and release documentation.

Each completed stage receives a checkpoint commit. A checkpoint is not a claim of production acceptance. Database changes are forward-only and additive; application recovery retains messages and memberships. Production is not enabled until the complete workflow passes its release gates. Recover application behavior with the recorded previous Worker version; disable the SygSphere database gate if isolation is needed. Never roll back by deleting conversations or operational data.

All five stages completed and production deployed on 09/07/2026 UTC. Release evidence, application fallback version, database verification and remaining boundaries are recorded in `docs/changelogs/CHANGELOG_09-06-2026_SYGSPHERE_MESSAGING.md`.

## Behavior and boundaries

- Active account holders can find and message other active account holders across roles.
- Private conversations require membership, including for administrators. No general administrative private-chat surveillance is introduced.
- New members receive conversation history, with an explicit warning before they are added. Removed members lose access immediately; previous authorship/history is retained.
- Unread badge counts conversations containing unread messages. Reading on one device updates the other devices. Messaging alerts never enter the existing notification bell or email queue.
- No automatic message purge. Editing/deleting one's own messages leaves revision evidence and a deletion marker. Group/channel owners manage membership; DMs cannot be silently converted into groups.
- Drafts and client caches are scoped to the signed-in employee. Network failures must not discard composed text or create duplicate sends.
- Voice/video, external guests and Microsoft calendar authorization are deferred. Normal meeting URLs can be shared; no fake calling controls or invented Outlook connection is provided.
- Existing authentication, MFA, Home clock controls, early-clock acknowledgement, time records, payroll, tickets and notification settings remain intact.

## Required release evidence

- Database transaction tests: membership boundaries, disabled accounts, cross-conversation replies, idempotent sends, DM uniqueness, read state, owner controls and private file gates.
- Actual UI tests at desktop/phone sizes, light/dark themes, keyboard use, drafts, send failures and thread navigation.
- `pnpm check` and actual-component `tests/e2e/time-clock-workflow.spec.ts` pass after final source changes.
- Fresh production build after browser tests, then deployment and health/readiness verification.
- Repository changelog and identical copy in `C:\Users\Jordan\Desktop\SygShift Changelogs`.
