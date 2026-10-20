# Narrow authorization repair: installed and verified

Installed October 19, 2026 at approximately 23:44:46 UTC as `20261019233625` from pushed source `7f867dc630105d42f7ea472f3febb11d9198b017`. The actual mandatory fresh-ledger gate accepted the committed reviewed 371-version v2 baseline immediately before activation; the exact batch SHA-256 was `fb6d53c6109a00d3c6214ea755579994f99e6dfd69d4dbce3590ecc37598d022`. Installed five-group hosted validation passed with all four repaired hashes, ACLs, owners and configurations exact and all seven protected row counts unchanged. Evidence is in protected `backups/overnight-2026-10-19/authorization-deployment.json` and `authorization-installed-functional.json`. The independent notification DB/browser/Worker release remains held: its new reader statuses are incompatible with the deployed browser enum, readiness is 503 during scheduled maintenance, and authenticated release-canary credentials are unavailable. This database-only repair does not change those gates.

## Exact scope and existing policy

- `get_bible_schedule_preview(date)` now calls the existing `private.require_import_admin()` before reading protected source import evidence. Its public alias remains unchanged. This is the same MFA-filtered `admin.security.manage` boundary already used by adjacent source-review functions; no permission is created or granted. The authorized payload is byte-equivalent as JSON text, with its original shape and fields.
- `has_valid_credential(uuid,credential_kind,date)` becomes SECURITY INVOKER, preserving its exact query and signature/default. Direct authenticated calls therefore use the existing `employee_credentials` self-or-Licensing row policy. Production grants authenticated SELECT on that RLS-protected table. All 22 other captured function callers are SECURITY DEFINER, so their already-authorized qualification lookups retain the enclosing owner's context. No helper, compatibility table, role grant, caller rewrite, or new access policy is needed.
- `private.support_can_view` and `private.support_can_manage` add `public.has_mfa()` only to the elevated Admin branch. Employee own-ticket reads/replies remain available without privileged MFA. Non-Admin handlers retain the existing exact support-plus-route effective permissions. The existing verified MFA boundary includes trusted device/security-key/shared-session mechanisms; it is not replaced by a raw AAL2-only test.

All four edited functions retain their OIDs, owners, ACLs, argument names/types/defaults, return contract, search paths, volatility, strictness, parallel attributes, and other catalog contract fields. The intentional changes are the source reader's SQL-to-PL/pgSQL language needed for a guaranteed pre-read guard and the credential predicate's SECURITY INVOKER flag. No anonymous/private-schema privilege expands.

The migration guards 31 exact live definitions, owners, complete ACLs, and per-function configurations, including the 22 credential callers. A caller with an existing `search_path=public, private` retains that exact configuration; only the four edited functions have the original empty search path. It also checks the exact two credential policies, RLS and SELECT contract, MFA-sensitive permission metadata, and absence of a newly introduced invoker caller.

## Sources and recovery

Supabase CLI generated these names; they remain under `docs/work-orders/2026-10-19-overnight/staged`, outside active migration discovery:

- `20261019233625_authorization_boundary_hardening.sql`
- `20261019233735_recover_authorization_boundary_definitions.sql`

The corresponding transaction bodies are in `candidates/authorization_boundary_repair.sql` and `candidates/authorization_boundary_fallback.sql`. Forward recovery rejects drift from the exact reviewed repaired fingerprints and ACL/configuration before restoring the four exact captured before-definitions. It preserves both separate migration identities instead of deleting or rewriting an applied ledger row. Recovery reopens the known pre-existing authorization gaps, so its use requires an actual regression and separate release review.

| Function | Captured before MD5 | Verified repaired MD5 |
| --- | --- | --- |
| `get_bible_schedule_preview(date)` | `33e8759be4df799d9383e17e3265b463` | `8d4afde02e4623b04572db5fe08d94e6` |
| `has_valid_credential(uuid,credential_kind,date)` | `e5c3d9659547262f75f58c28f96bc5f1` | `05ce24272d6d1cff14e318f1283b851f` |
| `private.support_can_manage(support_tickets)` | `dedc73265327d5b487e99593e8a30097` | `0b7e58a617c0ddc18fefca26cc2b799d` |
| `private.support_can_view(support_tickets)` | `3dfbde398adadddc35f2796b8c217cbf` | `761615014994b6851c3fe1d0229ee421` |

