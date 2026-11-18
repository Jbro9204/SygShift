# All-client patrol schedule continuity — 11/18/2026

Status: foundation and compatible reporting-reader database stages installed; final publication activation and application rollout pending. This record supersedes the earlier guidance-only scope, not its historical test/deployment statements.

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

- Final frozen SQL passed 305 isolated native lifecycle and rendered-release checks, including three successive revisions, saved intermediate-revision drafts, unchanged requirements, future reconciliation, permission denials, concurrent changes and protected data/catalog preservation. Eleven ledger-lock concurrency checks also passed.
- The fresh read-only production ledger contains 465 entries, with all historical source and ledger fingerprints preserved. Final source capture: `migration-ownership-2026-11-18-continuity-before-v3.json`, SHA-256 `bf823a697fbc5fe08c454dbe685ae56c2c91422c87d4d3436ed7a9a55399d4ee`. Earlier captures remain historical evidence, not the current candidate.
- Nine final release-artifact tests and 41 focused application tests passed. Twelve actual-component browser cases passed on 390px/1440px light/dark views: review failures retain the reason, an explicit retry confirms/refetches, removed unused work closes, and guards retain history without being able to create unsafe hits. No external requests or browser exceptions occurred.
- The initial clean-install SygShift candidate passed 2,657 application tests (one existing skipped case), 42 clock workflow cases, native gates and fresh production builds. The final activation-grant refinement must pass the exact-candidate gate again before release.
- Foundation and consumer rollback rehearsals passed, followed by verified installation at 466 and 467 ledger entries. The compatible authorizer fingerprint is `38503f715db30a238eff543ad891fb3f`; existing security metadata remained unchanged.
- The first activation rehearsal rejected a production default EXECUTE grant to `service_role` on the new review function and rolled back completely. The unapplied activation source now revokes that grant explicitly; the revised production rehearsal and expanded default-privilege regression pass. No global default privilege, employee permission or previously applied migration was changed.
- The observed 467-entry final-source capture is `migration-ownership-2026-11-18-continuity-consumers-v4.json` (SHA-256 `ddcc6378399882b33def1c4c5aa911e30b914e6a72ac8d3f970b0e89232284cd`). The 468-entry `migration-ownership-2026-11-18-continuity-expected-complete-v4.json` (SHA-256 `4f4c591bc1535f61e57d3a5c6aeaaa1a2446ab20d396a3832649ba8c24286392`) is a rolled-back rehearsal result, not a claim of live activation. The release gate must match it against fresh production before deployment.
- Live route/property mappings remain untouched. Signed-in field acceptance remains separate from these software checks.
