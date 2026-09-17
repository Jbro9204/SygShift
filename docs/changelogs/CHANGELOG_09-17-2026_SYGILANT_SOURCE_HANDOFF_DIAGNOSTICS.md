# Sygilant Source Handoff Diagnostics — September 17, 2026

## Outcome

The reported fresh SygShift-to-Sygilant launch was successfully issued, cryptographically verified, and atomically consumed once by SygShift. The immediate browser refresh was correctly rejected as replay. Production correlation shows the failed fresh request reached the Sygilant consumer after successful SygShift introspection but failed before Sygilant created its local shared-identity session.

SygShift's source contract remains unchanged and secure. This release adds privacy-safe correlation logs and a direct fresh-success-plus-replay regression so future cross-platform incidents can be separated cleanly at the provider/consumer boundary without logging an assertion, secret, employee identifier, authentication identifier, or username.

## Production incident evidence

- Provider request `87633301-3386-4ea2-b45d-bba6dc242dcc` was issued at `2026-09-17 21:13:45.050 UTC` and consumed at `2026-09-17 21:13:45.232 UTC`.
- The issue and consume audit records identify the expected launch and introspection routes.
- The assertion was valid for 60 seconds, used the exact approved issuer, audience, application, destination, role, and assurance contract, and was consumed in approximately 182 milliseconds.
- The canonical employee/account record still matched every signed identity field and remained active and enabled.
- Migration `20260912010000_universal_sygilant_launch_access` was already applied before the incident.
- Sygilant had no local shared-identity session row for the provider request, which places the fresh failure after SygShift introspection and before Sygilant local claim/session creation.

## SygShift changes

- Added a structured `sygilant_shared_identity_assertion_issued` event after the database ledger accepts an assertion.
- Added a structured `sygilant_shared_identity_assertion_consumed` event only after the returned canonical identity matches every verified assertion field.
- Added a structured `sygilant_shared_identity_consume_rejected` event that carries only opaque provider/request correlation IDs and the safe error class/status.
- Added a regression that issues one assertion, consumes it successfully once, replays the exact assertion, and proves the replay remains denied.
- Added log-content assertions proving no assertion, authentication user ID, employee ID, or username enters the new logs.

## Security and preservation

- Replay protection, HMAC signing, 60-second expiry, exact issuer/audience/destination checks, consumer authorization, canonical account revalidation, and atomic one-time consumption are unchanged.
- No Sygilant consumer file was changed by this release.
- No database migration or production-data mutation was required.
- No employee, account, role, permission, MFA factor, authentication session, schedule, punch, payroll record, document, or audit history was changed.
- Rollback tag `rollback/pre-sygilant-source-handoff-observability-20260917` points to source `a85db70` and was pushed before the source change.

## Verification

- Focused shared-identity and launcher suite: **4 files / 53 tests passed**.
- Complete release gate: **267 files / 1,348 tests passed**, plus TypeScript, zero-warning application lint, Worker build, and client production build.
- Required actual-component Time Clock preservation matrix: **42/42 passed** across desktop and mobile.
- `git diff --check`: passed.

## Release status

- Source commit: pending
- Push to `origin/main`: pending
- Cloudflare Worker: pending
- Health/readiness: pending
- No database migration was required.

## Remaining cross-platform acceptance

The SygShift provider is verified through one-time consumption. Final end-to-end acceptance requires Sygilant to complete its local claim/session transaction and then a fresh authenticated employee launch. Refreshing an already consumed launch must continue to fail.

## Files

- `worker/sygilantSharedIdentity.ts`
- `src/sygilantSharedIdentity.test.ts`
- `DEVLOG.md`
- `docs/changelogs/CHANGELOG_09-17-2026_SYGILANT_SOURCE_HANDOFF_DIAGNOSTICS.md`
