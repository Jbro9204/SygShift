# Emergency access revocation release review

## Scope

This work order adds SygShift's protected emergency access revocation and restoration control plane. It does not terminate employees, alter identity records, change roles, or rewrite payroll, punch, schedule, client, licensing, or audit history.

The candidate migration is `20261029225323_emergency_access_revocation_control_plane.sql`, normalized SHA-256 `f9bc9d56659662adaa8ec42fcebfa4412be00d890f57d44c0b19c80eda0a0335`. The pre-activation capture classifies it as `local-only-not-approved-for-production`; it was not present in the production ledger at capture time.

## Reviewed pre-activation ownership baseline

`migration-ownership-pre-activation-v2.json` was captured read-only from project `eqkdfrbwtioiqtjsyglg` on `2026-10-29T23:41:50.041Z`. It contains 421 applied migration identities, 408 SygShift owning sources, and 146 Sygilant default-chain owning sources. It does not authorize bulk migration push or ledger rewriting.

The prior reviewed production baseline was `docs/work-orders/2026-10-27-announcement-banner-repair/migration-ownership-post-activation-v2.json`, with 399 applied identities, 407 SygShift sources, and 127 Sygilant sources. Comparison established:

- zero prior applied identities removed or changed by name, statement-array checksum, or recorded owner;
- zero prior owning sources removed or changed by normalized source checksum;
- 22 later applied identities added by reviewed Sygilant releases;
- 19 matching default-chain sources added in Sygilant `main` commit `4b47b090ad249a1069a0ac11ad8556b9fbbb8b54`;
- three canonical HR bundle identities retained outside Sygilant's default migration chain by design; and
- one unapplied SygShift candidate source added for this release.

The 19 default-chain Sygilant additions cover versions `20261026203426` through `20261029160933` and appear with exact version-and-name source matches in the new baseline.

The three canonical HR bundle entries are deliberately reported as `source-not-found` by the default-chain ownership scanner because their sources are held under `supabase/canonical-hr/migrations`, not `supabase/migrations`. Their production ordered-statement hashes and counts exactly match the tracked canonical manifest at Sygilant commit `4b47b090ad249a1069a0ac11ad8556b9fbbb8b54`:

| Version | Statements | Production ordered-statements SHA-256 | Canonical manifest ledger SHA-256 |
| --- | ---: | --- | --- |
| `20261029154240` | 46 | `acf90a2d0267ee15af17aa7d0a162db91b2e63832ccc128e369519522f4ad2fa` | same |
| `20261029161435` | 21 | `f4183b45b00c40cc1cc923619bad45001072e7c403d375d3bdd9163128486c2e` | same |
| `20261029190000` | 8 | `716d3991d7491fc15776f4ea9f21132bb381dbc1ac9b1e73271634334b2971ef` | same |

These three entries remain review findings rather than being silently relabeled by the generic scanner. Their canonical bundle manifest records exact source hashes, order, statement counts, production target, and forward-only recovery posture.

## Release boundaries

- Apply only the generated fingerprint-gated atomic artifact after the exact candidate passes the clean-checkout and GitHub quality gates.
- Do not use broad `supabase db push`.
- Activate the database contract before deploying the Worker routes that consume it.
- Do not test by revoking a real employee.
- After activation, capture a separately tracked post-activation baseline and verify the new ledger identity and all function, ACL, RLS, trigger, index, and marker contracts.
- A Worker rollback must leave revocation markers and session invalidation intact; it must never restore access.
- Sygilant's native administrator UI remains a separate consumer that must proxy the same SygShift authority rather than create a second revocation system.

## Reviewed post-activation ownership evidence

`migration-ownership-post-activation-v2.json` was captured read-only after the guarded production transaction committed. It contains 422 applied migration identities, 408 SygShift owning sources, and 146 Sygilant default-chain owning sources. Its file SHA-256 is `5245048ac9ba03b2982506bb2a21f53878d6c694d4223288130d8964ce244541`.

Comparison with the reviewed pre-activation evidence established that all 421 earlier applied versions retain the same name, owner, and exact statement-array checksum; every earlier owning source retains the same normalized checksum; and exactly one applied version was added: `20261029225323_emergency_access_revocation_control_plane`. The new ledger entry contains one exact statement whose ordered-source SHA-256 is `f9bc9d56659662adaa8ec42fcebfa4412be00d890f57d44c0b19c80eda0a0335`. It does not authorize bulk replay or migration-history rewriting.

The three canonical HR entries remain explicit review findings outside the default migration chain. Their statement counts and ordered hashes remain unchanged. Both installed rollback-only regressions passed after activation and retained no synthetic fixtures.
