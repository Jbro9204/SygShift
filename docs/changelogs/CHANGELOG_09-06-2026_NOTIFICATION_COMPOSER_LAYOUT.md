# Notification Composer Layout Repair

Date: 09/06/2026

## Problem and cause

The Send Notification form used native square controls and a monospace message editor. Its broad full-width input rule also matched delivery checkboxes, separating them from their labels. Generic panel padding overrode the intended composer frame.

Read-only production measurements confirmed 26–27-pixel single-line fields with zero corner radius, a monospace textarea, and delivery checkbox layout widths above 360 pixels.

## Changes

- Applied the established application form treatment within the notification composer: padded, rounded controls, normal-weight application typography, readable message line spacing, and visible keyboard focus.
- Fixed checkbox dimensions at 18 pixels and grouped each with its heading and explanation. Selected recipient and delivery cards receive an explicit highlighted state.
- Aligned the form sections and compact action footer with consistent desktop/mobile gutters.
- Reserved search-icon space and prevented long employee titles from overlapping adjacent rows in the bounded recipient list.
- Preserved the existing fields, recipients, role selection, review-before-send, email and acknowledgment options, mutation behavior, and permission boundaries. No new destination selector or recipient-summary workflow was introduced.
- Runtime changes are CSS-only. Database, Worker handlers, live notification/sound logic, clocks, Home, timekeeping, payroll, and ticket workflows are unchanged.

## Files and tests

- `src/App.css`: scoped composer layout and form controls.
- `src/notificationCenter.test.ts`: source guard against full-width checkboxes and missing form treatment.
- `tests/fixtures/notification-*` and `tests/e2e/notification-composer.spec.ts`: real NotificationsPage rendered with isolated local transport. No production messages are sent.
- `playwright.config.ts`: isolated notification fixture server.
- `tests/e2e/live-notifications.spec.ts`: corrected a pre-existing headless two-tab race in the assertion. Both pages can report visible, so either may win the shared presentation lock. The test now unlocks audio on both and requires exactly one popup and sound in total, retaining duplicate suppression checks. No sound runtime code changed.
- New checks cover 1440/1024/390/320-pixel layouts, light/dark modes, control height/radius/typography, icon spacing, checkbox alignment, long names/titles, overflow, keyboard focus, accessibility, recipient search/selection, outgoing payload preservation, review/edit, pending/failure retention, company-wide restrictions, and denied access.
- Visual inspection caught and corrected search-icon overlap and long-title row compression before release.

## Validation and release

- Initial `pnpm check`: 180 files / 875 tests passed, TypeScript passed, zero-warning lint passed, production builds passed.
- Initial new browser suite: 10 desktop/mobile checks passed; strengthened icon and row-containment assertions were added after screenshot review.
- First full browser run: 191 passed / 1 failed on the pre-existing two-tab assertion described above; all 38 clock workflow checks passed.
- The next run overlapped the full build gate and produced three static-fixture failures involving a late application error view. The final browser pass ran alone with the build and application files frozen; no unrelated production workflow was changed to accommodate a fixture race.
- Final `pnpm check`: 180 files / 875 tests passed, TypeScript passed, zero-warning lint passed, production builds passed.
- Final complete Playwright run: **192 passed**, including all 10 new composer checks and all 38 actual time-clock workflow checks. Desktop and phone screenshots were visually reviewed.
- Production deployment and live verification: pending below.
- Database migrations: none. No production business records, permissions, secrets, or infrastructure settings changed.
- Live verification uses a separate tab to preserve the user's open form and selected recipient. No notification is submitted during production QA.

## Employee instruction

Finish or retain any current draft before refreshing SygShift to load the corrected form.
