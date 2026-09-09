# SygTasks Production Redesign

Date: 09/09/2026

Status: Production deployed and verified

## Outcome

SygTasks is now a complete, branded work-management workspace inside SygShift. The redesign keeps the existing SygTasks records, authorization model, notification behavior, and mutation contracts while replacing the original presentation with a responsive, accessible workflow for personal work, authorized boards, task creation, task detail, and board administration.

The permanent SygTasks launcher is first in the lower sidebar platform stack, followed by Sygilant, SygSphere, Need Help, and Online. It uses the approved SygTasks branding, supports the collapsed sidebar, shows a clear active state, and remains reachable at short laptop heights and 200% effective zoom.

## User experience

- Added the approved SygTasks logo and emblem as optimized transparent production assets.
- Added a branded workspace header, clear My Work and Boards navigation, and compact actions that remain usable in both themes.
- Added exact My Work summary cards for Current, Due Today, In Progress, Upcoming, and Completed This Month. Workforce date boundaries use `America/Denver`, and the client classifies dates from the server-provided time rather than the browser clock.
- Added the complete authorized-board selector without a 100-board truncation, board metadata, task counts, and permission-aware Create Task and Board Settings actions.
- Added server-backed search across task title, description, board, assignee name, username, and labels, plus intersecting status and priority filters.
- Added exact result totals, status/priority counts, bounded page sizes, Previous/Next navigation, and clear empty, loading, unavailable, and error states.
- Added responsive List and Board views with readable task cards, semantic status/priority/due states, labels, assignees, and compact controls.
- Added rounded, uniformly spaced Create Board, Create Task, Task Detail, and Board Settings dialogs with inline validation, keyboard dismissal, focus restoration, busy-state protection, and mobile-safe scrolling.
- Added permission-aware assignment. Managers can use the authorized employee list; non-managers can assign only themselves. Existing assignees remain visible when opening a task.
- Preserved task status, priority, due date, assignees, watchers, labels, checklist, dependencies, comments, activity, board membership, archive behavior, and Realtime invalidation through the existing domain APIs.
- Added stable retry identities for board and task creation so a lost response can be retried without creating duplicate work. Changing the submitted payload rotates the client request identifier.
- Added Back/Forward synchronization between My Work and board URLs.
- Increased frequent action targets to at least 44 pixels and verified keyboard access, focus visibility, accessible names, contrast, overflow containment, and 200% reflow.

## Database and authorization

- Applied additive migration `20260910100000_sygtasks_redesign_data_contract.sql` with SHA-256 `DA02E7D6DF57058A6F1C15276EE388691DE20FE238FBDD3680A562B3B733E43A`.
- Added `public.get_sygtasks_worklist(...)` for exact authorized summaries, board payloads, search/filter counts, and bounded task pages.
- Added `public.create_sygtasks_task(jsonb, uuid)` for atomic create-and-optional-assignment with advisory locking, request fingerprints, deterministic inner request identifiers, and stored-response replay.
- Added the partial completed-task index `private.sygtasks_tasks_completed_idx` for monthly completion summaries.
- Browser execution is granted only to `authenticated`; `anon` cannot execute either public RPC. The private My Work predicate remains unavailable to both browser roles.
- Personal boards remain owner-only even for a different employee with `tasks.manage`. Team and company visibility continue to follow effective permissions and board membership.
- The migration does not update or delete existing boards, tasks, employees, roles, permissions, schedules, time events, payroll, HR, ticket, or SygSphere records.
- No environment variable, secret, storage-bucket, or external-service change was required.

## Database release method

The repository has known remote-only migration history, so a broad migration push was not used. A fresh isolated Supabase workdir was populated from the current remote migration ledger, and only `20260910100000_sygtasks_redesign_data_contract.sql` was added. The pinned CLI `2.117.0` dry run named exactly that one migration. The same isolated workdir then applied it, and the database recorded one matching history row atomically.

Post-apply verification confirmed:

- one migration-history row named `sygtasks_redesign_data_contract`;
- both exact public RPC signatures;
- a valid `sygtasks_tasks_completed_idx` index;
- authenticated execution and anonymous denial;
- no browser execution on the private predicate; and
- the complete live contract suite passing inside a final rollback.

The rollback-scoped production contract proves cross-owner personal-board denial for both another manager and an ordinary employee, exact filtering and pagination, label search, assignment authorization, one task/assignment/notification under identical replay, two expected activity/audit events, changed-payload rejection, complete atomic rollback on invalid assignment, inactive-account denial, and zero persistent fixture rows.

## Verification

- `pnpm check`: passed TypeScript, zero-warning lint, 224 test files / 1,124 tests, Worker build, and client production build.
- Focused SygTasks suite: 8 files / 40 tests passed.
- SygTasks rendered visual/accessibility matrix: 10/10 passed across light/dark desktop, laptop, tablet, mobile, dialogs, keyboard behavior, and 200% effective zoom.
- Pre-release actual-component Time Clock and launcher matrix: 50/50 passed across desktop and mobile.
- Post-deployment protected Time Clock matrix: 38/38 passed across desktop and mobile, including Early Clock-In acknowledgement and the complete punch lifecycle.
- Live production contract test: passed against the applied RPCs inside one rollback with no leaked test records.
- Primary and fallback `/api/v1/health` returned HTTP 200 with `status: ok`.
- Primary and fallback `/api/v1/ready` returned HTTP 200 with `ready: true` and every configured dependency healthy.
- `/tasks` returned HTTP 200.
- The live entry JavaScript/CSS, SygTasks JavaScript/CSS, logo, and emblem matched the final local production files byte-for-byte by SHA-256.

Representative visual evidence is stored locally in:

- `outputs/sygtasks-redesign-visuals/sygtasks-theme-layout-SygT-b7b3d-main-usable-in-dark-desktop-desktop-chromium/sygtasks-my-work-dark-desktop.png`
- `outputs/sygtasks-redesign-visuals/sygtasks-theme-layout-SygT-e6b4e-ain-usable-in-light-desktop-desktop-chromium/sygtasks-boards-light-desktop.png`
- `outputs/sygtasks-redesign-visuals/sygtasks-theme-layout-SygT-fc1f2-cus-and-dismiss-with-Escape-desktop-chromium/sygtasks-create-task-dark-mobile.png`

## Release and rollback

- Source commit: `edc3f77` (`feat: redesign SygTasks work management`).
- Cloudflare Worker version: `ee2ee67a-fc32-447d-8ca6-6d142a6264df`.
- Cloudflare deployment ID: `8dd76128-0c4f-40c1-bb39-14f1f614a6c4`.
- Deployment time: `2026-09-09T21:52:03.788624Z`.
- Pre-release fallback tag: `rollback/sygtasks-redesign-pre-release-20260909`, pushed to origin at the fully verified pre-redesign source baseline.

If a presentation rollback is needed, deploy the fallback tag without rewriting database history. The database change is additive and can remain safely unused by the prior client. Any later database removal must be a reviewed forward migration; do not drop objects or repair migration history manually.

Remaining acceptance: none for this release.
