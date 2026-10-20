# Notification client compatibility candidate

Prepared 10/19/2026; validation finished 10/20/2026 UTC. **Held for review; no production deployment.**

Source is isolated in `C:\Users\Jordan\Projects\SygShift-notification-compat-20261019`, branch `maintenance/notification-client-compat-20261019`. It starts from held notification commit `3145e2a2df7426aec5c61f05ec29102b923d03a8` and merges main `b2028d185dca923c9f34088d81355b13787b40cc` in `d2ef329`. No primary-worktree source was edited, no provider was contacted, and no production SQL was executed for this task.

## Contract repair

An already-open deployed browser parses the paginated `get_notification_center` response with `queued`, `delivered`, and `failed` as its complete status enum. The original held candidate added three other states to that endpoint, which would reject the entire response in the old browser.

The revised candidate preserves the paginated legacy endpoint's exact JSON keys and three-state expression. It adds only leaf-generation filtering, so successful authorized retry children supersede old failed ancestors without changing recipient counts. The new application explicitly calls `get_notification_center_v2`; expanded terminal states and counts exist only there. It does not retry a missing/denied v2 call through the old endpoint. Both paginated functions retain the verified permission/MFA checks, owner, authenticated/service-only execution boundary, stable volatility, JSONB result, and empty search path. New-function default PUBLIC execution is revoked in the same transaction.

The separate zero-argument API returns the older `summary`/`recent` contract, with at most 25 raw historical rows and its original supervisor/admin authorization. Its definition, grants, owner, configuration, and shape remain unchanged. A direct no-argument SQL invocation is already ambiguous with the all-default six-argument overload; the local test executes an exact temporary clone of the older body. This is not a claim of a live REST request against that overload.

## Critical delivery handoff correction

Review found a separate defect in the previous proposal: a pending fifth attempt may still be waiting for provider acceptance. Automatically adding a failure timestamp would reject the real late success marker, allowing a later manual retry to resend an accepted message.

The revised candidate never terminalizes a timestamp-null pending row. It briefly locks the three queues before checking unresolved results, with a two-second lock budget and two-second total transaction budget. It aborts the entire installation if any pending row has a positive attempt count or a non-null attempted timestamp, including recorded transient failures. A non-null error can belong to one callback while another overlapping provider attempt still runs; it is not a zero-in-flight proof. All three captured old claimers clear that error before calling the provider; generic and employee claimers do not persist an ownership lease. Aged timestamps alone are not proof of failure. The table lock prevents a new claim from slipping between the check and installation. The migration does not pause producers, disable clock/call-off access, or wait for a provider result.

An ambiguous exhausted row must retain its current evidence and remain outside manual retry until a real outcome is established. This is a deployment blocker, not permission to reset it. The archived production baseline contains such an outbox row; no new production measurement or provider confirmation was made in this task. The local positive rehearsal supplies explicitly synthetic failure completions for restored unknown rows only inside the rollback transaction; those are not evidence about production delivery.

Existing failed rows receive additive classification metadata and append-only audit evidence. Their existing timestamps, errors, attempts, payloads, and audit records remain intact. Structured future provider suppression and the original terminal/retry-generation protections remain in the candidate. Old Workers can continue using their existing service RPC contracts after the database phase. They do not acquire the new structured provider suppression behavior until the new Worker is promoted.

## Candidate and forward recovery

The never-applied proposal `20261019230338` is replaced on this isolated branch by CLI-generated migration **`20261020001825_notification_terminal_state_compatibility.sql`**. It refuses either proposal version already being recorded, unexpected reader/suppression identities, baseline definition/ACL drift, or an unresolved provider handoff. It does not rewrite any applied migration. The old ownership manifest is historical evidence and must not be reused as a fresh source manifest for this changed candidate.

Recovery candidate **`supabase/recovery/20261020001855_notification_reader_compatibility_fallback.sql`** remains outside the active migration queue. It requires the repair ledger entry, absence of its own recovery ledger entry, exact after-definition hashes, and exact owner/ACL/security/search-path/volatility/result contracts for all three readers. It replaces only v2 with an authorized delegate to the legacy paginated reader and returns `deliveryVisibility=legacy`, which the new UI visibly explains. Expanded terminal filters temporarily have no results; unrelated failures are never relabeled as confirmed suppressions. Both old reader contracts, every terminal guard, all writer APIs, all retry generations, and all history remain intact.

| Artifact | SHA-256 |
| --- | --- |
| Repair migration | `097c8779463bc6f11872ba78d5ae999254240693232a31a765b892351940e03c` |
| Forward reader fallback | `4ad0e31f267bd39c7d33aa989f75c2221cc299ff6c9f9880e6ed7a9f7f925d8c` |

| Reader | Verified repaired definition MD5 |
| --- | --- |
| Legacy no-argument API | `e1e39a69d2eb370bfb91bc488bfad0f7` |
| Legacy paginated API | `84c182bcf5067bc10b0703e82ff3783e` |
| Expanded v2 paginated API | `0bb1de22b06099f004db8976d88fa8f4` |

If the application alone must fall back, return to its verified previous Worker/assets version and retain the compatible database as the recovery floor. Do not restore pre-repair writer bodies or remove additive columns. If the v2 reader itself requires recovery, reserve a fresh forward version if this staged recovery version is no longer ahead of the applied head, refresh the manifest and exact expected after-state, rehearse it, register the exact reviewed statement array, and deploy only that recovery. Re-enabling expanded v2 after such recovery also requires a new reviewed forward migration; the base table-changing repair must never be replayed.

