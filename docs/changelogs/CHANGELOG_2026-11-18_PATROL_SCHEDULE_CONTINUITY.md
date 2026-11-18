# All-client patrol schedule continuity — 11/18/2026

Status: coordinated database and application repair deployed and verified on 11/18/2026. Operational property confirmation and real-user field acceptance remain open. This record supersedes the earlier guidance-only scope, not its historical test/deployment statements.

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

## Production closeout

- All three exact migrations are installed. The observed 468-entry ledger is retained in `migration-ownership-2026-11-18-continuity-complete-v4.json`, SHA-256 `f6924c847b24e225709c83c462e3d01cc14246fa6dac6cae352de1f36a8d51c0`. It matches the reviewed expected state, while the earlier captures remain unchanged.
- Sygilant source `577a9f8b28c4fadc21282fb9615b13648dfe6396` passed exact clean-install verification, 4,724 application tests and GitHub push run `44321473704`. Pages deployment `a4a08df8-8834-430d-9e68-b4e4ce22b2af` succeeded. Production verification passed 14 pages, 31 protected reads, one rejected hostile-origin request and 150 versioned assets. Its documentation closeout run `44325504781` is also green; that documentation-only revision deliberately does not replace the running application bundle.
- SygShift application source `878352a315a582ccfa3970873061c278e2c16c63` passed the full clean-install candidate gate and GitHub push run `44324433823`, plus the deploy-time application/database/clock gates. Worker `4ef3ddbf-05bf-4191-a418-4d44d7b9fa1f` is serving production. No production rollback was required.
- The new natural full runtime succeeded at `2026-11-18T14:58:52.718Z` on that exact source. Health/readiness return 200, all 12 readiness checks pass, and consecutive runtime failures are zero. Final database readback confirms the publication trigger is enabled, the new review action denies anonymous and service-role execution, and authenticated callers retain its independently enforced permission/MFA boundary.
- The original three patrol assignment records remain; no historical route links were invented, and no continuity or resolution row was fabricated during activation. Schedules, punches, payroll, identities, permissions, existing reports and evidence were not rewritten by this release.

## Release-tool correction and remaining limitations

- One pre-upload workstation check returned a generic failure without retained child output. An independent visible full gate and the later fully logged gate passed; its original cause was not established, and no production upload occurred on that failed attempt.
- The fully logged upload succeeded, but an immediately following version list omitted its new version. Promotion stopped. The exact upload receipt was independently verified against the current source, direct version metadata, unchanged prior production, the fresh database baseline and completed gate log. The existing tested post-upload promotion/rollback verifier then completed the release and proved the new natural runtime.
- The release tool now accepts that narrowly validated receipt when the listing is stale and verifies the candidate's exact ID/source on every path. Seventy-four focused release-tool tests cover malformed/duplicate/old receipts, wrong metadata, conflicting uploads and unchanged normal paths. The closeout candidate still receives the complete main-branch gate; these tool-only changes do not change the running application bundle.
- The approved anonymous-boundary fallback was used. No new employee credential, committed test punch, real report submission or real approval was created for testing. Real-device Guard → supervisor → client acceptance is not claimed.
- Operations must confirm the incomplete MG and non-MG property links and connect their intended routes to current published assignments. The repair supports every client; it does not guess those business choices or grant guards all-site access.
