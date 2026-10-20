# Shift timestamp audit candidate, October 19, 2026

Status: installed after independent release review. Source `257eda82378b44e80f60bee5eb4c59c5b9b63f73` was pushed to origin/main before the exact activation batch was executed. Installed writer MD5 is `0144a3e9b68e95d5abc10d9ba9b377aa`; postgres owner/ACL, empty search path, SECURITY DEFINER and all 104 attachment signatures remain exact. Post-install audit count 313,694 and shift count 64,629 match the immediate pre-install state. Evidence is retained in protected `backups/overnight-2026-10-19/shift-audit-deployment.json` and `shift-audit-installed.json`. The approved scope is the precise condition recorded in AUTHORIZATION_REVIEW.md and HARDENING_PLAN.md.

The baseline generic writer recorded complete OLD/NEW JSON for every hooked update. The existing shift BEFORE trigger assigns `clock_timestamp()` even to SQL statements that leave all business fields unchanged. The installed repair returns NEW before the audit INSERT only when operation UPDATE, schema public, table shifts, both JSON records have updated_at, the timestamp differs, and the entire remaining JSON values are equal. All 23 current business columns remain in that comparison. Identical final rows still audit. No audit history is updated, deleted, moved, partitioned, or made unreadable. No maintenance, scheduling, payroll, punch, identity, employee clock, or urgent absence gate changes.

## Exact fallback and release fingerprints

The baseline is the full catalog and native backup under `backups/overnight-2026-10-19`. Fresh hosted metadata confirmed the same writer, 313,694 historical audit records, and 64,629 shifts before rehearsal.

| Item | Verified value |
| --- | --- |
| Before writer MD5 | `b71cc8d34713424231da43820bc94c1e` |
| Candidate writer MD5 | `0144a3e9b68e95d5abc10d9ba9b377aa` |
| Exact 104 audit attachment MD5 | `d83c5b5802cace28e445ca648502f500` |
| Owner | postgres |
| ACL | `{postgres=X/postgres,service_role=X/postgres}` |
| Function configuration | empty search_path, SECURITY DEFINER |

The candidate refuses a different whole function, owner, ACL, configuration, security mode, attachment definition/enabled-state matrix, or shift AFTER INSERT/DELETE/UPDATE hook. It verifies the complete replacement and preserved security metadata afterward.

Frozen reviewed source copy: `staged/20261019232727_suppress_shift_timestamp_only_audit.sql`. The exact bytes are retained in the owning active source tree at `supabase/migrations/20261019232727_suppress_shift_timestamp_only_audit.sql`, and this version is already applied. Do not reapply it, rename it or bulk push it. Source LF SHA-256 `0d3426dd8dfc03bd36ea6c913b192ac0a54db6cc2820b366e62845d39dd4d184`. Five SplitAndTrim statements; ordered ledger SHA-256 `4268a8019e1b1bbdf9a04a9dfeb83f6506050b96f625851f00fcf2eda1bacbbd`; exact statement-array SHA-256 `46c5a5df494ec6bd30e6ef17e66230c4a60dba7489cc8801454e15ed386b7507`.

Reviewed exact single-release batch: `tmp/overnight-2026-10-19/shift-audit-release.sql`, SHA-256 `fd8c4b1ce0a7e23a0212e7875fa6d28051522f6827d84384a8da294db4503eac`. It takes a bounded migration-ledger lock, requires version absent, applies only this writer change, and records the five exact source statements atomically. The standard Sygilant activation renderer was reused to prepare the private batch; its parser preserves quoted/dollar bodies and source bytes. The renderer invocation and fingerprints are retained in `tmp/overnight-2026-10-19/render-shift-audit-release.mjs` and `shift-audit-release-fingerprints.json`.

Separate forward recovery: `staged/20261019233511_recover_shift_timestamp_audit_writer.sql`. That version was generated with the official Supabase CLI and kept outside active migrations. Source SHA-256 `2c4a8aca859e055b109578c8c7982652f76f6e11ff51ae1d53682ad4b7626a90`; recovery batch `tmp/overnight-2026-10-19/shift-audit-forward-recovery-release.sql`, SHA-256 `8c4f3825a04ae482dcfc028fe6b02b1b16b8ac8a2be19d9f2878cc568755b3f1`. It requires the repaired writer fingerprint and restores the exact original writer with all security metadata and attachments preserved. It restores future timestamp auditing; it does not rewrite the already-applied ledger or fabricate omitted heartbeat events.

## Independent tests and boundaries

- Full restored production database on 127.0.0.1:55439, guarded exact database `overnight_recovery_fixture_v2_20261019`: actual retained draft shift, all original workflow/security/maintenance triggers, timestamp-only update suppressed, material notes update retains complete before/after JSON, SQL no-op becomes a timestamp-only final row and is suppressed, other-table timestamp/identical/NULL/JSON updates and INSERT/DELETE still audit. All six result flags true; outer ROLLBACK. Test `supabase/tests/shift_audit_timestamp_local_regression.sql`; combined exact candidate definition and result in `tmp/overnight-2026-10-19/shift-audit-restored-rehearsal{.sql,-result.txt}`.
- Separate guarded local database `shift_audit_column_fixture_20261019`: 24 exact production column names/types and the actual repaired generic writer, with local identity helper stubs and no business/FK triggers. Every one of the 23 business columns changed independently with a timestamp and produced complete old/new audit JSON. Truly identical final row audited. Timestamp NULL transitions suppressed. Added JSON business column changes, another table, INSERT and DELETE audited. All seven flags true; outer ROLLBACK. This isolates generic writer semantics; it does not claim hosted auth/FK acceptance. Test `supabase/tests/shift_audit_timestamp_column_matrix_local_regression.sql`; result `tmp/overnight-2026-10-19/shift-audit-column-matrix-result.txt`.
- Hosted rollback apply, contextual plpgsql_check with the actual shifts row type, and forward recovery: original hash restored, exact 104 attachments and production owner/ACL/configuration preserved. No shift or historical audit DML. Evidence `shift-audit-hosted-rehearsal{.sql,-result.json}` under the private temporary evidence directory.
- Hosted refusal tests: changed whole definition, changed ACL, and additional attachment each refused. Fixtures and function/ACL changes roll back; no real shift/audit DML. Evidence `shift-audit-hosted-refusal-rehearsal.sql` and `shift-audit-hosted-refusal-result.json`.
- Exact ledgered release and separate forward recovery both rehearsed against hosted production inside one outer BEGIN/final ROLLBACK. Candidate hash and transient ledger row verified; separate recovery restored original hash and both transient IDs were present before rollback. Evidence `shift-audit-exact-release-rollback{.sql,-result.json}` and `shift-audit-exact-release-recovery-rollback{.sql,-result.json}`.

The local restore retains permissions but has different owner/grantor identities; hosted metadata checks supply the production security proof. Hosted positive shift mutation remains unavailable during the approved maintenance gate. This candidate does not bypass that gate. Existing timekeeping and employee workflow acceptance evidence remains a separate release condition.

## Retention disposition

Repository/work-order searches found no approved job retention duration, deletion boundary, or legal-hold policy. The documented job-run FK is ON DELETE RESTRICT; referenced runs must remain addressable. No prune statement, delete cron, CASCADE, or invented retention window was prepared. HARDENING_PLAN.md and AUTHORIZATION_REVIEW.md retain the non-destructive daily-rollup/archive design and the exact policy/retrieval gates needed before physical reclamation.
