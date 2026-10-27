# SygShift announcement banner delivery repair

Date: October 27, 2026
Application: SygShift
Status: released and verified in production

## Why this repair is needed

Production contains an active, urgent, company-wide banner, and the Announcements manager correctly shows it as active. The global workspace strip nevertheless omits it.

The employee-facing banner RPC combines two valid sources:

- dedicated records from `public.announcement_banners`;
- ordinary published employee announcements from `public.announcements`.

The dedicated-banner mapper returned the complete browser contract. The ordinary-announcement mapper omitted `lifecycleStatus` and `canceledAt`. Because the browser validates the complete mixed array, one visible ordinary announcement caused validation of the entire response to fail and hid every valid dedicated banner. The global shell then suppressed that query failure, making the condition look like an empty banner list.

## Repair prepared

- Added forward-only migration `supabase/migrations/20261027131606_repair_announcement_banner_delivery_contract.sql`.
  - Replaces only `private.announcement_workspace_record(public.announcements)`.
  - Adds `lifecycleStatus: "active"` and `canceledAt: null` to ordinary published announcements so both producers satisfy one strict lifecycle contract.
  - Preserves the function's controlled empty `search_path`, `SECURITY DEFINER` boundary, and revoked direct execution for `public`, `anon`, and `authenticated`.
- Updated `src/components/AppShell.tsx` so an initial banner-feed failure produces a concise, plain-language global warning instead of silently presenting no alert.
  - Existing cached banner data remains usable during a later background-refetch failure.
  - Raw database and validation details are not shown to employees.
- Updated `src/components/AppShellLifecycle.test.tsx` with rendered-shell coverage for an urgent global banner and the safe banner-load warning.
- Added `src/data/announcementsPayload.test.ts` to validate a mixed dedicated-banner and ordinary-announcement response through the real strict client parser.
- Added rollback-only database regression `supabase/tests/announcement_banner_mixed_feed_contract_regression.sql` to verify both fixture types appear in one feed with the complete lifecycle fields.
- Added `tools/prepare-announcement-banner-contract-release.mjs` and its release-gate test so production activation is one fingerprint-guarded transaction with an exact migration-ledger record, plus a rollback-only rehearsal path.

## Data and operational safety

This repair does not modify, cancel, delete, republish, or recreate any existing banner or announcement record. It does not change announcement audience rules, expiration rules, permissions, MFA requirements, delivery history, acknowledgments, notification behavior, schedules, punches, payroll, identity, or audit history.

The database change is a forward-only function replacement. If rollback is required, restore the prior reviewed mapper definition and roll back the matching application commit. Existing records require no data rollback.

## Verification status

Completed verification:

- mixed source payload parsing;
- urgent banner rendering in the global workspace strip;
- plain-language handling of an initial banner-feed failure;
- rollback-only database verification of both source types and their lifecycle fields.
- focused browser regressions: 30 passed;
- complete `pnpm check`: 2,263 application tests passed, 183 release-tool tests passed after the release preparer was added, and the production build/static-asset contract passed;
- `pnpm release:verify`: 42 Time Clock browser tests passed across desktop and mobile, in addition to the complete application and build gates;
- production rollback-only activation rehearsal: passed without retaining the candidate ledger entry or test fixtures;
- reviewed pre-activation migration ownership manifest: 398 applied migrations, with only the new banner repair source added as local and not yet approved for production.

Release completion:

- Cloudflare deployment of the plain-language banner-feed failure fallback: complete;
- post-deployment health/readiness, exact-source, scheduled-runtime, and authenticated banner verification: complete.

## Production activation evidence

- Pushed implementation commit `b47643b068a9008f19872d4b13d14ead9ddff54f` to exact `main`.
- GitHub quality workflow `40513619204` passed for that exact source, including CodeQL and the exact-candidate quality gate.
- Applied only migration `20261027131606_repair_announcement_banner_delivery_contract` through the fingerprint-guarded atomic release artifact.
  - Atomic release artifact SHA-256: `9FA56D7F4614917B6A855161C1CF5B9065BBF5197CF413B0E6EBFD63714D1F57`.
  - Installed migration source MD5: `0cd672c0264d344c8a3a4e08cbc01bd3`, matching the local migration source.
  - Installed mapper MD5: `106880ad7994e05f16151cca182c1c47`.
  - The mapper remains owned by `postgres`, `SECURITY DEFINER`, `STABLE`, pinned to an empty `search_path`, and executable only by `postgres`.
- Production now has 399 applied migration identities; the post-activation ownership manifest records the new migration as an exact version-and-name source match without changing earlier migration identities.
- Re-ran the mixed-feed rollback-only production regression after activation; both banner source types returned their complete lifecycle contract and no fixture row was retained.
- Opened a fresh authenticated production session and verified the active urgent `System Maintenance!!` banner appears in the global `Workspace alerts` region with its existing message. No banner or announcement record was edited to produce that result.

## Application release evidence

- Released exact source `01dd28b9858c227c86a49a20fc7b9e4a07feb31f` as Worker version `51ceb2bb-f759-421c-bc53-1927d5cbe3b0`.
  - Prior production source: `ccd31ed2a9bf15eaf06af668e494f91ea92aef95`.
  - Prior Worker version: `c2e9b3c3-989a-4eab-bc26-9ee4a38ddda0`.
  - Promotion outcome: released; promoted `true`; rolled back `false`.
- The release gate revalidated the fresh 399-migration baseline immediately before deployment and reran the complete application, release-tool, browser, and production-build gates.
- Because no approved release-canary credentials were loaded, the guarded release used its documented anonymous boundary probe. Wrangler did not return a candidate Version URL, so candidate-only preview checks were unavailable; the workflow retained production health monitoring and exact rollback protection.
- The first normal scheduled-runtime full success after promotion completed at `2026-10-27T14:14:55.426Z` on the exact released source.
- Independent post-release checks confirmed:
  - `/api/v1/health` returned HTTP 200;
  - `/api/v1/ready` returned HTTP 200 with `ready: true`;
  - scheduled runtime mode `closed`, `consecutiveFailures: 0`, and exact released source commit;
  - the production root returned HTTP 200 with the SygShift application shell;
  - a fresh authenticated browser session reported SygShift `Online` and visibly rendered the existing urgent `System Maintenance!!` banner in the global workspace alert strip.

The failure fallback was verified by rendered-shell regression tests rather than by deliberately breaking the production banner feed. The banner delivery repair is released and verified in production.
