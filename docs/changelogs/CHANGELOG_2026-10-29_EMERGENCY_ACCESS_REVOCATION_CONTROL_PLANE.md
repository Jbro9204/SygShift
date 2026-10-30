# SygShift emergency access revocation control plane

Date: October 29, 2026
Application: SygShift, with connected Sygilant session invalidation
Status: predecessor released and verified; independent application path superseded by the centralized bridge

## Supersession record

The database migration described below was activated before the cross-platform Sygilant control plane was finalized. Its tables, receipts, session tombstones, ownership evidence, regression artifacts, and activation evidence remain preserved. They are historical security evidence and are not deleted or rewritten.

The SygShift-specific Worker endpoints and User Accounts revoke/restore modal described below were released with the predecessor control plane. The later centralized bridge removes that independent application mutation path. Sygilant Security Center becomes the sole emergency-access mutation authority, while SygShift contributes exact platform-session registration, forced-logout handling, offline revalidation, and exact-session cleanup acknowledgement. Its User Accounts screen links authorized administrators to the centralized workflow.

Forward-only convergence retires the legacy SygShift mutation RPC permissions and preserves fail-closed account markers. No historical operation is treated as a verified cross-platform central receipt, and an existing disabled account requires controlled adoption by the centralized workflow.

## Why this change is needed

The former User Accounts **Disable login** control changed one SygShift database timestamp. It did not prove that the employee's Supabase Auth sessions, refresh capability, trusted devices, security-key sessions, connected-platform sessions, presence, push registrations, and password access were all ended. The interface nevertheless described the employee as signed out. Re-enabling the database flag could also leave the account split between SygShift and the identity provider.

An emergency access action must have one authoritative result: either every access surface is verified revoked, or the account remains blocked with a durable receipt identifying the unfinished provider cleanup. It must never terminate employment or alter schedules, punches, payroll, licensing, roles, client records, or audit history.

## Control-plane design

- Replaces the browser-only account toggle with protected Worker endpoints for state, revocation, and restoration.
- Requires both `admin.users.manage` and `admin.security.manage`, a recent authenticator or registered security-key verification, a 10–1,000 character reason, exact username confirmation, an explicit preservation acknowledgment, and a stable idempotency UUID.
- Rejects self-revocation and preserves at least one recovery-capable active Admin.
- Applies the SygShift database deny boundary first and records a token-invalid-before epoch plus the exact emergency operation marker.
- Rotates the Supabase Auth password to a high-entropy unknown value and applies a long provider ban through the supported Auth Admin API. Password rotation invalidates the provider's existing sessions and recovery tokens; the database independently tombstones observed session identifiers.
- Revokes or removes app-owned trusted-device sessions, security-key sessions, SygShift shared-identity sessions, connected Sygilant shared-identity sessions, presence, enabled push subscriptions, and pending shared launches.
- Verifies zero active Auth sessions and refresh tokens before recording revocation complete.
- Keeps partial or failed provider cleanup fail-closed. It does not reopen access as compensation.
- Resumes an interrupted operation with its original idempotency UUID and recorded reason; reopening the modal does not create a conflicting parallel operation.
- Stores idempotent operation state, append-only operation events, immutable session tombstones, exact cleanup counts, provider outcome evidence, and ordinary audit events.

## Restoration design

- Restoration applies only to the matching active emergency revocation; it cannot clear an unrelated legacy disable, separation, or another operation's marker.
- A legacy-disabled account cannot be silently converted into an emergency revocation. Its earlier disable reason remains intact for a separate access review.
- The employee must still be active and have an approved recovery recipient.
- While the account remains banned and database-disabled, the Worker generates and successfully delivers a fresh recovery link to the approved personal-first address.
- The Worker then removes the provider ban. Only after provider and zero-session verification does the database clear the matching emergency marker.
- The randomly rotated password, old sessions, remembered devices, and shared sessions are never restored. The employee returns through the new recovery link and signs in as a new session; existing MFA factors remain unless a separately authorized MFA reset is performed.
- Delivery, provider, or database-finalization failure leaves access blocked and returns the durable partial receipt for safe retry.

