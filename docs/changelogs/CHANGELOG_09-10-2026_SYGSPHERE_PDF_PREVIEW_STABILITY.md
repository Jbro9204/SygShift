# SygSphere PDF Preview Stability Repair

Date: 09/10/2026

## Outcome

SygSphere PDF previews now remain visually stable while PDF.js prepares a page, responds to a viewport change, zooms, or rotates. The last completed page stays visible until the next frame is completely painted, eliminating the severe white flashing reported after a document was shared.

## Root cause corrected

- The viewer painted directly into the visible canvas and hid that canvas whenever a render began.
- The temporary in-flow **Rendering page** message changed the available preview width while the canvas was hidden.
- The viewer's `ResizeObserver` correctly reacted to that width change, but the reaction started another render and another hide/show cycle. Browser scrollbar and modal-width changes could therefore sustain a visible rendering loop.
- Direct rendering also exposed the cleared white canvas before PDF.js finished painting a replacement page.

## Application changes

- PDF.js now renders each requested page into a detached canvas buffer.
- The visible canvas retains the last fully rendered page while a new size, zoom level, rotation, or page is prepared.
- A completed buffer is copied into the visible canvas synchronously, so partially painted or blank frames are never presented.
- The visible canvas is hidden only before the first successful page render or after an actual preview error.
- The initial loading status is positioned outside normal layout flow, preventing it from changing the measured canvas width and triggering a render loop.
- Added accurate `aria-busy` state while preserving the existing page, zoom, fit-width, rotate, and search controls.

## Preservation boundary

- No database migration or production-data update was required.
- No uploaded file, conversation, message, storage object, role, permission, MFA setting, schedule, punch, payroll, HR, or employee record changed.
- Document authorization, participant checks, file validation, scanning, download behavior, and audit handling remain unchanged.
- The repair is shared by every workflow that uses `SecurePdfViewer`, including SygSphere and the controlled HR, client, licensing, and signature previews.

## Verification

- Focused PDF viewer and SygSphere tests: 24/24 passed.
- The new real-browser PDF.js stability test creates and renders an actual PDF, samples the canvas on every animation frame, then resizes, zooms, and rotates the viewer.
- Desktop Chromium result: zero blank frames and zero hidden-canvas transitions after the initial completed page appeared.
- Mobile Chromium result: zero blank frames and zero hidden-canvas transitions after the initial completed page appeared.
- `pnpm check` passed TypeScript, zero-warning application lint, 234 test files, 1,208 tests, the Worker build, and the production client build.
- The complete SygSphere and mandatory actual-component Time Clock browser matrix passed 94/94 desktop/mobile checks in a serial clean run.
- Post-deployment mandatory Time Clock workflow passed 42/42 desktop/mobile checks, including Early Clock-In acknowledgment and clock-in, break, and clock-out controls.
- Primary and fallback production health returned `ok`; readiness returned `ready`; `/sygsphere` returned HTTP 200 on both origins.
- Live PDF viewer asset `assets/SecurePdfViewer-BVOEjhm-.js` and the production stylesheet match the verified release build byte-for-byte on both origins; the live viewer asset contains the buffered canvas swap.

## Release

- Application source: `c57fd69` (`fix: stabilize SygSphere PDF previews`).
- Cloudflare Worker version: `b0b7c330-1c96-45ae-8057-54de7c4f23c9`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-sygsphere-pdf-preview-stability-20260910` at `5bed3d3`.
- This is an application-only release. If containment is required, restore the tagged application source and redeploy with the existing bindings preserved.

