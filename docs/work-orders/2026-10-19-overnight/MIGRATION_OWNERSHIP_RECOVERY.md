# Migration source ownership and recovery — 10/19/2026

This evidence uses the captured production ledger, not a rewritten ledger or a bulk migration push. The capture contains 366 applied versions; the earlier audit had 365. Version `20261019164314_assisted_historical_end_of_shift_entry` accounts for the newer captured head.

`migration-ownership-manifest.json` records every applied identity, ordered-statement hashes, candidate source paths and hashes, source ownership, and local-only disposition. It is preserved format v1 evidence: its statement-array hash treated SQL NULL as an empty array. Twelve captured ledger rows are NULL arrays and six are empty arrays. The new format v2 hashes their exact original JSON values separately and explicitly refuses v1 for exact-array verification; the original evidence is not overwritten. `migration-source-ownership-decisions.json` supplies documentary evidence for three historical sources retained in both repositories. Sygilant owns those release sources; the security-key/trusted-device function still crosses the SygShift-owned workforce identity boundary. Existing duplicate history is preserved.

Recovered SygShift source files:

| Version | Recovery proof |
| --- | --- |
| `20260921182231_support_ticket_email_redesign` | Source from `C:/Users/Jordan/Documents/Codex/2026-09-21/SygShift-ticket-email-redesign`; exact six-statement SplitAndTrim array equals the production ledger. Source commit `793421f1fafc3746159cbc58858c1af77db2cebc`. LF source SHA-256 `8d9cee42149ae4b6c270094f3b1aa40d033c5ea5c664de3db866f65656760985`. |
| `20260921185816_support_ticket_notification_detail` | Same correct owning source tree; exact eleven-statement array equals production. LF source SHA-256 `161cfe87c2bf07cd6d6dae1f8b7fec5ca93c1183902d6205d9c9e9ef1f0e04ef`. |
| `20260922233000_schedule_client_readiness_selector` | Tracked source from `C:/Users/Jordan/Documents/Codex/2026-06-12/pull-this-repo-and-clone-locally/work/sygshift-client-overhaul`, commit `0b6b35497f7be97ce8a0a5e8cc55b3fee8b0235c`; paired Sygilant rollout document explicitly names this SygShift version. LF source SHA-256 `f1c07b6c53d7bce469410490d1a404786b26cdf6fad55a804ac7ae0fb1f530ac`. The production statement array is empty, so exact applied SQL equivalence remains unproven. |

All three recovered files were absent from the requested checkout and restored with their original identities into its SygShift migration source tree. They were not executed, renamed, reordered, or registered again.

The controlled manifest resolves all captured applied identities to source candidates and source owners. Twenty applied identities have same-name source files with different local timestamps. Their exact applied statement arrays are recovered under the correct owner's private archive:

- SygShift: `C:/Users/Jordan/Projects/SygShift-misty-timezone/backups/overnight-2026-10-19/recovered-migrations/`.
- Sygilant: `C:/Users/Jordan/Documents/Codex/2026-09-29/rev/work/sygilant-guard-report-hotfix/work/overnight-database-repair-20261019/recovered-migrations/`.

These JSON source capsules retain original version/name/statements and content hashes. They remain outside the active migration queue; no Sygilant capsule was inserted into unrelated SygShift history. Publicly committing recovered statement bodies requires a separate privacy/source review because historical operational migrations can contain private literals.

Eighteen captured applied rows have missing/empty statement arrays (twelve NULL, six empty). Seventeen already have matching version/name source files; the eighteenth source was recovered as described above. Missing ledger statements are disclosed rather than manufactured. Same-name/different-version sources and missing/empty statement arrays are not claimed as proven replay-equivalent. Recovery of the current database is grounded in the separately verified native production backup and restored database, plus catalog/ledger snapshots.

Sygilant local-only migration `202609020003_external_mfa_assurances.sql` is explicitly classified as **withdrawn cross-project assurance — do not apply**. The owning deployment and identity-security documents state that it belongs to a retired cross-project design and must not be installed into the shared SygShift project. Other local-only source is classified as unapproved for production; local absence from the captured ledger is never treated as deployment authorization.

The checker is `tools/database-migration-ownership.mjs`. It never executes SQL. Re-run capture against a fresh saved ledger after intended releases to produce a separately dated final manifest; the captured pre-maintenance ledger is retained unchanged.

## Explicit read-only gates

