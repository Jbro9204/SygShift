# Authorization boundaries and migration release baseline

Date: 10/19/2026

Status: narrow authorization repair prepared and independently verified; deployment status is recorded in the overnight work-order report. Mandatory migration drift preflight is implemented in the normal release entry.

The source-import preview now uses the existing source-review administrator boundary before reading private evidence. Direct credential predicates use existing self/Licensing row policies through SECURITY INVOKER; all 22 enclosing definer qualification callers retain their owner context. Support Admin branches now require the existing verified MFA boundary, preserving employee own-ticket access and exact routed-handler permissions. No privilege is granted, no compatibility table is created, and no identity/credential/ticket/punch/schedule record is edited by the migration.

Forward migration `20261019233625_authorization_boundary_hardening.sql` guards 31 exact definitions and security contracts, the credential policies and MFA-sensitive permission metadata. Separate drift-guarded forward recovery is `20261019233735_recover_authorization_boundary_definitions.sql`. Four expected after hashes and all unrelated function contract attributes are verified. Local actual read/mutation and denied-access matrix: nine groups passed with rollback. Hosted read-only workflow groups: five passed; exact ledgered release and recovery rollback tests passed with protected counts unchanged. The local normal-access absence tests do not prove access during maintenance; its discovered urgent-path restriction is being repaired independently.

`pnpm deploy` and its dry run now require a committed reviewed format-v2 migration/source baseline and the separate Sygilant owning tree, capture a fresh production ledger in memory using the pinned official CLI, and refuse unexpected identities, names, NULL-aware statement-array signatures or owning-source changes before the existing release core runs. Modified/staged/untracked/legacy baselines fail closed. No skip flag or bulk-push authority exists. Original v1 recovery evidence remains immutable; v2 preserves the actual twelve NULL and six empty historical arrays. Strict history reconciliation still refuses twenty timestamp disagreements and eighteen missing statement sources.

Recovered three original SygShift source migrations from verified owning histories without executing or registering them again. Sygilant/shared sources remain in the correct owning tree. Ownership decisions and before/reviewed baselines are under `docs/work-orders/2026-10-19-overnight`.

Focused release-control tests passed 95/95. Fresh full quality gate and live fresh-ledger acceptance are recorded in the final report. No application deployment or maintenance override is implied by these changes.