## Data and operational safety

This update does not terminate an employee and does not modify employment status, usernames, identity records, role or permission assignments, schedules, shift assignments, punches, time corrections, payroll calculations or exports, licensing, clients, documents, or historical audit records. It does not delete registered MFA factors. The former direct browser RPC is retired so a stale client cannot bypass the comprehensive workflow.

The database change is forward-only. Rollback of application code must not remove an active emergency marker or revive a prior session. Any rollback procedure must preserve the fail-closed database state and use the audited restoration workflow for each affected employee.

## Historical implementation inventory

- Database authority: `supabase/migrations/20261029225323_emergency_access_revocation_control_plane.sql`
- Rollback-only database regression: `supabase/tests/emergency_access_revocation_control_plane_regression.sql`
- The previously released SygShift-local Worker orchestration, browser data contract, and modal are superseded by the centralized bridge and have been removed from the bridge release branch.
- The centralized SygShift bridge is documented in `CHANGELOG_10-29-2026_CENTRAL_EMERGENCY_ACCESS_BRIDGE.md`.
- Fingerprint-gated activation tooling: `tools/prepare-emergency-access-revocation-release.mjs` and `tools/prepare-emergency-access-revocation-release.test.mjs`
- Security architecture: `docs/SECURITY.md`

The forward-only central convergence retires authenticated execution of both the former direct account-state RPC and the superseded SygShift-local mutation RPCs. A stale browser cannot use either shortcut to clear or create an emergency marker. Sygilant is the single administrative control plane, while SygShift remains a session-enforcement participant.

## Verification status

Completed during implementation:

- exact Node.js 24.19.0 / pnpm 11.25.0 toolchain validation, TypeScript verification, zero-warning lint, and production builds/static-asset validation;
- 387 passing application test files and 2,275 passing tests, with one intentionally skipped file/test;
- 189 passing release-control tests, including six tests for the fingerprint-gated migration artifact;
- 42 passing mandatory Time Clock browser checks across desktop and mobile;
- rendered emergency-access interaction coverage for confirmation gating, completed and partial receipts, restore delivery, original-operation retry, and legacy-disabled protection;
- Worker authorization, recent-MFA, idempotency, provider-failure, recovery-delivery, fail-closed partial-state, and interrupted-operation coverage;
- a generated rollback-only activation rehearsal against production PostgreSQL 17.6 containing the exact migration and both SQL regressions under one outer transaction;
- post-rehearsal verification of zero candidate ledger rows, tables, columns, RPCs, employee fixtures, Auth sessions, and refresh-token fixtures retained;
- clean-checkout gate repair of the pre-existing Schedule account-handoff race, keeping queries paused until the new account's state and URL agree, with repeated date-retention regressions passing;
- fresh pre-activation ownership capture of 421 production migration identities, reconciliation of the 22 entries added after the prior reviewed baseline to current Sygilant default-chain and canonical-HR source evidence, and confirmation that no prior identity, statement-array checksum, owner, or owning-source checksum changed;
- generated rollback-only artifact SHA-256 `f3056421f8a4284cea679dbe94ffa964ba7a2591bc5e1ee5a1b50daa90f06964` and atomic release artifact SHA-256 `41a510b37c0bd9a90024329a1b0db6c9cd9cb50dfbc7bf094afe113fd9d4b1e8`;
- exact source `27b203420391865a3d73568b4aaac12984954a88` pushed to `origin/main`, followed by successful GitHub Actions run `40976027648`: CodeQL JavaScript and TypeScript job `123804148736` and Exact candidate quality gate job `123804148950`;
- production activation of only migration `20261029225323` through the reviewed atomic artifact, with all in-transaction preflight, schema/function/ACL/RLS/index/trigger postflight, and exact-ledger checks passing;
- independent live verification of a 422-entry migration ledger, one exact stored migration statement with source SHA-256 `f9bc9d56659662adaa8ec42fcebfa4412be00d890f57d44c0b19c80eda0a0335`, and the required operation, event, session-tombstone, revoke, and restore contracts;
- installed rollback-only emergency-access and atomic-role regressions passing against production without retained synthetic employee, Auth, session, schedule, punch, payroll, or emergency-operation data;
- post-activation ownership evidence at `docs/work-orders/2026-10-29-emergency-access-revocation/migration-ownership-post-activation-v2.json`, file SHA-256 `5245048ac9ba03b2982506bb2a21f53878d6c694d4223288130d8964ce244541`, preserving every earlier applied identity, statement-array checksum, owner, and owning-source checksum while adding only version `20261029225323`; and
- pre-deployment production checks returning HTTP 200 for the root, login, health, and readiness routes, with `ready=true`, scheduled runtime `closed`, and zero consecutive failures.