`--verify-baseline <reviewed-manifest>` compares the current saved ledger and owning source trees against a previously reviewed manifest. It exits nonzero for an added/removed applied version, changed applied name, changed statement-array hash, changed owner, or added/removed/changed owning source. Source comparisons use `owner/filename` and LF-normalized checksums, allowing a different checkout path without concealing SQL changes. Verification cannot write a manifest or recovered archive.

`--require-reconciled yes` adds a stricter gate that refuses unresolved applied/local timestamp differences, empty applied statement arrays, missing/conflicting source identities, or unassigned ownership. It can be combined with baseline verification or used as a reconciliation-only check. No force/allow option is provided.

For example, use explicit values for the two owning roots, saved ledger, and documented ownership decisions, then add `--verify-baseline <reviewed-manifest>`. Add `--require-reconciled yes` when the caller requires reconciled migration history. The current twenty timestamp differences and eighteen empty applied statement arrays **must fail** the reconciliation gate. Ordinary bulk database migration push remains blocked.

An exact reviewed baseline passing the nondrift comparison proves only that the captured ledger/source signatures have not changed. The tool explicitly returns `claimsHistoryEquivalence: false` and `bulkMigrationPushAuthorized: false`; acceptance does not approve historical replay or establish SQL equivalence across different transaction/statement envelopes.

Thirteen ownership tests cover changed SQL under the same version/name, NULL-to-empty array drift, legacy format refusal, removed/extra applied versions, changed owning-source checksums, portable checkout paths, changed names, exact reviewed nondrift acceptance, and refusal of unresolved history, alongside the ownership/recovery cases.

## Required normal release enforcement

The standard `pnpm deploy` entry now calls `requireDatabaseReleaseBaseline` before entering the existing production-release core. Both live and dry-run paths require the gate. The current health, clean/pushed source, configuration continuity, application tests, candidate preview, promotion, scheduler, and rollback controls remain in the existing core. No skip/force migration-gate CLI option exists.

Required environment configuration uses explicit absolute paths: `SYGSHIFT_RELEASE_MIGRATION_BASELINE` points to the separately reviewed format v2 manifest tracked inside the SygShift repository; `SYGSHIFT_RELEASE_SYGILANT_ROOT` points to the separate correct Sygilant owning source tree. A missing/unreadable/legacy/outside/untracked baseline, wrong production project, failed CLI query, invalid/empty ledger, changed source, or changed applied identity/name/exact statement array stops before any release command. The gate also runs `git diff --quiet HEAD -- <baseline>` before the database query, refusing staged and unstaged baseline changes instead of treating them as approval.

The gate runs pinned official `supabase@2.121.0 db query --linked --project-ref eqkdfrbwtioiqtjsyglg` with the fixed read-only query `select version,name,statements from supabase_migrations.schema_migrations order by version`. It uses saved CLI authentication, keeps the response in memory, scrubs release canary variables from the CLI environment, and never prints applied SQL, credentials, raw CLI output, or message data. It reports acceptance metadata only. Source comparison uses owner/filename rather than absolute checkout paths. This is a point-in-time preflight; application release health and later commit continuity gates are still mandatory.

`pnpm database:release:gate` provides the same fresh-production baseline verification independently. The mandatory database-release procedure is: retain a recoverable production baseline, review a current v2 ledger/source manifest and the exact proposed migration, commit the reviewed source/baseline, run this gate, then use only the independently tested fingerprint-gated single-migration activation batch. Capture and review a separate updated v2 baseline after every intended applied-version change; never auto-accept a changed ledger by overwriting the reviewed baseline.

`pnpm database:release:gate -- --require-reconciled=yes` additionally requires actual historical reconciliation. It must fail while the twenty timestamp differences and eighteen NULL/empty statement sources remain unresolved. Normal application baseline acceptance explicitly does not authorize bulk `db push`, ledger rewriting, SQL replay, or claim historical equivalence. No ordinary bulk push is approved.

Eight focused release-gate tests prove fixed fresh production capture, source-tree and applied-SQL refusal, configuration/target/legacy/untracked/modified-baseline failures, private-output withholding, strict reconciliation refusal, and mandatory gate order before dry-run or live release. `pnpm release:test` includes both these tests and ownership tests, alongside the unchanged existing release suites. These automated tests use injected read-only command responses; a real fresh-CLI invocation against the final committed v2 artifact remains a separate validation step.