Exact atomic release and forward-recovery batches were rendered with the existing reviewed migration-activation parser, an absent-version ledger guard, transactional ledger insert, and exact ordered statement arrays. Fingerprints are in `tmp/overnight-authorization/authorization-release-fingerprints.json`; executable batches and reviewed one-transaction rollback variants are in the same evidence directory. The repair batch was applied; the recovery remains unapplied.

## Allow/deny matrix and evidence

`supabase/tests/authorization_gap_local_regression.sql` passed all nine groups against the fully restored isolated fixture under one BEGIN and final ROLLBACK. The fixture substitutes only restored owner/ACL grantor `codex_task` for hosted `postgres` during rehearsal; production metadata is verified separately.

| Actor/workflow | Verified result |
| --- | --- |
| Unlinked authenticated caller | Source and ticket reads denied; existing credential predicate false. |
| Ordinary active employee, AAL1 | Own credential true with valid dates, false outside validity; peer credential false; source denied. Own ticket read/reply succeeds, internal notes/events hidden, management denied. |
| Employee urgent access, AAL1 | Own sick context plus actual date-only sick and call-off reports succeed. Existing clock permission and normal clock input-validation boundary remain reachable. |
| Admin, AAL1 | Elevated ticket read, assignees, mutation and internal note denied. |
| Admin, AAL2 | Cross-ticket/confidential read, assignees, real priority update and internal note succeed. |
| Non-Admin handler | AAL1 denied; MFA plus support and exact schedule route allows real management. Unrelated confidential HR route remains denied. |
| Existing Licensing/source permission, AAL1/AAL2 | AAL1 denied; AAL2 credential lookup/source preview succeeds. Current/legacy preview payloads equal and source JSON MD5 unchanged. |
| Nested definer recipient qualification | Qualified peer remains included while an ordinary employee is the caller; owner lookup remains complete. |
| Disabled account | Credential predicate false; own ticket/source denied. |

The isolated fixture lacks hosted live-update schemas and emitted deferred-update warnings; no provider or production operation was called. These warnings do not establish live-delivery verification. Its normal-access absence tests ran with the copied local maintenance window inactive; they do not prove urgent submission during the active production maintenance window. That independently discovered restriction is being repaired separately. Actual clock-in/out UI preservation remains a separate repository release gate.

`supabase/tests/authorization_gap_hosted_regression.sql` then passed five bounded hosted groups under BEGIN/ROLLBACK: unlinked denial, ordinary own/peer boundaries, Admin AAL1 denial, Admin AAL2 permitted reads, unchanged source payload, private-schema isolation and nested owner lookups. It performed no source, ticket, credential, employee, punch or schedule mutation. Transaction-local before/after counts remained: 313,694 audit rows; 57 credentials; 90 employees; 44 ticket messages; 2,568 punches; 64,629 shifts; 19 tickets. No names, contacts, ticket contents, source rows or employee IDs were returned by the probes.

The final exact atomic release batch, including its absent-ledger guard and precise statement-array insert, passed the same hosted groups with final ROLLBACK. A second exact release-plus-forward-recovery rollback confirmed original fingerprints restored, two distinct forward ledger entries present only within the transaction, and unchanged ACL/owner/searchpath. Both candidate and recovery separately rejected injected search-path drift on the isolated fixture, with automatic transaction rollback on disconnect.

Production evidence is `tmp/overnight-authorization/hosted-preflight-result.json`, `authorization-exact-release-rollback-result.json`, and `authorization-exact-release-recovery-rollback-result.json`. The preflight records all 22 caller identities, hashes, owners, ACLs, configurations and definer flags. Hosted `postgres` and `service_role` have BYPASSRLS; `authenticated` and `anon` do not. No anonymous execution or private schema access was added.

## Remaining gate

The three original findings are repaired and installed validation passed. No unresolved permission-cohort policy decision was needed: the repair reuses the established source, credential RLS and support MFA boundaries. Installed workflow validation uses only temporary result-table writes inside a final-ROLLBACK transaction; initial use of transaction READ ONLY rejected its temporary CTAS with SQLSTATE 25006, then the corrected rollback-only harness passed without persistent application DML. Separate discovery of a maintenance guard blocking the urgent absence path is being handled independently; these authorization changes do not open the maintenance window or bypass its manager/payroll restrictions. Real browser/MFA-session acceptance remains separate from transaction-local synthetic claims.
