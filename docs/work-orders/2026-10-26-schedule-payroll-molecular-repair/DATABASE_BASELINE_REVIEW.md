# Schedule and payroll molecular repair — database baseline review

Date: 10/26/2026
Database mutation authorized by this record: No

## Reviewed source boundary

The release owns ten forward-only SygShift migrations at source commit
`15a7c578b4bec52dfa373973e77289e1972e1f71`. Cross-application ownership was
reconciled against a separate clean Sygilant `origin/main` checkout at
`ce52953e0706f908a041b030f90dad28988501a5`.

The fixed read-only production query selected `version`, `name`, and
`statements` from `supabase_migrations.schema_migrations`, ordered by version,
in project `eqkdfrbwtioiqtjsyglg`. Raw migration SQL stayed in memory. The
tracked manifests contain identities, ownership, source fingerprints, and
exact statement-array fingerprints; they do not contain credentials or
authorize bulk migration replay.

## Pre-activation production capture

`migration-ownership-pre-release-v2.json` records the production state before
this release:

- capture time: `2026-10-26T18:19:55.040Z`;
- applied migrations: 388;
- SygShift owning sources: 427;
- Sygilant owning sources: 127;
- missing applied sources: 0;
- unresolved ownership reviews: 0;
- exact captured ledger SHA-256:
  `8b3bbd3176a9c1e9bbf7bbf8d0216c4ab76c6bb7d4c70f9dca8c2f795ba4ad4b`;
- baseline file SHA-256:
  `3f1c1980d24500831145b175e6ab97469b1e2c49ca718a6fdb508652a11e3c2a`.

The capture includes the two current Sygilant-owned production migrations
`20261025164503` and `20261025165300`. It supersedes the stale 10/24 baseline
for this release only; no prior evidence was changed.

## Reviewed expected post-activation baseline

`migration-ownership-expected-post-activation-v2.json` preserves all 388
captured applied entries unchanged and appends only these ten reviewed
SygShift identities, in migration order:

1. `20261026141835_schedule_draft_timeout_repair`
2. `20261026142017_schedule_draft_set_based_clone`
3. `20261026142340_payroll_review_single_pass_sources`
4. `20261026142700_bound_payroll_effective_event_source`
5. `20261026143200_canonical_timekeeping_review_contract`
6. `20261026151000_schedule_edit_copy_on_write`
7. `20261026165217_timekeeping_due_shift_index`
8. `20261026165218_timekeeping_employee_shift_event_index`
9. `20261026165219_scheduled_runtime_molecular_repair`
10. `20261026170133_scheduled_runtime_index_postflight`

Each candidate entry is owned by SygShift, has an exact version/name source
match, and records one nonempty exact statement-array element. The expected
manifest contains 398 applied entries and changes only the candidate sources'
disposition from local-only to applied. No existing applied entry, owning
source identity, or owning-source fingerprint changed.

- expected baseline file SHA-256:
  `03a15aedc2ca3b2887624eb760cfaaa2fc76d67fda237127147bf3f9621a4be5`;
- ordered eight-phase release bundle SHA-256:
  `60350e54ea502e675e89ed02868ae21d5f5235718195ce7aeeb6c049830a24b6`.

The bundle fingerprint hashes the ordered normalized sequence of each release
phase filename, a NUL separator, and its exact SQL. The three concurrent index
phases remain outside transactions and receive their ledger entries only after
their separate validation phases succeed.

## Historical reconciliation boundary

The twenty previously reviewed timestamp/name differences and eighteen
previously reviewed NULL/empty historical statement arrays remain unchanged.
They are known historical evidence gaps, not new drift. The mandatory normal
release gate verifies exact nondrift against the reviewed expected baseline;
it does not claim historical SQL equivalence or authorize `db push`, history
rewriting, or replay. The separate `--require-reconciled=yes` audit must and
does remain fail-closed while those 38 historical gaps are unresolved.

After activation, the mandatory normal gate must accept a fresh 398-entry
production ledger against the tracked expected manifest before the Worker is
promoted. Any missing candidate, additional applied version, changed identity,
changed statement-array fingerprint, changed source owner, or changed owning
source fingerprint stops the release.
