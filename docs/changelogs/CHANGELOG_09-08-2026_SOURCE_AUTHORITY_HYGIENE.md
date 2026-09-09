# Source Authority Hygiene

Date: 09/08/2026

## Outcome

Removed inherited development-tool and provider-specific references from the SygShift repository before
the password-recovery release is reconciled. Product source, documentation, and operational scripts now
describe the engineering workflow and runtime dependencies directly.

## Changes

- Reworded the historical handoff guide around an engineering task and development interface.
- Replaced a machine-specific bundled-runtime Python path with the portable `python` command while
  preserving the existing explicit `-Python` override.
- Renamed an unused example vector-bucket comment to a provider-neutral description.
- Made no authentication, authorization, MFA, FIDO2, database, email, schedule, payroll, or production
  behavior change.

## Verification

- Repository trace scan excludes dependency/build output and returns no development-tool authorship or
  provider references in owned source.
- PowerShell parsed the HR packaging script with zero syntax errors.
- The complete SygShift release gate passed after this change was rebased onto the coordinated SygShift
  release: 208 test files / 1,033 tests, TypeScript, zero-warning lint, both production builds, all 38
  protected desktop/mobile Time Clock checks, and a fresh production build after browser testing.

## Rollback

- Pre-recovery baseline: `rollback/password-recovery-email-prechange-20260908`.
- Recovery bridge checkpoint: `rollback/password-recovery-bridge-20260908`.
- Final coordinated source checkpoint: `rollback/password-recovery-source-hygiene-final-20260908`.
- This source-only cleanup can be reverted independently before release without touching production data.
