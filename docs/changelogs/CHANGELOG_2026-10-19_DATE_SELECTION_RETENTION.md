# My Time and Schedule Date Selection Retention

Date: October 19, 2026
Status: Released and verified in production

## Outcome

SygShift now preserves an employee's selected historical dates while moving between My Time, Schedule, and other application routes or while returning from a background browser tab. My Time, Schedule, and Scheduler retain independent selections. A current-period control still returns each view to its authorized current range.

## Root cause

- My Time stored only a component-local period offset, so a route remount recreated the current period.
- Schedule and Scheduler stored component-local week state, and the employee schedule date hook could re-anchor the view when its trusted date basis refreshed.
- No employee-scoped session state connected a validated URL selection with a safe in-session fallback.

## Repair

- Persisted exact selected dates in the URL and in employee-scoped `sessionStorage`.
- Kept My Time, Schedule, and Scheduler storage keys independent.
- Delayed affected data requests until the authenticated employee's saved selection is resolved, so displayed dates and requested dates agree.
- Preserved selections through route remounts, browser focus/visibility changes, and background refreshes.
- Cleared the previous employee's saved selections during sign-out and account changes.
- Rejected malformed saved dates and safely defaulted to the current authorized period or employee-local week only when no valid selection exists.

## Scope preserved

- No payroll allocation, overtime, punch, schedule-record, permission, or timezone rule changed.
- Saved state is intentionally limited to the current browser tab/session. When browser session storage is unavailable and no valid URL selection exists, the view safely uses its current period.

## Verification

- Focused date-selection regression: **5 files / 36 tests passed**.
- App-shell lifecycle and related regression coverage passed, including navigation, focus, visibility, sign-out, and account-change behavior.
- Full `pnpm check`: **377 files passed / 1 skipped; 2,172 tests passed / 1 skipped**, plus strict TypeScript, zero-warning lint, production build, and static-asset contract.
- Mandatory desktop/mobile Time Clock workflow: **42/42 passed**.
- Source whitespace validation passed.

## Release and fallback

- Pre-change rollback tag: `rollback/pre-date-selection-retention-20261019`
- Pre-change commit: `7186e23cf2295d76b38303bd4ebd6bddca00c6d3`
- Date-selection implementation commit: `7350f1e`
- Released source checkpoint: `3dc800770e64777dc0217c906cddb9355d2a0358`
- The SygSphere acknowledgment update begins only after a separate post-date-selection fallback tag is created.
- Post-date-selection fallback tag: `rollback/pre-sygsphere-message-acknowledgment-20261019`
- Cloudflare Worker version: `6222fdac-24b7-43f7-80bf-bbd14b47ba78`
- Both production origins returned `200` for root, health, and readiness; the custom origin also returned `200` for `/login`.
- The signed-in SygSphere workspace opened successfully after refreshing to the released build.
- Production `index.html` and all ten referenced entry assets matched the final local production build byte-for-byte.
- Production `index.html` SHA-256: `9785b0e43d96f5e972c463aa8aa15b414a43506d388eead2a02c22282e1a0216`

The following SygSphere acknowledgment release is isolated behind its own database gate and fallback tags; it is not part of this date-selection deployment.
