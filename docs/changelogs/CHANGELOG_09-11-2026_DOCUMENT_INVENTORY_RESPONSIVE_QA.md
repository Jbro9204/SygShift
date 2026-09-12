# Document Inventory Responsive QA Repair

**Date:** 09/11/2026
**Status:** Released and technically verified in production; owner visual acceptance pending

## Outcome

Expanded Document Center rows now keep document metadata and document actions in separate, balanced regions. Long filenames can wrap without being squeezed behind **Work on a copy**, **Preview**, **Download**, or **Remove from employee file**, and the same controls remain full-sized and usable on laptops, compact screens, and phones.

## Problem and root cause

- The expanded row used a two-column grid with a flexible metadata area beside a fixed-width group of four actions.
- At the reported screen width, the action group consumed most of the row and forced the file metadata into a narrow column, producing severe wrapping and visual overlap.
- The action group could not wrap into a deliberate second row, so the layout became progressively worse as the viewport narrowed.

## Repair

- Moved the document actions into a dedicated responsive action bar below the metadata, separated by a consistent divider and 16-pixel top cushion.
- Rebalanced the metadata grid for wide and medium screens, gave the filename a full row when space is constrained, and moved all metadata to one column on narrow phones.
- Changed the mobile action bar to one full-width control per row and guaranteed a 44-pixel minimum touch target.
- Added an explicit accessible relationship between each expandable summary and its detail panel, plus a named action group for assistive technology.
- Added geometry checks that fail on metadata/action overlap, button overlap, horizontal overflow, narrow filename rendering, or undersized action targets.
- Exercised the repaired row at 1461, 1366, 1024, 768, 390, and 320 pixels in both light and dark themes.

## Scope and safety

- This was a presentation and accessibility repair only.
- No API, database, employee record, document record, storage object, permission, MFA, scan, audit, schedule, timekeeping, or notification behavior changed.
- No database migration or production-data mutation was required.
- The existing document access and recoverable archive/restore boundaries remain unchanged.

## Verification

- `pnpm check` passed TypeScript, zero-warning application lint, 251 test files / 1,287 tests, the Worker build, and the client production build.
- The focused Document Center/Studio browser matrix passed 44 checks with two expected project-specific skips and zero failures.
- The complete browser regression gate passed 322 checks with 12 expected project-specific skips and zero failures across HR, Document Studio, Employee Files, SygSphere, SygTasks, password recovery, notifications, timekeeping, desktop, mobile, light, and dark presentation.
- The required post-release Time Clock and Early Clock-In preservation matrix passed 46/46 across desktop and mobile.
- Both production origins return HTTP 200 for `/api/v1/health`, `/api/v1/ready`, and `/hr/documents`, and readiness reports `ready: true`.
- Signed-out access to `/api/v1/hr/documents/workspace` remains denied with HTTP 401 on both production origins.
- The six entry JavaScript/CSS assets referenced by the live Document Center match the fresh production build byte-for-byte on both origins. The custom-domain HTML differs only by Cloudflare's expected analytics beacon.

## Release

- Application source: `d483fb0` (`fix: stabilize document inventory layout`).
- Cloudflare Worker version: `8f8366d2-69a6-4ef1-bc4a-8b045f074860`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-document-inventory-layout-qa-20260911` at `5d1b435`.
- If rollback is required, restore that application source and redeploy. No database rollback is needed because this release contains no schema or data change.
