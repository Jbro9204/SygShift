# SygTasks Dark Mode Readability Repair

Date: 09/09/2026

## Outcome

SygTasks now uses the established SygShift light/dark theme contract across the workspace, toolbar, empty states, task cards, status and priority chips, notices, forms, and dialogs. Dark mode no longer renders near-black text and borders over dark panels, and light mode retains accessible semantic colors.

The search and filter helper labels remain available to assistive technology without appearing as stray visible text in the toolbar.

## Root Cause

The SygTasks stylesheet referenced the undefined foreground variables `--text` and `--muted-text`. Those references fell back to light-mode near-black colors while the valid `--surface` token correctly switched panels to dark, creating the dark-on-dark presentation shown in the reported screenshot. The border token also inherited that incorrect foreground.

The page additionally used an undefined `sr-only` utility instead of SygShift's established `visually-hidden` utility, which exposed the accessibility-only search and filter labels.

## Implementation

- Connected SygTasks foregrounds, muted copy, borders, surfaces, and controls to the canonical `--ink`, `--muted`, `--line`, and `--surface` theme tokens.
- Added paired light/dark semantic foregrounds for gold accents, danger, success, information, review, and warning states.
- Applied the local theme contract to the workspace, create/detail dialogs, loading state, and unavailable state.
- Preserved intentional dark foregrounds on gold action buttons, icon tiles, and avatars.
- Protected urgent task cards and success/error notices from broad legacy dark-theme compatibility selectors.
- Replaced all four SygTasks `sr-only` helper spans with the established `visually-hidden` utility.
- Added dedicated source guards and rendered browser coverage for empty/populated states and the creation dialog.

## Scope Boundary

This is a presentation and accessibility repair only. It does not change SygTasks data, assignment, status, notification, Realtime, role, or permission behavior. It does not change scheduling, payroll, HR, SygSphere, authentication, MFA, or Time Clock behavior. No database migration or production data mutation is included.

## Verification

- `pnpm check`: passed TypeScript, zero-warning lint, production build, 210 test files, and 1,053 tests.
- Dedicated SygTasks rendered matrix: 8/8 passed across light/dark themes and desktop/phone widths.
- The rendered matrix verifies WCAG AA accessibility, explicit 4.5:1 foreground contrast, empty and populated states, every representative status/priority chip, hidden helper-label geometry, dialog bounds, action reachability, and horizontal containment.
- Existing dark-theme, header, and Time Clock regression subset: 60/60 passed.
- Full Playwright desktop/mobile matrix: 250/250 passed on a fresh complete run.
- The one unrelated notification fixture that missed its first load during the initial full run passed three consecutive isolated repetitions and passed normally in the fresh 250-check run.
- Mandatory Time Clock workflow: 38/38 passed within the full matrix, including Early Clock-In acknowledgment, clock-in, break, resume, clock-out, active-control restoration, ambiguous-shift selection, permission denial, and synchronization.

## Release and Rollback

- Pre-change rollback tag: `rollback/sygtasks-dark-mode-pre-fix-20260909` at `0b4278eed502cd5ac9e66a8cacc8f460e2acba66`.
- The exact source commit, Cloudflare Worker version, asset identity, and live health/readiness evidence will be appended immediately after production deployment.

