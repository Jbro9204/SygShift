# Universal Sygilant Handoff

Date: 09/09/2026

## Outcome

The first SygShift-to-Sygilant merger now supports every approved canonical SygShift role through the existing secure Sygilant launcher. Guard employees may use the shared launch without MFA only while their current account remains a non-MFA Guard account. Every other role continues to require MFA. The reciprocal Sygilant-to-SygShift receiver now carries and revalidates the canonical role through the complete one-time handoff and restored-session lifecycle.

## Approved role policy

The locked `apps.sygilant.access` permission is enabled for exactly these active roles:

- Administrator
- Chief
- Dispatcher
- Guard
- Human Resources
- Human Resources Employee
- Operations Manager
- Recruiting & Licensing
- Scheduler
- Supervisor

Guard is the only role eligible for AAL1, and only when the authoritative effective-MFA policy is false. A Guard employee with an additive MFA-required role or direct protected grant must complete MFA. All nine other roles require a current high-assurance session.

## Security and lifecycle behavior

- Preserved the existing Sygilant launcher, exact origins, audience, application identifier, `/dashboard` destination, 60-second production assertion lifetime, one-time consumption, and employee/account/session binding.
- Added AAL1 only as a narrowly constrained Guard exception; high-assurance levels remain `aal2`, `security_key`, `trusted_device`, and `external_mfa`.
- Revalidates the current canonical role and effective MFA policy when an outgoing assertion is issued and when its ledger record is consumed. A role or MFA-policy change invalidates an unconsumed Guard assertion.
- The reciprocal SygShift receiver requires `roleId` in the signed assertion, one-time ticket, and encrypted session envelope.
- Revalidates the employee's current canonical role, username, authentication user, session, and assurance during introspection, finalization, and every restored shared session.
- Rejects non-Guard AAL1, role mismatch, inactive/disabled accounts, expired assertions and tickets, replay, invalid scope, and audience/origin/destination mismatch.
- Does not treat an AAL1 platform handoff as MFA for protected SygShift operations.
- Preserved existing SygSphere shared-session scoping, ordinary SygShift authentication, timekeeping, scheduler, HR, notifications, SygSphere, SygTasks, and protected-data controls.

## Database release

- `20260912010000_universal_sygilant_launch_access.sql` adds the exact role grants, Guard-only AAL1 constraints, authoritative issue/consume/session checks, audit events, and destructive-change fingerprints.
- `20260912010100_stabilize_shared_identity_session_time_checks.sql` uses statement-stable expiration checks so the release adds no database-lint volatility finding.
- Both migrations are present in linked production history.
- Production postflight reported 10 approved role grants, 0 effective-permission failures, 32 active Guard accounts eligible under the current AAL1 policy, 0 non-Guard AAL1 policy violations, 0 MFA-required Guard violations, 0 invalid outgoing AAL1 ledger rows, and 0 invalid incoming AAL1 sessions.
- The production database linter reports no finding for any function created or changed by this release. Existing unrelated database findings were not modified as part of this scoped merger.

## Regression protection

- Added outgoing contract tests covering all ten roles, the Guard exception, all nine MFA-required roles, additive-role escalation, assurance preservation, expiration, and denial behavior.
- Added reciprocal receiver tests for Guard AAL1 acceptance, non-Guard denial, authoritative role mismatch, newly MFA-required Guard denial, and end-to-end `roleId` propagation.
- Added static release guards for exact permission scope, database constraints, current-policy revalidation, and preservation of the established origins, audience, destination, single-use behavior, and storage boundaries.
- `pnpm check`: passed — TypeScript, zero-warning application lint, 228 test files, 1,171 tests, Worker build, and client production build.
- Focused shared-identity suite: 52 of 52 tests passed.
- Protected browser regression: 54 of 54 desktop/mobile checks passed, covering platform launchers, early-clock-in acknowledgment, real clock-in/break/clock-out, split-shift return, duplicate prevention, ambiguous shifts, active Home controls for Guard/Admin/Dispatcher/Supervisor, responsive layout, keyboard use, and accessibility.
- PostgreSQL parser validation accepted the release migrations and production preflight/postflight scripts.
- `git diff --check`: passed.

## Production release

- Application source commit: `514db85` (`feat: complete universal Sygilant handoff`).
- Cloudflare Worker version: `a7bf4030-94c7-4a27-82dc-47d9f61ba739`.
- Primary `https://app.sygilant.us` and fallback `https://sygshift.sygilant.workers.dev` health returned `ok`; readiness returned `true`; both roots returned HTTP 200.
- The unauthenticated Sygilant launch boundary rejected access with HTTP 403.
- Pre-release rollback tag: `rollback/pre-sygilant-universal-launch-20260909` at `cca5804`.
- Reciprocal Sygilant baseline supplied by the coordinated merger task: source commit `00d1195`, migration `20260912000100`, and rollback tag `rollback/canonical-handoff-stage-four-20260909`.

## Rollback boundary

The application can be restored to the pre-release tag. The database release is forward-only: production migration history must not be rewritten. If the shared launch must be disabled operationally, use the existing shared-identity feature flag while a forward corrective migration preserves audit and ledger history.
