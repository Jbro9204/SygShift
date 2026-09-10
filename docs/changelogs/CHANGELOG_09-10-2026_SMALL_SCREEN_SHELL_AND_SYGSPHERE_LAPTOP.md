# Small-Screen Shell and SygSphere Laptop Layout

Date: 09/10/2026

## Outcome

SygShift now uses the available screen width cleanly on 14-inch and other compact laptop displays. The permanent desktop rail becomes a full-size off-canvas navigation drawer at compact widths, leaving the workspace unobstructed, while SygSphere keeps its conversations, active message, composer, Send control, alerts, and all four required clocks visible and usable.

## Root cause corrected

- Responsive modules were evaluating the browser width even though the permanent 276-pixel navigation rail had already reduced the usable workspace. At a 1280-pixel browser width, dense pages could therefore receive only about 1004 pixels while still selecting a wide-screen layout.
- A saved desktop collapsed-navigation preference could carry into a smaller viewport and produce an undersized drawer instead of a complete navigation experience.
- SygSphere's full workspace alert consumed unnecessary vertical space on compact laptops even after the phone-specific header work was complete.

## Application changes

- Added a compact-shell breakpoint for widths up to 1280 pixels, plus common 1281–1366 pixel laptop displays when their height is 800 pixels or less.
- Changed the fixed desktop rail into a full-width off-canvas drawer at those sizes, with a visible navigation button, close control, backdrop, body scroll lock, and reduced-motion support.
- Gave the workspace the full viewport width while the compact drawer is closed, eliminating the hidden 276-pixel content penalty.
- Preserved the employee's saved desktop collapse preference without applying it to the compact drawer; the preference returns automatically when the viewport widens.
- Kept every navigation group, Sygilant launcher, SygTasks launcher, SygSphere launcher, Need Help action, and online status available inside the drawer.
- Added safe top-bar clearance for the navigation button.
- Condensed the SygSphere operational alert on compact laptops so its conversation list, active conversation, composer, and Send control remain prominent.
- Retained Pacific, Mountain system time, Central, and Eastern clocks in the approved order.

## Preservation boundary

- No database migration was added or applied.
- No employee, account, role, permission, schedule, shift, punch, timecard, message, conversation, ticket, notification, MFA, or shared-identity record changed.
- No authentication, authorization, Realtime, messaging delivery, notification sound, attachment, timekeeping, payroll, scheduling, HR, ticket, or task behavior changed.
- Larger desktop layouts retain their existing permanent rail and saved collapse behavior.
- Phone-specific SygSphere behavior remains intact.

## Verification

- `pnpm check`: passed TypeScript, zero-warning application lint, 229 test files, 1,179 tests, Worker build, and client production build.
- Focused AppShell lifecycle coverage passed 6/6 checks, including media-query updates, listener cleanup, drawer behavior, and saved-preference preservation.
- Focused launcher and SygSphere responsive matrix passed 58/58 desktop/mobile checks.
- Broad small-screen layout regression suite passed 120 checks with 10 expected project-specific skips across Attendance, Client Files, Document Studio, HR, Identity Verification, Licensing, Patrol, Reports, Supervision, Tickets, SygTasks, Time Maintenance, User Administration, the global header, and platform launchers.
- Visual verification passed at 1366x768, 1280x720, and 1024x768/720. The workspace remains contained, the drawer opens at a usable width, launchers remain reachable, all four clocks remain visible, and SygSphere can send a real message without document overflow.
- Required pre-release production build and Wrangler dry run passed with existing bindings preserved through `--keep-vars`.
- Post-deployment mandatory Time Clock workflow passed 42/42 desktop/mobile checks, covering early clock-in acknowledgment, ordinary punches, breaks, resumed work, ambiguous shifts, active controls, permission boundaries, failure recovery, and duplicate-submit protection.
- Primary root, `/sygsphere`, and fallback Worker root returned HTTP 200.
- Production health returned `ok`; readiness returned `ready` with every required check true.
- The initial release served `assets/index-xezfMBWS.js` and `assets/index-KyggoZYh.css`. The immediately following coordinated SygSphere upload-repair deployment serves `assets/index-BFV1APP2.js` with the same `assets/index-KyggoZYh.css`; live CSS still contains the compact-shell drawer and SygSphere compact-alert rules.

## Release

- Application source: `99f7397` (`fix: adapt SygShift shell for smaller screens`).
- Initial Cloudflare Worker version: `a0b20e77-3855-4a17-a8a5-62ca5f92f7e4`.
- Current coordinated Cloudflare Worker version: `1b607a3b-f6af-4636-8409-127e0ea9c603`; it retains this responsive release and adds the separately verified SygSphere upload-completion repair.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-small-screen-shell-20260910` at `eb8d9ce`.
- The release is application-only. If containment is required, restore the tagged application source and redeploy with existing bindings preserved.
