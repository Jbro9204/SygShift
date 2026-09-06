# Live Notifications, Ticket Synchronization, and Sound

Date: 09/06/2026

## Changes

- Added private, recipient-specific live update channels. Ticket replies, status, assignment, priority, queue entries, notification counts, and personal inboxes refresh through the existing authorized read boundaries.
- Added a 30-second refresh fallback plus reconnect/focus catch-up. Live refresh preserves reply drafts, selected tickets, and page position.
- The original test ticket is Resolved in the authoritative database. The prior ticket page did not subscribe to changes or periodically refresh, allowing another person's open screen to remain stale.
- Added bounded, clickable notification popups and device-wide event deduplication. Initial history and reconnect catch-up are silent; notification bursts are coalesced.
- Added the exact supplied SygShift Login and Notification MP3s. Manual login sound waits for completed authentication and required security checks; failed login, refresh, navigation, and token renewal do not replay it. Browser autoplay failures never block access.
- Added separate login/notification sound switches, volume, mute, and test playback under Notifications → Sounds & device notifications. Settings are device-local.
- Added opt-in device Web Push, a Home Screen web-app manifest, private lock-screen messages, revoked-session checks, short-lived delivery, claim leases, bounded retries, and expired-subscription handling. A protected database wakeup starts delivery; the existing scheduled runner provides an independent fallback.
- Added a push-only service worker. It has no fetch handler or offline application cache and cannot intercept clock, payroll, authentication, or document requests. In-app and background presentation coordinate to avoid repeated alerts.
- Separated background ticket reads from explicit visible reads. Required acknowledgment remains a separate employee action. Internal notes retain their existing handler-only boundary.
- Preserved existing lifecycle email creation and delivery, timekeeping, schedule, payroll, HR, role, and MFA behavior. No existing business record is rewritten by this migration.

## Employee instructions

1. Refresh SygShift once after the release.
2. Open Notifications, then expand Sounds & device notifications.
3. Choose sound options and volume. Use the test buttons to check browser/device sound settings.
4. For updates while SygShift is closed, choose Enable device notifications and allow the browser prompt. Repeat on each device.
5. On iPhone/iPad, add SygShift to the Home Screen, open that installed app, then enable device notifications there.
6. Click a popup or device notification to open the related work. A required acknowledgment must still be selected explicitly.

## Browser limitations

- Live delivery is near-real-time, not a guarantee of zero latency. Offline or suspended devices catch up when available.
- Custom MP3 playback applies in the app. Background alerts use browser/OS sound behavior and can be muted; operating-system notification permissions and Do Not Disturb remain authoritative.
- Signing out stops background delivery for that authentication session. Account changes do not inherit another employee's push registration.
- Binary ticket attachments and unrelated feature requests are unchanged.

## Validation and release status

- Database migration: `20260906190358_realtime_notification_delivery.sql` (forward-only).
- New live-notification regressions, existing support lifecycle regressions, and PL/pgSQL function checks passed together inside one explicit BEGIN / ROLLBACK, with no COMMIT. No test ticket, notification, email, subscription, or punch was committed.
- Security advisor: no error-level findings before deployment.
- Targeted real-component browser checks passed for desktop/mobile live synchronization, reply draft preservation, confidential-note filtering, duplicate/old-alert suppression, sound preferences, accessibility, and all 38 clock workflow cases.
- One full-suite attempt was interrupted by a development-preview reload during an application file change; the application files were frozen before the final rerun.
- Final `pnpm check`: 180 test files / 874 tests passed, type checking passed, zero-warning lint passed, production builds passed.
- Final full Playwright run: all 182 desktop/mobile checks passed, including the original clock preservation gate.
- Migration `20260906190358` applied successfully through the exact-file procedure; only that migration-history version was marked applied. Post-migration security advisor reported no error-level issues.
- Private-channel runtime checks confirmed the recipient's own signals are readable, other recipient rows are hidden, and an attempted other-account topic is denied.
- The initial live-transport check identified an uninitialized managed Realtime partition window. A normal WebSocket subscription initialized it; the signal and authorization checks then passed. No managed Realtime schema object was edited. This is the documented [first-connection behavior](https://supabase.com/docs/guides/troubleshooting/realtime-warn-sending-broadcast-message).
- Release commit, Worker version, and live endpoint verification are recorded below after deployment.
- Signed-in production walkthrough and actual device/OS notification playback require an authenticated browser and an enrolled device. No real employees receive automated test messages.

## Operational configuration

- Worker secrets: `SYGSHIFT_PUSH_PUBLIC_KEY`, `SYGSHIFT_PUSH_PRIVATE_KEY`, `SYGSHIFT_PUSH_HOOK_SECRET`.
- The matching database wake credential is encrypted in Vault as `sygshift_push_hook`.
- `tools/prepare-push-secrets.mjs` generates credentials only into the ignored local secrets directory, reuses an existing local set, and refuses an implicit Vault credential rotation. Credential values must never enter Git or release notes.
- Existing migration-history discrepancies require the documented exact-version application/repair procedure; do not replay unrelated historical migrations.
