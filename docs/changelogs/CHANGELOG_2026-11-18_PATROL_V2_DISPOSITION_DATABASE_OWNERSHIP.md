# Shared database ownership: retained version-two patrol drafts

Date: 11/18/2026
Status: shared database activation verified; Sygilant application CI pending at capture

## Scope

This metadata-only SygShift update records the Sygilant-owned
`20261118194831_patrol_v2_explicit_disposition_compatibility` migration after
verified activation. It does not change SygShift application or Worker code,
execute a database repair, or authorize another deployment. Do not redeploy the
SygShift Worker for this ownership closeout.

Sygilant source `8a682515b72a164438c4280783a84d0ef270d940` extends the explicit
disposition policy to retained, canonical version-two patrol drafts. The
coordinated release operator verified the rollback-only rehearsal, activation,
unchanged security metadata, protected-record/catalog preservation and
recognition of all 25 existing editable version-two patrol snapshots. These
were read-only recognition checks, not edits to the reports.

The Sygilant exact-SHA application workflow `44387072062` was still running at
capture. This document does not claim application deployment or real-device
acceptance.

## Append-only ownership evidence

New baseline:
`docs/reliability/migration-ownership-2026-11-18-patrol-v2-disposition-complete-v1.json`.

Baseline SHA-256:
`4f5838401794119b998130140d1c8b9a1be9852c49429fe58b5404e4633b586c`.

The prior 469-entry baseline and its file hash remain unchanged:
`migration-ownership-2026-11-18-patrol-disposition-complete-v3.json`,
`9f6cba4bb106644df42f7dff44aeed23649bb94b2d44f7c409a9023f063b69f9`.
All earlier baselines remain historical evidence.

The reviewed capture accepts exactly one additional Sygilant source and its
six ordered statements, preserving every prior ledger identity, ownership
decision and source fingerprint.

- Source SHA-256: `7ce03842eccb359b951566f50e4b000860c8c110610aa15809723f24a652207f`.
- Ordered statements SHA-256: `28f05c4beea2bd117e4679bd86d911e76a07370ed4f42017c402342dc2c31967`.
- Stored statement-array SHA-256: `eb527c91e320ce5f0776b14d47dd1029201a5e2e4b30bec0760b88109620d272`.

There are 470 applied migrations, 421 SygShift sources and 181 Sygilant sources.
Historical reconciliation debt is unchanged: 20 name/version differences,
three missing sources, 18 missing statement arrays, three ownership reviews
and one withdrawn cross-project source. No replay exception or relaxation is
introduced.

## Verification and remaining gates

The capture and independent read-only comparison verified the exact observed
ledger, reviewed source and six-statement fingerprints, unchanged prior
baselines and historical ownership projection. The capture helper makes no
network request; its observed designation relies on the coordinated operator's
verified activation result.
All 13 targeted migration-ownership tests passed. A fresh read-only manifest
comparison accepted both the 470-entry capture and its preserved 469-entry
historical projection with no drift.

The normal isolated exact-main gate must still run `pnpm check`, all 42
desktop/mobile Time Clock cases and a fresh production build, followed by the
exact-SHA GitHub gate. These checks are not waived because this change contains
only documentation and evidence. No duplicate local full gate or production
deployment is claimed here.

Future release verification must use this committed 470-entry file as
`SYGSHIFT_RELEASE_MIGRATION_BASELINE` and the separately verified Sygilant
checkout as `SYGSHIFT_RELEASE_SYGILANT_ROOT`. Selecting an older baseline to
bypass the new migration is not permitted.
