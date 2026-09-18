# SygShift Changelog - 09/18/2026

## Shared Role Handoff Repair

### Problem and impact

Sygilant uses hyphens in its workspace role IDs while SygShift uses underscores in the canonical identity
role IDs. The return handoff consumer rejected the hyphenated claim as invalid. Admin and Guard canaries
passed because those role IDs are single words, leaving the defect exposed for multiword roles such as
Recruiting & Licensing, Human Resources, Human Resources Manager, and Operations Manager.

### Resolution

- Canonicalized trusted authority role separators before validating and comparing the claim with the local
  SygShift employee role.
- Kept exact local employee, application, destination, assurance, expiry, active-account, and MFA checks.
- Added privacy-safe field-category diagnostics without logging role values, identities, assertions, tokens,
  tickets, credentials, or request bodies.
- Replaced raw browser JSON on completion failures with a safe recovery screen that directs the employee to
  start a fresh handoff from Sygilant.
- Added a multiword-role regression matrix and recovery-page coverage.

### Verification

- Focused shared-identity suites passed: **2 files / 20 tests**.
- Complete release gate passed: strict TypeScript, zero-warning lint, **267 test files / 1,357 tests**, Worker
  build, and client production build.
- Full Playwright matrix passed: **346 passed / 12 intentionally skipped / 0 failed** across desktop and
  mobile Chromium.
- `git diff --check` passed.
- No database migration or production-data mutation is required.

### Security preservation

- This repair canonicalizes a signed authority role; it does not grant a role, module, or permission.
- Guard remains the only permitted AAL1 handoff. Every MFA-required role remains subject to the existing
  high-assurance and local-role equality checks.
- Assertions and launch tickets remain signed, short-lived, single-use, destination-bound, and fail closed.
- Completion failures clear the launch cookie before showing recovery guidance.

### Release status

- Pre-change rollback tag: `rollback/pre-shared-role-handoff-repair-20260918`.
- Deploy Sygilant first so new assertions are canonical at their source, then deploy this SygShift consumer.
- Public health, readiness, and one fresh employee-present multiword-role handoff remain the production
  acceptance steps.
