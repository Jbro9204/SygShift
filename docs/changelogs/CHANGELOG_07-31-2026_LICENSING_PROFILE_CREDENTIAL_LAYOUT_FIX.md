# SygShift Changelog - 07/31/2026 - Licensing Profile Credential Layout Fix

## Summary

Fixed the employee Licensing Profile credential workspace so long credential/license names do not collapse into unreadable vertical text.

## What Changed

- Widened the employee Licensing Profile modal for better credential management space.
- Adjusted the credential workspace columns so the picker and detail panel have a cleaner split.
- Changed credential picker rows into stacked record cards:
  - credential/license name displays first
  - status pill displays below without crushing the text
  - long names no longer wrap letter-by-letter
- Added CSS guardrails to prevent the credential picker layout from regressing.

## QA

- `git diff --check` passed.
- `pnpm lint` passed.
- Targeted guardrails passed: `src/buttonLayoutGuard.test.ts` and `src/permissionSurfaceGuard.test.ts`.
- Full test suite passed: 32 test files / 148 tests.
- `pnpm build` passed.
