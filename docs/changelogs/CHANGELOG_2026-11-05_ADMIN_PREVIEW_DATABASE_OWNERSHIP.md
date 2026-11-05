# Shared database ownership: Admin employee preview

Date: 11/05/2026
Status at source preparation: production ownership verified; metadata-only source verification pending

## Scope

This SygShift change records two approved Sygilant-owned migrations already
applied to the shared database. It does not change SygShift application code,
timekeeping, schedules, permissions, login behavior, payroll, or Worker runtime.
It does not deploy a Worker or replay either migration.

- `20261105205738_admin_employee_preview_control_plane`
- `20261105210504_employee_preview_company_readers`

The exact owning source is Sygilant commit
`6c273cf1e8e1e55d8f7c19f2ae0f176bccee7932`. The production ledger was captured
read-only after the approved atomic activation on November 5 at 22:06 UTC.

## Append-only ownership evidence

New tracked baseline:
`docs/reliability/migration-ownership-2026-11-05-admin-preview-v2.json`.

The prior 447-entry baseline remains unchanged at
`docs/reliability/migration-ownership-2026-11-05-time-off-v2.json`.
Every prior ledger identity, name and exact statement-array checksum, and every
previously recorded owning-source checksum, was compared before accepting the
two new entries. Their stored statement arrays exactly match the ordered
statements parsed from the committed Sygilant source: 67 control-plane and 31
reader statements.

The resulting manifest contains 449 applied entries, 411 SygShift source files
and 170 Sygilant source files. Historical reconciliation debt is unchanged:
20 name/version differences, 3 missing sources, 18 missing statement arrays,
3 ownership reviews and 1 withdrawn cross-project source. This is not a claim
that historical discrepancies are repaired or that bulk migration push is safe.

## Future release configuration

Future SygShift release checks should explicitly set
`SYGSHIFT_RELEASE_MIGRATION_BASELINE` to the absolute path of the new committed
449-entry file, while retaining the existing separate
`SYGSHIFT_RELEASE_SYGILANT_ROOT` path. No gate code, timeout, fingerprint or
exception is relaxed. The ordinary gate still rejects an untracked or modified
baseline and all unreviewed source/ledger changes.

## Verification and rollback

The append-only comparison helper's offline positive/negative checks passed.
The governed exact-candidate verification, 42 desktop/mobile clock checks,
fresh build, normal main pre-push gate and hosted CI must also pass before this
metadata commit is considered complete. Final identifiers belong in the
separate operator closeout receipt rather than an unverified status claim here.

No runtime rollback is needed for a documentation-only change. Preserve both
historical baselines. Do not point a future deployment at the old 447-entry file
as a workaround for current database state; that gate must continue to fail
closed until an accurate reviewed baseline is selected.
