# PostgreSQL deterministic-conflict repair — 2026-10-31

## Verified scope and cause

The fresh shared-production catalog contained 46 additional functions with 75 explicit application-generated serialization failures. These were deterministic rejections: stale versions, a changed scheduling or site reference, pending evidence, or an obsolete reviewed source. Retrying the same transaction cannot resolve those conditions. On PostgREST 14.5, the `40001` classification can repeatedly retry these otherwise fast failures and monopolize database capacity used by login and other work.

The expanded audit examined 101 catalog candidates, including `ERRCODE`, named conditions, and `40P01`/deadlock references. It found no additional dynamic `ERRCODE` expression, genuine engine-generated serialization rethrow, or explicit deadlock case requiring an exception. PostgreSQL-generated transaction errors remain unchanged. This is not a claim that every query or application workflow has been optimized.

Ownership was kept separate:

| Source owner | Functions | Rejection clauses | Areas |
| --- | ---: | ---: | --- |
| SygShift | 7 | 19 | Tasks, recurring tasks, announcements, schedule editing/coverage, HR library source adoption/retirement |
| Sygilant | 39 | 56 | Report lifecycle/evidence/exports, dispatch, historical imports, client activation/portfolios, templates, fuel receipts, SygSales |

Every function and original rejection clause is listed in each owner's `docs/reliability/postgres-retry-safety.json`. No employee-specific exception or scheduled-hours substitution was introduced.

## Applied change

The two forward-only migrations change only the reviewed error classification to `PT409` (HTTP conflict):

- SygShift `20261031183447_deterministic_conflict_retry_safety.sql`
- Sygilant `20261031183448_sygilant_deterministic_conflict_retry_safety.sql`

Each target is fenced by the exact observed `pg_get_functiondef` MD5 and full non-body `pg_proc` metadata MD5. Replacement positions are Unicode character positions applied in descending order. The after-definition fingerprint and metadata are checked again immediately. Permissions, owners, search paths, volatility, signatures, defaults, conditions, locks, validations, and table writes are preserved.

A third, independent Sygilant migration (`20261031183920_sygilant_service_runtime_budget_diagnostic.sql`) adds a read-only, stable, security-invoker RPC returning only the current database role and effective statement/lock timeouts. Only `service_role` can execute it. It does not change any timeout or expose user records, secrets, headers, or claims.

## Activation and preservation proof

The prepared driver reuses Sygilant's reviewed activation renderer and exact statement-array ledger format. All three migrations were first rehearsed in one rollback-only transaction, then activated in one transaction after explicit approval. No historical migration or historical ledger entry was rewritten.

- Before: 436 ledger entries; original aggregate MD5 `5b1e5b26c308eca716389e31aeca80b6`.
- After: 439 entries; the same aggregate MD5 for all original 436 entries.
- Rollback rehearsal batch SHA-256: `46111980ffc88c14ebbe8f32ccdb51164beb9c50d0cca970a6a100f36e625643`.
- Committed activation batch SHA-256: `9d9db0d25e9f2e34ae468a8907160b5ff4762d5ab9a297e8d16b90bec2ca3182`.
- Activation CLI wall time: 3.095 seconds; including subsequent read-only catalog/ledger verification: 9.125 seconds. These are end-to-end tool timings, not isolated SQL execution timings.
- All 46 final function definitions and metadata match their expected fingerprints. The 101-candidate catalog has no remaining explicit retry-state raises.
- The selected incident report, its versions, decisions, and indexed audit history had identical before/after fingerprints inside the transaction. No source punches, payroll, schedules, identities, or permission records were edited.
- Actual PostgREST invocation: `service_role`, statement timeout `8s`, lock timeout `8s`, HTTP 200. Anonymous invocation returned HTTP 401; catalog privileges deny both `anon` and `authenticated`.
- After activation, health and readiness both returned HTTP 200; readiness was true, consecutive failures were zero, and runtime source-commit verification was true.

## Regression and release controls

The reusable lexer distinguishes executable raises from comments, quoted messages, and stored replacement text. Tests cover named and numeric raises, explicit severity, true exception-handler rethrows, dynamic error-code refusal, quoted bodies, repeated replacements, security fingerprint drift, immutable history, missing/partial activation, and newly introduced unsafe live functions.

Old immutable migration files retain their original definitions. The static guard accepts only explicitly inventoried historical sources whose SHA-256 still matches (UTF-8/LF normalization only). It rejects new or modified retry-bearing SQL. The mandatory SygShift production release gate additionally reads the current catalog, checks both owner manifests, and requires the expected effective definitions/security. Sygilant's quality gate runs its owner-specific static guard and tests.

Targeted results: 23 SygShift tests passed, 10 Sygilant tests passed; both source guards passed (409 SygShift and 162 Sygilant migration files). Full application/release checks and client conflict handling are coordinated in the main reliability work order.

Read-only postflight command, run through the pinned package-manager script:

```text
pnpm database:retry:verify --phase=after --sygilant-root=<absolute-owning-Sygilant-checkout>
```

## Fallback and limits

Before commit, any fingerprint, privilege, ledger, sample-record, or lock-budget failure aborts the whole activation. The activation driver refuses replay because the original 436-entry baseline no longer matches after success. A frontend rollback must retain these safe database error classifications. Do not restore `40001` to deterministic conflicts as a fallback; make a new reviewed forward correction if a conflict mapping needs adjustment.

The exact after-fingerprint gate deliberately requires a new reviewed manifest when a future legitimate migration changes one of these functions or its security metadata. General query performance, login bulkheads, browser request handling, and sustained overnight monitoring remain separate verification obligations; this repair does not by itself prove those systems cannot fail.
