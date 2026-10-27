# SygShift announcement banner delivery repair

Date: October 27, 2026
Application: SygShift
Status: implementation prepared; production migration and deployment pending

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

Pending before release:

- production migration application and verification;
- exact-main push and successful GitHub quality run;
- Cloudflare deployment, health/readiness checks, and authenticated live banner verification.

No production release is claimed by this changelog.