## Validation evidence

`node tools/rehearse-notification-compat.mjs` is restricted to `127.0.0.1:55439`, user `codex_task`, and a named isolated restored fixture database. It preserves every SQL guard, mapping only hosted `postgres` owner/grantor metadata to the restored local owner. It verifies exactly one outer BEGIN, no COMMIT, and one final ROLLBACK. Local PostgreSQL 18 complements the hosted PostgreSQL 17.6 baseline; a fresh hosted rollback rehearsal remains a prerequisite for production installation.

All eight grouped SQL outcomes passed:

- Refuse an in-flight fifth outbox attempt; preserve its row; allow the old marker to record acceptance after refusal.
- Independently repeat that handoff rejection and valid old acceptance for support and employee-email queues; also reject a first-attempt outbox row with a recorded transient error because overlapping provider activity remains possible.
- Thirteen baseline logical payload comparisons, all fields and complete filtered row sets. Three cases exposed the original reader's undefined ordering of equal `created_at` values. Ordered timestamps and all row values matched; two uniquely ordered fixture pages retained strict complete JSON equality. This is not byte-identical ordering for the undefined ties.
- Original terminal classifier/late-result/suppression/authorization/clock-out versus schedule claimant regressions.
- Independent mixed accepted/failed child/grandchild retry generations, duplicate retries, immutable ancestors, and both reader versions showing queued/delivered leaf state with the correct recipient count.
- Five-phase old/new runtime contracts: exact legacy keys, all three legacy states, expanded v2 states, filters, pagination, recipient safeguards, same metadata/ACL, AAL1 denials, and AAL2 non-manager denials. Actual SQL JSON passes the retained deployed Zod schema and current parser.
- Forward recovery rejects absent repair ledger, altered legacy configuration, broadened v2 ACL, and altered v2 configuration.
- Valid forward recovery preserves old reader hashes, all queue rows, audits, retry/inbox records, and ledger data while producing a supported coarse response and explicit visibility notice.

Restored snapshot before and after the complete rehearsal:

| Data | Rows | UTC row JSON hash / verification |
| --- | ---: | --- |
| Outbox | 660 | `43d6b686f6e27a90a1f1fb78cda85cc0` |
| Support deliveries | 187 | `dcf3be7fcda8a069257504ed47ff392b` |
| Employee email deliveries | 83 | `9fbe5c44aadd620638f797de1d49f793` |
| Audit events | 313,694 | Count unchanged |
| Email delivery audits | 5,405 | Count unchanged |
| Retry events | 0 | Count unchanged |
| Employee inbox records | 1,052 | Count unchanged |
| Restored migration ledger | 366 | Count unchanged; synthetic repair ledger rolled back |

Final `pnpm check` passed: **380 test files / 2,228 tests**, one existing skipped file/test, strict TypeScript, zero-warning lint, **95 release tests**, build, and static-asset contract. Earlier attempts encountered one existing PDF paint timing failure (focused rerun passed) and a test run overlapping the optional recovery-schema edit; neither was accepted as a gate. The final frozen application gate passed.

Actual-component Playwright checks passed **46/46**: four Notification Center checks covering v2 selection, terminal controls, authorized retry, and the recovery notice on desktop/mobile, plus all 42 mandatory Time Clock workflows. All four notification screenshots were inspected; no horizontal overflow. A fresh production-mode build was run after the final browser checks. Local build success does not authorize deployment or substitute for production configuration/canaries.

Ignored receipts are in `tmp/notification-compat/`: `local-rehearsal.sql`, `local-rehearsal-result.log`, `reader-contracts.json`, `fallback-contract.json`, `pnpm-check-final.log`, `contract-final.log`, `playwright.log`, and `post-browser-build.log`. Screenshots remain under `test-results/`.

## Required phased release and remaining gates

1. Review this branch and integrate current main through normal source control. Re-capture owning migration sources, the live ledger, queue/provider state, current definition/ACL/owner/config fingerprints, and a verified fallback. Produce a fresh source manifest and real mandatory database release gate. Do not bulk-push unrelated local-only migrations.
2. Establish definitive outcomes for ambiguous exhausted deliveries without replaying them. Freshly rehearse the exact repair on hosted PostgreSQL under one rollback transaction. The installed migration itself enforces the final short locked zero-unresolved handoff check; failure leaves the prior verified production state and requires another review, not a forced gate.
3. Install and validate the additive database phase. The old Worker and already-open old browsers remain supported. Validate full old/new reader contracts and queue/history invariance. Do not claim the new structured suppression path is active while the old Worker remains deployed.
4. Only after normal readiness and authenticated release canaries pass, promote the verified browser/Worker source through the existing release tooling, with the required fresh configured production build. Do not bypass maintenance, scheduler, MFA, or canary gates. Monitor both client reader versions and distinct suppression/terminal/error signatures.
5. If a gate fails, retain the last verified state. An application fallback retains the compatible database. A database reader fallback uses only the exact guarded forward recovery described above, with its own fresh ledger/source gate and post-validation.

**Production status:** this compatibility task deployed nothing, queried no live provider, sent no email, and made no production data change. The approved maintenance readiness/canary gates and unresolved provider outcome gate remain deployment blockers. No production before/after error-count improvement is claimed.
