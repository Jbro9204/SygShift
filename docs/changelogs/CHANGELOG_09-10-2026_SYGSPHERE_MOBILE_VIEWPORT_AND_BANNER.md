# SygSphere Mobile Viewport and Banner Repair

Date: 09/10/2026

## Outcome

SygSphere is now usable from the first mobile screen instead of being pushed below an oversized global header and alert banner. The messaging workspace, conversation controls, composer, and Send control remain visible and operable on phone-sized screens while all four required U.S. time-zone clocks remain available.

## Root cause corrected

- The ordinary mobile global header rendered all four clocks in a tall two-by-two grid above SygSphere.
- The missing-clock-in workspace alert then rendered as a large multi-row card, consuming most of the remaining phone viewport.
- Earlier keyboard protection only hid the surrounding chrome after the composer received focus; it did not make the initial SygSphere screen usable.
- The fixed mobile navigation control could overlap the first clock when the horizontal clock strip snapped back to its leading edge.

## Application changes

- Added a route-scoped `app-shell--sygsphere` state so the compact treatment applies only to SygSphere on small screens.
- Retained Pacific, Mountain system time, Central, and Eastern in their approved order and placed them in one readable horizontal swipe strip.
- Added leading scroll clearance and scroll padding so the mobile navigation control cannot cover the first clock.
- Condensed the global date/account controls without changing their actions or the desktop header.
- Reworked the workspace alert into a compact one-row strip with its icon, alert text, position, and Review action intact.
- Kept the SygSphere identity, text-size, sound, and New message controls on one usable mobile row.
- Kept the composer and Send control contained and visible, including at keyboard-height viewports.
- Changed the default SygSphere text-size label from `Comfortable` to the clearer `Normal`; the underlying employee text-size choices are unchanged.

## Preservation boundary

- No database migration was added or applied.
- No employee, account, message, conversation, notification, schedule, shift, punch, timecard, permission, role, MFA, or shared-identity record changed.
- No authentication, authorization, Realtime, messaging delivery, notification sound, attachment, mention, or timekeeping behavior was removed or broadened.
- Ordinary routes retain the existing mobile clock layout; desktop SygSphere and the global desktop header retain their existing layout.

## Verification

- `pnpm check`: passed TypeScript, zero-warning application lint, 229 test files, 1,178 tests, Worker build, and client production build.
- Combined SygSphere, global-header, and mandatory Time Clock browser matrix: 98/98 desktop/mobile checks passed.
- The full-shell SygSphere mobile regression proves all four clocks are present and swipe-reachable, the first clock clears the navigation control, the alert is compact, SygSphere begins within the first 200 pixels below browser chrome, the page has no document overflow, and an actual message can be sent.
- Required fresh production build after browser testing: passed.
- Wrangler dry run: passed with all existing bindings retained through `--keep-vars`.
- Post-deployment mandatory Time Clock workflow: 42/42 desktop/mobile checks passed.
- Primary root, `/sygsphere`, and fallback Worker root returned HTTP 200.
- Production health returned `ok`; readiness returned `ready` with every required check true.
- Live CSS asset `assets/index-DRvRmrlc.css` contains the route-scoped SygSphere mobile marker and the navigation-clearance rule.

## Release

- Application source: `2adbe72` (`fix: restore usable mobile SygSphere viewport`).
- Cloudflare Worker version: `1957c6e2-abed-440b-9024-4f33b00a4146`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-sygsphere-mobile-viewport-20260910` at `3a26ec7`.
- The release is application-only. If containment is required, restore the tagged application source and redeploy with the existing bindings preserved.
