# Notification Sound Replacement

Date: 09/06/2026

## Change

- Installed the exact supplied `gta-v-notification_5NNiLGc.mp3` as the new in-app notification sound, without editing or re-encoding it.
- New asset: `/sounds/SygShift_Notification_53571d7e.mp3` (62,445 bytes). Its content-versioned URL avoids reusing the previous sound from browser caches.
- SHA-256: `53571d7efae8ce122d8059b3522a237a1a59e2bff2ba6011bf49193c09c0a215`.
- Login audio and URL remain unchanged. Existing mute, volume, sound switches, autoplay handling, duplicate suppression, notification delivery, ticket status refresh, and timekeeping logic are untouched.
- Retained the old notification asset for already-open clients and rollback. The source download is unchanged.
- No database migration, configuration, permission, production-record, or email changes.

## Verification and release

- Added a sound-routing and exact-file hash regression for the notification and login assets.
- Added desktop/mobile checks using the native browser audio engine and actual MP3 responses, not a simulated decoder.
- `pnpm check` passed: TypeScript, zero-warning lint, 180 test files / 876 tests, and production builds. Existing container sourcemap and large-bundle build warnings are unchanged.
- All 52 desktop/mobile notification and actual-component time-clock browser checks passed, including native decoding/playback of both MP3s, live updates, duplicate suppression, preferences, early acknowledgment, Home clock controls, and cross-page clock synchronization.
- Release commit `c19eae9` pushed to `origin/main`.
- Deployment incident: the first deployment (`605baa41-fb8c-4b33-9515-2edac28f8840`) mistakenly reused the build left by Playwright, which intentionally clears browser connection settings. This could prevent newly loaded clients from opening the authenticated workspace. It was identified during release checking, reported immediately, and superseded by a fresh production build and deployment. No server handlers, database records, or stored credentials were changed.
- Corrected production Worker version: `c7c8c017-c4c1-470d-bfd9-99bb1fc152a3`, deployed with fresh `pnpm build` followed by `pnpm exec wrangler deploy --keep-vars`.
- Added an explicit release rule to `AGENTS.md`: never deploy Playwright's output; rebuild with production settings after browser tests, then verify the live entry bundle and signed-in workspace.
- Production health/readiness returned HTTP 200 and ready. Live HTML references the correct production bundle (`index-CrNv1cyk.js`); the bundle and new notification, unchanged login, and retained old notification MP3s matched the production build by SHA-256. MP3 responses use `audio/mpeg`.
- A separate signed-in production tab loaded Notifications normally. The existing Test notification sound control completed with “Test sound played.” No production notification, email, punch, preference change, or sign-in/sign-out was generated during QA; the user's existing tabs and drafts were left untouched.

## Employee instructions and limitation

Refresh after preserving any unsent work. To preview the new tone, open Notifications → Sounds & device notifications → Test notification sound.

This replacement affects the in-app sound. Background device alerts continue to use browser/operating-system sound behavior. Actual audibility still depends on device volume, browser permissions, and mute settings.
