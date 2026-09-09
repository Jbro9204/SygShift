# SygTasks Parent-Scope Repair

Date: 09/09/2026

Status: Production database deployed and verified

## Outcome

Repaired the SygTasks board-membership mutation that prevented Michelle Hood (**Chief Hood**, username `mhood`) from being added to another authorized team board. Her account was already active, enabled, permission-eligible, and present in the board member picker; neither her account nor her role configuration was the cause.

The failure occurred because the production mutation function used local variables named `board_id`, `task_id`, and `label_id` together with `#variable_conflict use_column`. Predicates such as `membership.board_id = board_id` therefore compared the table column with itself instead of the requested board. Because Chief Hood already owned personal boards, adding her to **System Dev.** was misclassified as an existing membership, returned `changed: false`, and left the selected board unchanged.

The repaired function now qualifies every parent identifier explicitly and rejects any future ambiguous variable/column reference at compile time. An authorized manager can now add the same employee to multiple appropriate team or company boards. The release intentionally did not add Chief Hood to a production board automatically; board membership remains an explicit manager decision in Board Settings.

## Database repair

- Applied forward-only migration `20260910120000_sygtasks_parent_scope_repair.sql` with SHA-256 `C27DB02A834C35B424744ADCD2A14208B151DB179A1F1E62B8092A708B747676`.
- Repaired all 23 known ambiguous parent comparisons in `public.mutate_sygtasks(text,jsonb,uuid,integer)`, covering board membership, task creation and updates, assignments, watchers, labels, checklist items, comments, dependencies, and notification recipients.
- Replaced `#variable_conflict use_column` with `#variable_conflict error` and added the explicit `sygtasks_mutation` block label so a future ambiguous reference fails closed instead of silently targeting unrelated records.
- Used exact occurrence counts against the deployed function definition. The migration aborts without changing the function if the live definition differs from the reviewed release contract.
- Preserved the existing function identity, security-definer boundary, controlled search path, authorization checks, idempotency, Realtime behavior, notification behavior, and append-only audit history.
- Reasserted browser execution for `authenticated` and denial for `anon` and `public`.
- Updated no employee, role, board, membership, task, schedule, punch, timecard, payroll, HR, ticket, SygSphere, or Sygilant record.

## Production verification

- A rollback-only pre-fix reproduction under Jordan's authenticated manager context returned `changed: false` and created no **System Dev.** membership for Chief Hood, confirming the defect.
- The same exact rollback-only workflow passed after the migration: the mutation returned `changed: true`, created the selected-board membership inside the transaction, and then rolled it back.
- The comprehensive live parent-scope regression passed in one rollback-only transaction. It covered creation, addition, removal, assignment, unassignment, watching, unwatching, labels, checklists, dependencies, updates, comments, cross-board dependency denial, and task-specific notification recipients.
- The existing SygTasks production data-contract suite passed unchanged in a rollback-only live transaction.
- Post-release checks found zero leaked test boards, tasks, or notifications.
- The deployed mutation has MD5 `44e0a461d57c07091530c3919449e53d`, retains strict conflict mode and the explicit scope label, allows `authenticated`, and denies `anon`.
- The Supabase security advisor had no error-level findings before release. A post-release schema lint did not identify `public.mutate_sygtasks`; it continues to report ten pre-existing findings in unrelated legacy functions, which this bounded migration did not alter.

## Application and preservation verification

- `pnpm check`: passed TypeScript, zero-warning application lint, 225 test files / 1,129 tests, Worker build, and client production build in an isolated worktree containing only the three repair files.
- Focused parent-scope guard: 1 file / 2 tests passed.
- Mandatory actual-component Time Clock matrix: 42/42 passed across desktop and Pixel 7 mobile coverage after the final strengthened tests.
- Independent database review found no migration, authorization, transaction, or rollback blocker and confirmed complete coverage of all repaired statement groups.
- Primary and fallback `/api/v1/health` returned HTTP 200 with `status: ok`.
- Primary and fallback `/api/v1/ready` returned HTTP 200 with `ready: true` and every configured dependency healthy.
- Primary and fallback `/tasks` returned HTTP 200.
- No Cloudflare application deployment was required because this release changes only the production database function and regression coverage. This avoided packaging or publishing the unrelated SygSphere/PWA work currently present in the shared checkout.

## Release and rollback

- Runtime repair commit: `f943f80` (`fix: scope SygTasks mutations to their parent records`).
- Strengthened regression commit: `633597d` (`test: strengthen SygTasks parent-scope coverage`).
- Both commits were pushed to `origin/main`.
- Pre-release fallback tag: `rollback/sygtasks-parent-scope-pre-release-20260909`, pushed to origin at verified source baseline `08c2052`.

The database migration is forward-only. If a database correction is ever required, create and review a new forward migration; do not rewrite migration history or restore the ambiguous function. The source tag is available for application-code comparison, but reverting the function to the pre-release definition would restore the defect.

Remaining acceptance: use **Board Settings → Members** to add Chief Hood to the intended team or company board and confirm the member row appears. No production membership was inserted by the verification suite.
