# Shared database ownership: patrol report dispositions

Date: 11/18/2026
Status: shared database activation verified; Sygilant application release and exact-main closeout are separate gates

## Scope

This metadata-only SygShift change records the approved Sygilant-owned
`20261118185408_patrol_explicit_disposition_policy` migration. It changes no
SygShift application or Worker code and performs no additional database write.
Do not redeploy the SygShift Worker for this ownership closeout.

The owning source is Sygilant commit
`1c6ab25baba487778c92e9da0e066b926f50bb1a`.
The coordinated release operator verified the rollback-only production
rehearsal, exact activation, five changed-function security fingerprints and
protected-record/catalog preservation. The actual 469-entry post-activation
ledger is the input to this ownership capture. The capture helper itself makes
no production request and does not independently establish that input's origin.

## Append-only ownership evidence

New tracked baseline:
`docs/reliability/migration-ownership-2026-11-18-patrol-disposition-complete-v3.json`.

Baseline file SHA-256:
`9f6cba4bb106644df42f7dff44aeed23649bb94b2d44f7c409a9023f063b69f9`.

The prior 468-entry
`docs/reliability/migration-ownership-2026-11-18-continuity-complete-v4.json`
remains unchanged, as do all earlier evidence captures.

Only the reviewed Sygilant source and its 12 ordered statements were added.
The capture verified every prior ledger identity, owning source and recorded
statement fingerprint before accepting the addition.

- Source SHA-256: `b8989b5d8057447315fd5b5d33235fafa90b4bcb315b2bf83c3e4665c000875f`.
- Ordered statements SHA-256: `e8f80fb9ca9781859620266fea14e9d672340c0c784e8118c71e23e4c2279de4`.
- Stored statement-array SHA-256: `179a9dbe870935441e1fddfd22b584317eb6e98c6c5ee35978d7dfa3996b874b`.

The baseline contains 469 applied migrations, 421 SygShift sources and 180
Sygilant sources. Existing reconciliation debt is unchanged: 20 name/version
differences, three missing sources, 18 missing statement arrays, three ownership
reviews and one withdrawn cross-project source. This update does not conceal
or claim to repair those historical discrepancies.

## Verification and remaining release gates

The exact-source and append-only capture checks passed. Local verification used
Node 24.19.0 and pnpm 11.25.0. `pnpm check` passed type checking, zero-warning
lint, 2,657 unit tests (one existing intentional skip), native database checks
and its production build. All 42 desktop/mobile Time Clock cases then passed,
followed by a fresh `pnpm build` and the static-asset contract check.

The first full release verification stopped correctly at one mobile-dispatcher
clock assertion. Its retained trace showed the browser failing to load
`OverviewPage.tsx` with `net::ERR_NO_BUFFER_SPACE`, leaving the fixture root
empty before any clock controls rendered. The underlying host allocation cause
was not established. After preserving the trace and confirming no owned fixture
processes or listeners remained, one isolated rerun of the complete unchanged
42-case matrix passed, including that case. No retry setting, timeout, test
assertion, application code or permission was changed. This was a local fixture
transport failure, not evidence of a production clock-state defect.

The initial one-shot release command therefore did not pass; the completed
local sequence is source checks, the diagnosed isolated full clock rerun and a
fresh production build. The normal isolated exact-main candidate and exact-SHA
GitHub checks remain required before the metadata closeout is complete.
Sygilant application deployment and real-device report acceptance are separate;
this document does not claim either occurred.

Future SygShift production release checks must explicitly use this committed
469-entry file as `SYGSHIFT_RELEASE_MIGRATION_BASELINE`, with the separately
verified `SYGSHIFT_RELEASE_SYGILANT_ROOT`. No timeout, permission, fingerprint,
gate or migration replay exception has been relaxed.

The existing SygShift Worker and its deployed source remain unchanged. Preserve
the earlier baselines; do not select an older ledger to bypass detection of the
newly applied migration.
