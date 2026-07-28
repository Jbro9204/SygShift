# SygShift Dev Changelog - 07/28/2026

## Update focus

Roles & Permissions Employee Access menu polish.

## Completed

- Reworked the Manage Employee Access chooser so it uses a purpose-sized modal instead of feeling oversized or loosely aligned.
- Added local Employee Access menu action styling so Close and Open Editor align cleanly and resize correctly.
- Reworked the Employee Access editor modal sizing separately from the chooser so the larger role/override workspace has enough room without making the chooser look awkward.
- Added cleaner Employee Access banner spacing, card fit rules, search/select sizing, role-list scroll behavior, and override-card presentation.
- Added regression checks for Employee Access modal classes and local action layout so the UI does not drift back to generic modal/button formatting.

## QA completed

- TypeScript typecheck passed.
- Lint passed.
- Unit/integration tests passed: 24 test files, 82 tests.
- Production build passed.
- Playwright E2E passed: 16/16 desktop and mobile checks.
- Deployed smoke check passed: `https://app.sygilant.us` returned HTTP 200.

## Deployment

- Production URL: https://app.sygilant.us
- Worker URL: https://sygshift.sygilant.workers.dev
- Cloudflare Worker version: `6583134b-09df-4455-a3c0-4f9cba5294c6`