## Production release

- Committed the reviewed post-activation evidence as exact source `3cc2a31eb69b028e73d047e3b3af96b18f72f25d` and pushed it through the complete clean-checkout gate.
- GitHub Actions run `40978594959` completed Exact candidate quality gate job `123812664367` and CodeQL JavaScript and TypeScript job `123812664695` successfully for that exact SHA.
- Released Cloudflare Worker version `02ee56ae-7692-4072-a4e2-fbf1c071a1da`. The prior version `51ceb2bb-f759-421c-bc53-1927d5cbe3b0` at source `01dd28b9858c227c86a49a20fc7b9e4a07feb31f` remains the rollback floor.
- Wrangler did not expose a candidate Version URL, so candidate-preview smoke checks were unavailable. The release therefore used the explicitly allowed anonymous boundary probe, then exact-version promotion, 16 post-promotion probes, two upstream probes, and two status-reconciliation reads. Promotion was unambiguous and no rollback occurred.
- The first natural full scheduled-runtime success advanced from the pre-promotion watermark to `2026-10-30T00:29:59.065Z` and reported exact source `3cc2a31eb69b028e73d047e3b3af96b18f72f25d`.
- Independent production checks returned HTTP 200 for root, login, health, and readiness; `ready=true`; scheduler mode `closed`; zero consecutive failures; and every readiness check true.
- The live `UserAdminPage-BehrmUxm.js` asset matched the reviewed build byte-for-byte at SHA-256 `360ecfd2617c45858a338aed0a93c67050f03df031ab6834efda98e4cbdd0137`. The protected emergency-access endpoint returned 401 without authentication.
- Final database readback found zero emergency operations, operation events, revoked-session tombstones, synthetic employees, or synthetic Auth users. No real employee account was used as a deployment test.

## Central convergence release addendum

The centralized bridge was subsequently released from exact source `dd5b532df4f792dd60be98002909b84d42c11e66` as Cloudflare Worker `40129fe3-84d2-4d5c-956f-3c9339711f39`. This predecessor Worker, `02ee56ae-7692-4072-a4e2-fbf1c071a1da` at source `3cc2a31eb69b028e73d047e3b3af96b18f72f25d`, remains only the application rollback floor. A rollback must not restore the retired browser-driven mutation controls or revive an account disabled by the central authority.

After compatible application paths were live, the forward-only `20261029233000_activate_emergency_access_control_plane` migration was applied. Activation postflight and the rollback-only canary passed. The resulting repository-relative 427-entry ownership baseline has file SHA-256 `71f80e4539676a31940139dd50ad144776b2e43398f8d966f7042a834a5e1328` and preserves all 426 precursor entries unchanged while adding only the central activation identity.

Production deployment, exact source, activation, health, readiness, and migration ownership are verified. The controlled live-account, multi-platform, multi-browser/device zero-access exercise remains open and is not claimed complete.

## Remaining interface dependency

No signed-in SygShift browser tab or release-canary credentials were available for a final manual read of the Admin page. The exact deployed asset, signed-out boundary, rendered interaction tests, Worker authorization/provider tests, installed database contracts, and rollback-only production behaviors are verified. The subsequent centralization release moves mutation authority to Sygilant Security Center and retains SygShift only as an enforcement client of that shared authority; it does not create a second revocation implementation.
