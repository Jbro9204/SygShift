# SygSphere Mobile Usability Repair

**Released:** September 7, 2026  
**Status:** Deployed and verified in production

## What was reported

- On a phone, SygSphere displayed the conversation and message field, but the lower composer controls were pushed beneath the visible browser area.
- Employees could type a message but could not reliably reach or press **Send**.

## Root cause

- The earlier phone-width checks rendered SygSphere by itself. They did not reproduce the complete mobile SygShift shell with the four-clock operational header and an active workspace alert.
- Inside that full shell, the message list retained a 150-pixel minimum height. When the browser viewport became shorter, the list could not yield enough space to the composer and its action row extended below the bounded SygSphere workspace.
- The problem became more pronounced while the on-screen keyboard was open.

## Repair

- Kept the SygSphere layout bounded to the remaining mobile viewport and made the message history the independently scrollable region.
- Removed the mobile-only minimum-height constraint that forced the composer off-screen.
- Reduced excess mobile-only spacing while retaining the established rounded cards, colors, and typography.
- Kept the message field at a mobile-safe 16-pixel font size and provided comfortable 40- to 42-pixel attachment, mention, emoji, and Send controls.
- Added bottom safe-area support for mobile browsers and devices with inset navigation areas.
- While an employee is actively composing on a short phone viewport, the large clock grid and rotating workspace alert temporarily collapse so the keyboard, message field, and Send button remain usable. They return immediately when the composer loses focus. All four clocks, the Mountain system-time designation, and the alert data remain unchanged.
- Preserved both supported send methods: the visible **Send** button and Enter, with Shift+Enter continuing to create a new line.

## Regression protection

- Added a full-shell mobile fixture using the real operational time header plus an active alert strip.
- The new regression failed before the repair with the composer ending at pixel 772 while its SygSphere container ended at pixel 720.
- Added coverage proving that the composer and Send button remain inside the visible viewport, the button sends successfully by touch/click, and the page does not gain document-level overflow.
- Added a keyboard-sized 412-by-480 viewport check proving the temporary header/alert compaction does not move the Send button during a tap and that the normal header and alert return after focus leaves the composer.

## Preservation

- No database migration or production-data change was required.
- No authentication, permissions, SygSphere persistence, Realtime delivery, drafts, attachments, ticket notifications, scheduling, payroll, employee accounts, or time records were changed.
- The four operational clocks and workspace alerts remain visible during ordinary mobile navigation and return after message composition.
- The actual-component Time Clock suite passed for Home and Time Workspace clock-in, early-clock acknowledgment, break, resume, clock-out, permissions, ambiguous-shift selection, dashboard failure, and duplicate-submit prevention.

## Verification

- `pnpm check` passed TypeScript, zero-warning lint, 187 test files / 925 tests, and the production build.
- The focused SygSphere and actual-component Time Clock matrix passed 60/60 desktop and mobile checks.
- The complete browser regression suite passed 218/218 desktop and mobile checks, covering SygSphere, Timekeeping, tickets, notifications, HR, schedules, permissions, and global header behavior.
- A fresh production build was created after the final browser run through `pnpm deploy`.
- Production serves `/assets/index-KX_zoebd.css` and `/assets/SygSpherePage-Dlg35Qei.js` with HTTP 200. The live CSS contains the mobile composer focus rule and the live route asset contains the Send workflow.
- Production health returned `status: ok`; readiness returned `status: ready` and `ready: true`.
- The scheduled Timekeeping runs immediately following deployment completed normally with no errors.

## Release

- Application commit: `c07d1f8`
- Push to `origin/main`: completed before deployment
- Cloudflare Worker version: `4c96555f-cc91-414b-ac9c-afea845a780d`
- Database migration: none

