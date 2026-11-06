# Shared database ownership: routine access reinstatement

Date: 11/06/2026
Status at source preparation: production ownership verified; metadata-only source verification pending

## Scope

This SygShift change records the approved Sygilant-owned migration already
applied to the shared database. It does not change SygShift application code,
timekeeping, schedules, permissions, login behavior, payroll, or Worker runtime.
It does not deploy a Worker or replay the migration.

- `20261106150858_routine_access_reinstatement`

The exact owning source is Sygilant commit
`07188c897254feeb637e19ebd63b8b74f10bf798`. The migration was activated on
November 6 at 16:06 UTC. The production ledger was captured read-only at
16:08 UTC after that activation.

The central-security documentation now distinguishes ordinary administrative
reinstatement from explicit security recovery. Routine reinstatement retains
valid credentials and current reviewed access after fresh administrator
verification and confirmed prior-session cleanup. It does not recover revoked
sessions or removed permissions. Credential replacement remains separately
confirmed, with the employee recovery checks required by current policy.
This documentation update itself does not reinstate any account.

## Append-only ownership evidence

New tracked baseline:
`docs/reliability/migration-ownership-2026-11-06-routine-reinstatement-v2.json`.

The previous 449-entry baseline remains unchanged at
`docs/reliability/migration-ownership-2026-11-05-admin-preview-v2.json`.
The earlier 447-entry baseline is also retained unchanged.

Every previous ledger identity, name, exact statement-array checksum, and
previously recorded owning-source checksum was compared before accepting the
single new entry. Its 48 stored statements exactly match the ordered
statements parsed from the committed Sygilant source.

Source SHA-256:
`3fab4350fd452abac636446eda2513dfde6d19f2360c1540ac6c4f7e59877029`.

Ordered-statement SHA-256:
`1bbc1bbb6ff21246307aed473d66c51f1cd75f4ad53e89971488cec358009248`.

The resulting manifest contains 450 applied entries, 411 SygShift source
files and 171 Sygilant source files. Historical reconciliation debt is unchanged:
20 name/version differences, 3 missing sources, 18 missing statement arrays,
3 ownership reviews and 1 withdrawn cross-project source. This does not claim
that those historical discrepancies are repaired or authorize bulk migration
push.

## Future release configuration

Future SygShift release checks should explicitly set
`SYGSHIFT_RELEASE_MIGRATION_BASELINE` to the absolute path of the new committed
450-entry file, retaining the separate `SYGSHIFT_RELEASE_SYGILANT_ROOT` path.
No gate code, timeout, fingerprint or exception is relaxed. The ordinary gate
still rejects an untracked or modified baseline and unreviewed source/ledger
changes.

## Verification and rollback

The append-only comparison helper's four offline positive/negative checks and
the post-activation production-ledger comparison passed. The governed full
source verification, 42 desktop/mobile clock checks, fresh build, normal main
pre-push gate and exact-SHA hosted CI must also pass before this metadata
commit is considered complete. Final results and identifiers belong in the
separate operator closeout receipt rather than an unverified status claim here.

The SygShift Worker is not redeployed for this change. Final read-only health,
readiness and source checks must confirm the existing runtime remains intact.
No runtime rollback is needed for this documentation-only update. Preserve
all historical baselines. Do not select the old 449-entry file as a workaround
for the new production ledger; that gate must fail closed until the accurate
reviewed baseline is selected.
