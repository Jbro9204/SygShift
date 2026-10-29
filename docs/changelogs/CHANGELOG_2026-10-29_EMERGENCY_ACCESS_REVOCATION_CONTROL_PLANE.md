# SygShift emergency access revocation control plane

Date: October 29, 2026
Application: SygShift, with connected Sygilant session invalidation
Status: implementation and release verification in progress

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

## Release-candidate implementation inventory

- Database authority: `supabase/migrations/20261029225323_emergency_access_revocation_control_plane.sql`
- Rollback-only database regression: `supabase/tests/emergency_access_revocation_control_plane_regression.sql`
- Worker orchestration and protected endpoints: `worker/index.ts`
- Browser data contract: `src/data/adminUsers.ts`
- User Accounts workflow: `src/pages/UserAdminPage.tsx`
- Responsive presentation: `src/App.css`
- Focused contract, rendered interaction, and Worker coverage: `src/adminEmergencyAccessGuard.test.ts`, `src/pages/UserAdminEmergencyAccess.test.tsx`, and `src/worker.test.ts`
- Fingerprint-gated activation tooling: `tools/prepare-emergency-access-revocation-release.mjs` and `tools/prepare-emergency-access-revocation-release.test.mjs`
- Security architecture: `docs/SECURITY.md`

The release candidate retires authenticated execution of the former direct account-state RPC. A stale browser cannot use that shortcut to clear or create an emergency marker. Connected Sygilant sessions are included in the shared-identity cleanup boundary; a separate Sygilant administrative interface must call this SygShift authority rather than recreate the workflow.

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
- generated rollback-only artifact SHA-256 `f3056421f8a4284cea679dbe94ffa964ba7a2591bc5e1ee5a1b50daa90f06964` and atomic release artifact SHA-256 `41a510b37c0bd9a90024329a1b0db6c9cd9cb50dfbc7bf094afe113fd9d4b1e8`.

Pending completion of:

- exact migration-ledger activation and post-migration verification;
- exact-source push and green GitHub quality/CodeQL results;
- exact-source Cloudflare release, health/readiness, and live non-mutating Admin workflow verification.

Production evidence will be recorded here only after each corresponding check succeeds.
