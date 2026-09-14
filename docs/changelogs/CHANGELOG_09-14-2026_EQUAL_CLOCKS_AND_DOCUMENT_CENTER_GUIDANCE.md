# Equal Clocks and Document Center Guidance — September 14, 2026

## Outcome

The four operational clocks are larger, evenly sized, and visually equal. Mountain time is no longer styled as the dominant clock; its small **System time** line is informational only. The Document Center start area is now a polished, evenly cushioned guide that clearly explains the simple three-step document workflow.

## Operational clocks

- Increased every desktop clock face to 44 pixels and increased the time and zone text together.
- Kept Pacific, Mountain, Central, and Eastern clocks identical in width, height, padding, background, border, and dial treatment.
- Removed the Mountain-only card, border, and dial emphasis while retaining a small plain **System time** label.
- Added an equal-height informational row to every clock so their content remains aligned.
- At common laptop widths, the complete four-clock strip moves to a dedicated second header row with 40-pixel faces. This prevents account controls from crowding or clipping the Eastern clock.
- Preserved the contained two-column mobile layout with equal 35-pixel clock faces.

## Document Center start guidance

- Replaced the flat **Simple Document Work / What do you need to do?** banner with a professional guide card.
- Added a clear document icon, the plain-language heading **What would you like to do?**, and concise guidance.
- Added three visual steps: **1 Choose**, **2 Complete**, and **3 Save or send**.
- Applied consistent typography, a 16-pixel corner radius, and equal left/right cushioning across desktop, laptop, and mobile layouts.
- Stacked the guide cleanly on narrow screens without changing any document action, permission, upload, filing, download, or sending behavior.

## Preservation and rollback

- No database migration or production-data mutation was required.
- Authentication, HR permissions, document storage, document delivery, Time Clock behavior, schedules, punches, payroll, and employee records were not changed.
- Rollback point: `rollback/pre-clock-document-intro-20260914`.

## Verification

- Focused component and guard tests passed: **4 files / 15 tests**.
- Focused clock and Document Center browser checks passed: **42/42**.
- The operational header browser suite passed again after the laptop breakpoint adjustment: **22/22**.
- Full repository gate passed: **256 test files / 1,308 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Full browser matrix passed: **328 passed / 12 intentional skips / 0 failures** across desktop and mobile.
- Post-release actual-component Time Clock matrix passed **42/42** desktop and mobile checks.
- Both production origins returned healthy and ready.
- The live application JavaScript, shared CSS, and Document Center bundle matched the release build byte-for-byte on both origins.
- A clean signed-out browser was redirected from `/hr/documents` to `/login`, and no protected Document Center content was exposed.

## Release references

- Source commit: `597846c1447e50576c88eacdfe042b29bbb43987`
- Database migration: none
- Cloudflare Worker version: `ecae9668-f0c4-4645-9ce8-074c4e26b860`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`
