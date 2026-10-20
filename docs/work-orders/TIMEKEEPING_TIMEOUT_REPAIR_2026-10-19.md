# Timekeeping review timeout repair — 10/19/2026

Status: four database optimizations installed; latest bounded maximum/historical probes, security and preservation checks passed. Maximum-range variance remains material: the slowest installed probe left approximately 460 ms under the unchanged eight-second ceiling. Paired application releases remain independently gated.

## Cause and change

The effective-punch query recomputed the same candidate-priority aggregate 996 times. Its two review wrappers also copied every preceding JSONB row on every loop append. The allowed 46-day review reproduced SQLSTATE `57014` at the existing eight-second authenticated limit.

The repair materializes the unchanged priority aggregate once and collects identical ordered rows in native JSONB arrays before one final conversion. It changes no payroll formula, category, overtime allocation, source event, exception fingerprint, access policy or function signature.

## Installed release

- Source: `b119ac200e4dabe65ac05c5ae84556538d6043c4`.
- Applied: `2026-10-19T23:20:11.035877Z`.
- Ledger versions: `20261019230425` and `20261019230743`.
- Exact release SHA-256: `bba5e54863dd7cb11aa283ee1bcaeb55bcbd9708ff01f06989c98389640331f0`.
- One atomic transaction checked both absent versions, exact before/after source hashes and preserved owner/ACL/configuration. DDL used transaction-local two-second lock and eight-second statement limits.
- Exact forward recoveries are retained under `supabase/recovery/`; recovery was rehearsed successfully. No Worker or Cloudflare deployment was part of this stage.

Category follow-up `20261019234005` was installed separately at `2026-10-19T23:47:42.385033Z` from pushed source `4b54eb0576e8d65be15c01beb2ff181bcce239f4`. Exact batch SHA-256: `a08c1093a4cbf21d70b0538a730d658fb50b2ab790c5ceb834c4b3eab5a1f333`. Its explicit ledger envelope stores one full-source migration text containing BEGIN/COMMIT. Exact production owner/ACL/configuration/security/volatility/defaults were checked before and after deployment. No persistent timeout or payroll calculation changed.

## Installed production probes

Each query used its own `BEGIN READ ONLY`/`ROLLBACK`, the existing eight-second ceiling and an operator-only synthetic AAL2 context for an existing active Time viewer. No employee fixture was written.

| Range | Rows | SQL milliseconds | Payload MD5 |
| --- | ---: | ---: | --- |
| 10/04–10/17/2026 | 227 | 2,989.148 | `9342ddd091a7210d354da139b66dfa9f` |
| 10/18–10/31/2026 | 40 | 2,341.857 | `8b00f0af59c54843e5f455ac0808b7fc` |
| 09/04–10/19/2026, maximum 46 days | 752 | 6,968.858 | `96201c83627ca3a1a38f2d61978dcc9e` |
| 09/20–10/03/2026 | 248 | 3,495.031 | `e23984627ed74a39f5365bdc20e454f9` |
| 01/04–01/17/2099, no worked activity | 12 salary defaults | 2,437.386 | `8cd816c21c3d59e990dc6c7932f3694e` |

Payload digests include informational `serverTimestamp`; successive raw digests are not an equality test. Exact content/order equality excluding only that timestamp passed on the restored database, including the complete 46-day public payload. After the first two optimizations, two additional identical installed maximum-range probes produced an eight-second `57014` timeout followed by a 7,420.365 ms success. That two-of-three maximum-range result correctly failed the acceptance gate and triggered the category follow-up.

The follow-up timeout identified repeated full category-map expansion in `private.get_timekeeping_review_pre_payroll_week_allocation`. Applied migration `20261019234005_group_timekeeping_payroll_categories_by_employee.sql` groups those unchanged map entries by employee once, retains original array order, and preserves the original matching predicate, priority and all payroll calculations. Its exact baseline/result hashes are `419009e39eca36320e9a4dad8f4d79cc` / `50d56676c0b0daa7d2f795dc85e1b074`. Candidate rollback validation passed five complete ordered payload comparisons, ten adversarial matching cases and all four independent payroll SQL suites. Isolated category enrichment was 115.531 ms before / 51.305 ms after; three hosted rollback probes completed the same maximum range in 6,345.180, 6,652.550 and 6,134.831 ms under the unchanged eight-second ceiling. Installed read-only validation then passed the maximum range in 6,305.871 ms (752 rows, raw MD5 `8b8186141c5f17180fa33980c8f04db9`) and current period in 2,248.774 ms (40 rows, raw MD5 `1474d4a25ab4a182bc5aaf8eb500af39`). All six function source/owner/ACL checks and all 13 preservation-table full-row SHA-256/count comparisons passed again at 23:48Z. These bounded observations do not guarantee performance for all production load.

