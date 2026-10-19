# Timekeeping review timeout repair — 10/19/2026

Status: two database optimizations installed; reliable maximum-range acceptance remains unmet after a follow-up diagnostic timeout. A third optimization is prepared and tested under rollback, awaiting independent review. Paired application releases remain independently gated.

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

## Installed production probes

Each query used its own `BEGIN READ ONLY`/`ROLLBACK`, the existing eight-second ceiling and an operator-only synthetic AAL2 context for an existing active Time viewer. No employee fixture was written.

| Range | Rows | SQL milliseconds | Payload MD5 |
| --- | ---: | ---: | --- |
| 10/04–10/17/2026 | 227 | 2,989.148 | `9342ddd091a7210d354da139b66dfa9f` |
| 10/18–10/31/2026 | 40 | 2,341.857 | `8b00f0af59c54843e5f455ac0808b7fc` |
| 09/04–10/19/2026, maximum 46 days | 752 | 6,968.858 | `96201c83627ca3a1a38f2d61978dcc9e` |
| 09/20–10/03/2026 | 248 | 3,495.031 | `e23984627ed74a39f5365bdc20e454f9` |
| 01/04–01/17/2099, no worked activity | 12 salary defaults | 2,437.386 | `8cd816c21c3d59e990dc6c7932f3694e` |

Payload digests include informational `serverTimestamp`; successive raw digests are not an equality test. Exact content/order equality excluding only that timestamp passed on the restored database, including the complete 46-day public payload. Two additional identical installed maximum-range probes produced an eight-second `57014` timeout followed by a 7,420.365 ms success. Across three installed maximum-range probes, two passed and one timed out. Reliable maximum-range acceptance remains unmet.

The follow-up timeout identified repeated full category-map expansion in `private.get_timekeeping_review_pre_payroll_week_allocation`. Unapplied migration `20261019234005_group_timekeeping_payroll_categories_by_employee.sql` groups those unchanged map entries by employee once, retains original array order, and preserves the original matching predicate, priority and all payroll calculations. Its exact baseline/result hashes are `419009e39eca36320e9a4dad8f4d79cc` / `50d56676c0b0daa7d2f795dc85e1b074`. Candidate rollback validation passed five complete ordered payload comparisons, ten adversarial matching cases and all four independent payroll SQL suites. Isolated category enrichment was 115.531 ms before / 51.305 ms after; three hosted rollback probes completed the same maximum range in 6,345.180, 6,652.550 and 6,134.831 ms under the unchanged eight-second ceiling. This is improvement evidence, not an installed or guaranteed reliability claim. Exact release/ledger/inverse recovery rehearsal passed production owner, ACL, configuration, security, volatility and argument-default checks. The ledger envelope is one full-source migration text containing explicit BEGIN/COMMIT. The candidate remains prepared, not deployed.

## Regression, security and preservation evidence

- Four independent rollback suites passed: payroll-week allocation, payroll categories, Team Attendance overnight summary and canonical overtime parity. The canonical collection regression and exact recovery passed too. Isolated PostgreSQL was 18.3; production is 17.6. Live owner/ACL/config preservation was verified separately.
- Focused application tests: 67 passed across seven files. Diagnostic safeguard tests: three passed.
- All four public/private function owners and ACLs exactly match the captured baseline. Private helpers and schema deny browser roles; the public review permits authenticated execution and retains MFA/effective-permission enforcement and empty search paths. Role limits remain three seconds for anonymous and eight seconds for authenticated/authenticator.
- Counts and full-row multiset SHA-256 fingerprints match the restored pre-release backup for all 13 preservation tables: employees, accounts, credentials, role memberships, role permissions, individual permission overrides, schedules, shifts, assignments, punches, time off and locked payroll batches/rows. This includes 90 employees, 80 accounts, 64,629 shifts, 56,620 assignments, 2,568 punches and 3 locked batches / 13 rows.
- Historical audit counts (10 HTTP 500 and 13 statement timeouts) are distinct from four expected pre-install diagnostic `57014` events and one controlled installed maximum-range diagnostic timeout. Installed controlled probes: six successes, one timeout. Organic post-release error counts require separate operational telemetry; these controlled results do not establish an organic traffic count.

Detailed sanitized evidence is retained in the ignored `tmp/timekeeping-diagnostics-20261019/installed-20261019/` directory. Production fixture tests remained blocked by scheduled maintenance and were not bypassed; the restored database supplied their regression gate. Synthetic operator context does not prove a real browser MFA/session workflow. Planned-maintenance readiness restrictions and the separate Worker/UI release gate remain in effect.
