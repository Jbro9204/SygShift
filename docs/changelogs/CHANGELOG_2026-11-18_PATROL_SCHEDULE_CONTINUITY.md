# All-client patrol schedule continuity — 11/18/2026

Status: implementation and verification in progress; not yet deployed. This record supersedes the earlier guidance-only scope, not its historical test/deployment statements.

## Scope

- Preserve the exact same patrol occurrence when its week is republished, including employee-only publication. Use immutable schedule lineage and server-verified employee, location, time and work-type equality; never infer a route from a display name.
- Keep original patrol assignments, obligations, hits, media and report identities. Unchanged revisions point to the existing work instead of duplicating it.
- Changed or unverifiable shifts receive an explicit review state, not generic one-site fallback or expanded permissions.
- Operations can explicitly reconcile unused future work, or close unused removed work, with existing permission/MFA enforcement, a reason, immutable result receipts and audit history. Started work, reports, punches, evidence and makeup history block replacement.
- No automatic new-week recurrence is inferred. A copied future week is a separate occurrence requiring its own explicit route assignment.
- All client/property choices remain Operations-owned. Live incomplete MG and non-MG stop mappings are not guessed or silently backfilled.

## Preservation and rollout

No login, role, MFA, payroll policy or source punch changes are part of this repair. Both applications must consume the shared continuity contract before publication activation. Roll out additive foundation, Sygilant consumers/application, then publication activation and SygShift application. Never bulk-push the shared migration history.

After real continuity records exist, rollback must retain compatible readers and immutable records. Stop new publication linking if containment is required; do not restore a direct-assignment-only reader that hides already linked work, or delete aliases, receipts or history.

## Verification

- Final frozen SQL passed 302 isolated native lifecycle and rendered-release checks, including three successive revisions, saved intermediate-revision drafts, unchanged requirements, future reconciliation, permission denials, concurrent changes and protected data/catalog preservation. Eleven ledger-lock concurrency checks also passed.
- The fresh read-only production ledger contains 465 entries, with all historical source and ledger fingerprints preserved. Final source capture: `migration-ownership-2026-11-18-continuity-before-v3.json`, SHA-256 `bf823a697fbc5fe08c454dbe685ae56c2c91422c87d4d3436ed7a9a55399d4ee`. Earlier captures remain historical evidence, not the current candidate.
- Eight release-artifact tests passed. Application/browser checks and staged production release remain pending. Local tests are not signed-in field acceptance.
