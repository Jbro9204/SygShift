# Stability and durability release — pre-activation database baseline review

Date: 10/24/2026
Capture time: `2026-10-24T23:12:34.370Z`
Database mutation authorized by this record: No

## Capture boundary

The fixed read-only query selected `version`, `name`, and `statements` from
`supabase_migrations.schema_migrations`, ordered by version, in production project
`eqkdfrbwtioiqtjsyglg`. The capture command retained raw ledger SQL only in memory and wrote format-v2
statement-array and owning-source fingerprints to
`migration-ownership-pre-activation-v2.json`.

- Baseline file SHA-256: `f26baa49269929380a24b055635bb5bdb776b2b53ff24d0faec2460a3b3661bf`
- Exact captured ledger SHA-256: `cb7f55b83246a68ad61de803558134111f3610dc23206fb297ae7246fc71d839`
- Applied migrations: 386
- SygShift owning sources: 417
- Sygilant owning sources: 125
- Missing applied sources: 0
- Ownership reviews unresolved: 0

## Delta from the 10/23 reviewed baseline

The production ledger is unchanged at 386 applied versions. No reviewed version, name, statement-array
fingerprint, source owner, owning-source identity, or owning-source fingerprint changed or disappeared.

The only source-tree delta is the 21 ordered, local-only SygShift migrations included in the 10/24 stability and
durability release candidate (`20261024151000` through `20261024175000`). They remain classified as
`local-only-not-approved-for-production` until the guarded cutover applies and verifies them. No candidate version
is currently recorded in the production ledger.

The twenty previously reviewed timestamp/name differences and eighteen previously reviewed empty statement arrays
remain unchanged historical reconciliation items. This review does not claim historical SQL equivalence, authorize
bulk `db push`, authorize replay of an applied migration, or alter production data.

## Tooling verification

`tools/capture-database-migration-baseline.mjs` fixes the project reference and query, requires separate absolute
SygShift and Sygilant source roots, refuses output outside the SygShift repository, refuses overwrite of prior
evidence, scrubs release-only environment values from the CLI process, withholds raw CLI/SQL failure output, and
writes only after parsing and validating the complete ledger.

Focused capture, ownership, and release-gate tests passed: 25 tests, 0 failures.

## Reviewed expected post-activation baseline

`migration-ownership-expected-post-activation-v2.json` is a fail-closed expected ledger manifest for this one
release. It preserves all 386 reviewed production entries byte-for-byte at the manifest level and appends only the
21 ordered candidate identities and exact statement-array fingerprints produced by the release bundler. The
candidate statement arrays are the migration bodies that the generated release SQL records in
`supabase_migrations.schema_migrations`; they are not inferred from a later database dump.

- Expected baseline file SHA-256: `1ff85e053d116036eb922b4058435b063173e839e2a59c380d92a2b1b62af0ca`
- Exact generated release bundle SHA-256: `e77edeffada18f7b1d186ad64fbb32cdbc4aab7cfbf3d82b2d5e2bf84ad7b00b`
- Expected applied migrations after activation: 407
- Expected new applied identities: 21
- Expected missing applied sources: 0
- Expected ownership reviews unresolved: 0

This expected manifest does not claim that production has already changed and does not authorize `db push`,
history rewriting, or replay. Before Worker promotion, the release gate must capture the fresh production ledger
and compare every version, name, statement-array fingerprint, source owner, and owning-source fingerprint against
this committed file. Any missing candidate row, extra row, changed checksum, or source drift stops the release.
After activation, a separate immutable production capture will be retained as the installed-state receipt.