Independent local profiling also found `occurrence_gaps` reaggregated the same sequenced events 1,551 times. The fourth optimization adds only MATERIALIZED to that CTE, with exact source hashes `63bf386020f89db8e3e1a64c2270d215` / `2bf025842841d13fa8a4f9facab445e7`. Five complete ordered payload comparisons and all four independent SQL suites passed; additional before/after full payload comparisons passed for 11 retained fixture ranges, including overnight, incomplete-punch and correction behavior. The aggregate executes once; isolated base-query duration fell from 392.283 to 196.894 ms. Three cumulative hosted rollback maximum probes passed at 5,376.527, 5,280.107 and 5,699.720 ms. Migration `20261019235117_materialize_timekeeping_occurrence_gaps.sql` was installed at `2026-10-19T23:53:21.821464Z` from pushed source `769748ac9fbbeba3a36fc5748d2497ea76ba48f8`, exact batch SHA-256 `38a582bca8b4bf6550a0dae7d4fedd2398c1ed52574f29dcf643a40f450ec290`. The hosted release/ledger/recovery rehearsal passed all five source/security/default guards before deployment. No application deployment was included.

Installed read-only occurrence validation passed two identical 46-day probes at **7,539.789 ms** and **6,435.731 ms**, each returning 752 rows / 3,308,773 bytes (raw MD5 `6bfc170f22f6bbfb146927ead8397565` / `8e1a807bb42b6f86176cceca4f23ef97`). The older 09/20–10/03 range passed at 3,217.183 ms, 248 rows (raw MD5 `f2731d9a54232eaee146b17b61377a43`). Six function metadata/source checks and all 13 preservation-table counts and full-row SHA-256 fingerprints passed again at 23:54:36Z. The slowest maximum-range observation has only about 460 ms of headroom; these bounded successes are not a guarantee under production load. No further production profiling was performed to pursue that residual risk; investigation continues locally.

## Regression, security and preservation evidence

- Four independent rollback suites passed: payroll-week allocation, payroll categories, Team Attendance overnight summary and canonical overtime parity. The canonical collection regression and exact recovery passed too. Isolated PostgreSQL was 18.3; production is 17.6. Live owner/ACL/config preservation was verified separately.
- Focused application tests: 67 passed across seven files. Diagnostic safeguard tests: three passed.
- All four public/private function owners and ACLs exactly match the captured baseline. Private helpers and schema deny browser roles; the public review permits authenticated execution and retains MFA/effective-permission enforcement and empty search paths. Role limits remain three seconds for anonymous and eight seconds for authenticated/authenticator.
- Counts and full-row multiset SHA-256 fingerprints match the restored pre-release backup for all 13 preservation tables: employees, accounts, credentials, role memberships, role permissions, individual permission overrides, schedules, shifts, assignments, punches, time off and locked payroll batches/rows. This includes 90 employees, 80 accounts, 64,629 shifts, 56,620 assignments, 2,568 punches and 3 locked batches / 13 rows.
- Historical audit counts (10 HTTP 500 and 13 statement timeouts) are distinct from four expected pre-install diagnostic `57014` events and one controlled maximum-range timeout after the first two optimizations. That failure triggered additional fixes. After category installation, two controlled installed probes passed; after occurrence installation, three controlled installed probes passed. No timeout was observed in those later bounded sets. Organic post-release error counts require separate operational telemetry; these controlled results do not establish an organic traffic count.

## Forward recovery procedure

Files under `supabase/recovery/` bearing the repair version stems are inverse bodies/templates. They are not separately deployed migrations and their matching stems must never be reused as applied ledger versions. An actual recovery must first reserve a **fresh Supabase CLI forward migration version**, incorporate the independently reviewed inverse body and its current-source/security guards, pass focused tests and the normal fresh release gate, and record a **new ledger entry**. Do not run an unledgered manual revert or rewrite the repair's applied migration/source history. Recoverable production baseline and stage source/security snapshots remain preserved separately.

Detailed sanitized evidence is retained in the ignored `tmp/timekeeping-diagnostics-20261019/installed-20261019/` directory. Production fixture tests remained blocked by scheduled maintenance and were not bypassed; the restored database supplied their regression gate. Synthetic operator context does not prove a real browser MFA/session workflow. Planned-maintenance readiness restrictions and the separate Worker/UI release gate remain in effect.

## Further measured index candidate — 10/20/2026 00:30 UTC

A separate online covering-index source is prepared as 20261020001516, SHA-256 8375774382342cd457ae39cece2f1eac8a4ae8e5351c0839f5171242f9d6d75d; it has not been installed. Local evidence shows 51,041 candidate shift lookups use an index-only path with 916 heap fetches, and one full request pair improved about ten percent. Eight independent payroll/scheduling suites, five exact ordered payload comparisons, complete effective-event equivalence, real clock/idempotency checks and draft-shift write-cost checks passed. Seventeen online lifecycle/refusal/recovery tests passed with the clone restored afterward. Production read-only preflight passed with exact metadata and unchanged eight-second review role limits; visibility-map coverage is 64.32%, so the fixture’s 98% heap-fetch reduction is not a production result. A separate thirty-second concurrent-DDL statement budget/two-second lock limit and fresh forward recovery are prepared. Source promotion is complete; production installation remains gated. Detailed evidence and guarded protocol are in 2026-10-19-overnight/TIMEKEEPING_COVERING_INDEX.md.
