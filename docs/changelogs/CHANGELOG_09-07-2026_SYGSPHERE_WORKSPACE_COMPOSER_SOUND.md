# SygSphere Workspace, Composer, and Sound Refinement

Date: 09/07/2026
Status: Deployed and verified in production

## Requested improvements

- Remove the large unused area beneath the SygSphere messaging workspace.
- Allow Enter to send a message while Shift+Enter creates a new line.
- Use the supplied `franklin-notification-gta-v.mp3` only for SygSphere message alerts.

## Root causes and changes

- SygSphere used a fixed `100dvh - 220px` height while the application shell reserved approximately 76 pixels for its ordinary header. That mismatch left roughly 144 pixels of unused page height. The SygSphere route now makes the shell a viewport-height flex column, lets maintenance and alert rows retain their natural height, and gives the messaging workspace the exact remaining height. Conversation, message, detail, and thread panes retain their own bounded scrolling.
- The composer recognized only Ctrl/Command+Enter. Both the normal conversation composer and thread-reply composer now send on unmodified Enter and preserve Shift+Enter as a newline. IME composition, empty-message prevention, pending-state duplicate prevention, draft retention, retry identity, and the Send button are unchanged.
- The supplied 37,987-byte MP3 was copied without re-encoding to `/sounds/SygSphere_Notification_46421aca.mp3`. Its SHA-256 digest is `46421aca65b0da122e826b43664ddd79cd40513149007da365b627069a99c059`. Only `SygSphereLauncher` references this asset; the established SygShift login and system/ticket notification sounds remain unchanged.

## Files changed

- `src/styles/sygsphere.css`
- `src/pages/SygSpherePage.tsx`
- `src/components/SygSphereLauncher.tsx`
- `public/sounds/SygSphere_Notification_46421aca.mp3`
- `tests/e2e/sygsphere.spec.ts`
- `tests/fixtures/sphere-ui.tsx`
- `docs/operations/SYGSPHERE_USER_GUIDE.md`
- `DEVLOG.md`

## Preservation

- No database migration or production data change is required.
- No authentication, permissions, messaging persistence, Realtime delivery, ticket/system notification, email, clock, scheduling, payroll, or employee-account behavior was changed.
- The new sound stays inside the existing SygSphere preference, global mute/volume, foreground suppression, muted-conversation, and cross-tab duplicate-suppression rules.

## Verification

- Targeted SygSphere and actual-component clock browser matrix passed 56/56 checks on desktop and mobile. This included native decoding and exact hashing of the new MP3, Enter/Shift+Enter in conversations and threads, full-height shell geometry, live two-account fixture delivery, drafts/retry, search/saved/thread workflows, light/dark containment, and all 38 clock-workflow cases.
- Final `pnpm check` passed with TypeScript, zero-warning application lint, 186 test files / 923 tests, and production builds after the final asset and documentation changes.
- The full desktop/mobile Playwright suite passed 214/214 checks, including all existing header, HR, ticket, notification, Patrol, permission, responsive-layout, Home clock-control, and Early Clock-In regressions.
- The release-time production build completed successfully and produced `/assets/index-Da6OLiw7.js`, `/assets/index-Bfxbnt4v.css`, and `/assets/SygSpherePage-BPrMashv.js`.
- Production health returned `status: ok`; readiness returned `status: ready` with the asset binding, Supabase URL, publishable key, and service-role key checks all true.
- The live SygSphere MP3 returned HTTP 200 as `audio/mpeg`, was 37,987 bytes, and matched the source SHA-256 digest exactly.
- A signed-in production check at 2560 by 1271 confirmed document and body height of 1271 pixels, with both `#main-content` and `.sphere-workspace` ending at pixel 1271. The composer displayed the new Enter/Shift+Enter guidance, and no production message was sent during verification.
- The signed-in shell retained the four operational clocks in Pacific, Mountain system time, Central, and Eastern order. A read-only Home check also confirmed the current-time card and the employee Clock in control remained available.

## Database and deployment

- Database migration: none.
- Application commit: `ae6b305bddca25e72e9d00e40714e69037679e6c`.
- Push to `origin/main`: completed before deployment.
- Cloudflare Worker version: `e13c4d51-c1ac-464b-8d60-bae1e719f555` (100% active).
- Deployment created: `2026-09-07T13:39:20.102Z`.
- Health and readiness: passed at `https://app.sygilant.us/api/v1/health` and `https://app.sygilant.us/api/v1/ready`.
- Signed-in production verification: passed at `https://app.sygilant.us/sygsphere` and the Home workspace.

## Remaining boundaries

- Browser audio still depends on browser media policy and the existing user-interaction unlock behavior.
- SygSphere alerts continue to require SygShift to be open; closed-browser SygSphere Web Push remains outside this refinement.
- The pre-existing Home Announcements loading failure remains visible and was not introduced or modified by this SygSphere release.
