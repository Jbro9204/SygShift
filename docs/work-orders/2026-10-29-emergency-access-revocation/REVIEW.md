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
- Commit and verify the additive precursor database contracts before deploying Worker routes that consume them, but leave the one-way central enforcement activation unapplied during that compatibility phase.
- Deploy compatible Sygilant and SygShift application paths before applying `20261029233000_activate_emergency_access_control_plane`.
- Do not test by revoking a real employee.
- After activation, capture a separately tracked post-activation baseline and verify the new ledger identity and all function, ACL, RLS, trigger, index, and marker contracts.
- A Worker rollback must leave revocation markers and session invalidation intact; it must never restore access.
- Sygilant's native administrator UI remains a separate consumer that must proxy the same SygShift authority rather than create a second revocation system.

## Reviewed post-activation ownership evidence

`migration-ownership-post-activation-v2.json` was captured read-only after the guarded production transaction committed. It contains 422 applied migration identities, 408 SygShift owning sources, and 146 Sygilant default-chain owning sources. Its file SHA-256 is `5245048ac9ba03b2982506bb2a21f53878d6c694d4223288130d8964ce244541`.

Comparison with the reviewed pre-activation evidence established that all 421 earlier applied versions retain the same name, owner, and exact statement-array checksum; every earlier owning source retains the same normalized checksum; and exactly one applied version was added: `20261029225323_emergency_access_revocation_control_plane`. The new ledger entry contains one exact statement whose ordered-source SHA-256 is `f9bc9d56659662adaa8ec42fcebfa4412be00d890f57d44c0b19c80eda0a0335`. It does not authorize bulk replay or migration-history rewriting.

The three canonical HR entries remain explicit review findings outside the default migration chain. Their statement counts and ordered hashes remain unchanged. Both installed rollback-only regressions passed after activation and retained no synthetic fixtures.

## Reviewed centralized precursor evidence

`migration-ownership-pre-worker-v2.json` was captured read-only after the centralized Sygilant control plane, authenticated-wrapper ACL repair, employee Storage session boundary, and SygSphere session boundary committed in production. It contains 426 applied migration identities, 408 SygShift owning sources, and 151 Sygilant default-chain owning sources. Its file SHA-256 is `481f2b362166292cc4c16761b7c1f397de496cff3865aed219bf8e1b288df28d`.

Comparison with the reviewed 422-entry post-activation evidence found zero earlier version, name, owner, statement-array checksum, owning-source identity, or owning-source checksum changes. Exactly four applied Sygilant identities were added:

- `20261029230000_emergency_access_control_plane`;
- `20261029230500_emergency_access_authenticated_wrapper_acl_repair`;
- `20261029231000_employee_storage_session_uploads`; and
- `20261029232000_sygsphere_session_bound_uploads`.

The separately reviewed `20261029233000_activate_emergency_access_control_plane` source is present but remains unapplied at this precursor checkpoint. This historical checkpoint is superseded by the post-central-activation evidence below. The baseline is the required nondrift input for the coordinated Worker release; it authorizes neither bulk migration replay nor history rewriting. The three canonical HR source findings and eighteen historical NULL/empty statement-array findings remain unchanged.

## Reviewed post-central-activation ownership evidence

`migration-ownership-post-central-activation-v2.json` was captured read-only on `2026-10-30T03:37:31.106Z` after the one-way central activation, activation postflight, and rollback-only canary completed. It contains 427 applied migration identities, 408 SygShift owning sources, and 151 Sygilant default-chain owning sources. Its file SHA-256 is `b49e141fe3c354d61a549ad8510c208337c78ec0c239cd6f3c6c43cc4da2c9a9`, and its ledger SHA-256 is `76529a52ac0d0fc4bdfda85ceb0eeb33c65009efa6776f4a70cbf4131d20bdb8`.

Comparison with the reviewed 426-entry precursor evidence found zero removed entries and zero changes to any earlier version, name, owner, statement-array checksum, ordered-statements checksum, owning-source identity, or owning-source checksum. Exactly one applied identity was added: `20261029233000_activate_emergency_access_control_plane`, owned by Sygilant with an exact version-and-name source match. The ledger entry contains eight statements, statement-array SHA-256 `ccafd1d523550fc2f4a60b7102fcb0ae419366d2692e228e7b82d3acd1028c54`, and ordered-statements SHA-256 `60d42cea563d864ebfeb0b229a613ab21aebd15ae6f552ebaa69e740b08d24c8`. This evidence authorizes neither bulk replay nor migration-history rewriting.

The activation postflight passed. The rollback-only canary returned the explicit result `emergency_access_control_plane_passed_in_rollback` and retained no synthetic fixtures.

## Reviewed central-bridge production evidence

Exact source `dd5b532df4f792dd60be98002909b84d42c11e66` was released as Cloudflare Worker `40129fe3-84d2-4d5c-956f-3c9339711f39`. The prior Worker `02ee56ae-7692-4072-a4e2-fbf1c071a1da` at source `3cc2a31eb69b028e73d047e3b3af96b18f72f25d` remains the application rollback floor. The governed release completed as released and promoted, required two reconciliation reads, used 31 live probes and three upstream probes, and did not roll back. Wrangler did not return a candidate Version URL, so candidate-preview smoke checks were unavailable.

The pre-promotion full-success watermark was `2026-10-30T03:31:06.414Z`, and the post-promotion scheduled full success was `2026-10-30T03:31:57.399Z` on the exact source. Live health and readiness returned HTTP 200; readiness reported `ready=true`, status `ready`, scheduled-runtime mode `closed`, zero consecutive failures, and all required configuration, shared-identity, and runtime checks true.

The complete release gate passed 389 application test files with one intentional skip, 2,286 tests with one intentional skip, 189 release-control tests, all 42 mandatory desktop/mobile Time Clock browser checks, and the production build/static-asset contract. Source `dd5b532df4f792dd60be98002909b84d42c11e66` aligned the browser fixture with `get_session_context_emergency` and its fail-closed emergency-access fields.

No approved controlled production account and credentials were available for the required simultaneous multi-platform, multi-browser/device zero-access exercise. Production deployment and readiness are verified; full controlled-account acceptance across Sygilant, SygShift, SygSphere, and SygTasks remains open and must not be claimed complete.
