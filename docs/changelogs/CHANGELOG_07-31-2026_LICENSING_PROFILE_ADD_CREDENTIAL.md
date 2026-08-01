# SygShift Changelog - 07/31/2026 - Licensing Profile Add Credential Flow

## Summary

Made the Licensing Center employee profile easier to use by putting the Add Credential / License workflow directly inside each employee's Licensing Profile.

## What Changed

- Added a clear primary **Add credential / license** action at the top of the employee Licensing Profile.
- Added a dedicated **Add or update** panel inside the profile with:
  - credential/license type selector
  - visible **Open add/update form** button
  - plain-language instructions for adding numbers, dates, notes, and documents
- Included active credential/license types that do not already have a record for the employee, so new optional credentials are visible and selectable.
- Changed missing/new credentials to show as **Add new** instead of being hidden in the existing-record workflow.
- Updated the selected credential actions so a missing/new credential clearly says **Add this credential/license**.
- Kept the profile layout wide, spaced, and professional so the Licensing Coordinator does not have to hunt through a cramped page.
- Added a regression guardrail test so this Add Credential / License workflow cannot quietly disappear during future UI changes.

## QA

- `git diff --check` passed.
- `pnpm lint` passed.
- Targeted guardrails passed: `src/buttonLayoutGuard.test.ts` and `src/permissionSurfaceGuard.test.ts`.
- Full test suite passed: 32 test files / 148 tests.
- `pnpm build` passed.
