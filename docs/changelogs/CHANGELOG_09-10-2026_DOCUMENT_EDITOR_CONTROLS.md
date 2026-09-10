# Document Center Editor Controls

**Date:** 09/10/2026
**Status:** Released and verified in production

## Outcome

The Document Center PDF workbench now supports practical long-form editing. Text remains editable after placement, wraps within a visible text box, can be moved and resized, and is written into the downloaded, filed, or sent PDF with the same width, font size, wrapping, and deliberate line breaks. The workbench can also expand to a full-screen editing view.

## User experience

- Corrected the employee and recipient search fields in the **File** and **Send** panels. A stronger global modal rule had overridden their left padding; the workbench now reserves measured space between the magnifying glass and entered or placeholder text.
- Added a maximize/restore control that expands the workbench to the usable viewport while retaining the existing PDF, current page, panel, annotations, and completion actions.
- Replaced click-to-delete annotation behavior with explicit selection. Selecting an item never removes it.
- Added pointer and touch dragging for placed text, dates, checkmarks, and signatures, plus arrow-key movement for keyboard users.
- Added a visible resize handle for selected text boxes, a width slider, and font-size controls from 8 through 28 points.
- Added direct editing of selected text and an explicit **Remove text box** action.
- Replaced the short single-line text control with a cushioned multiline editor for long content.
- Added visual wrapping for placed text and matching PDF-export wrapping, including preserved paragraph breaks and safe hard wrapping for unusually long unbroken text.
- Upgraded undo and redo to restore complete annotation snapshots, covering placement, movement, resizing, content edits, size changes, removal, and clear-all actions.
- Preserved rounded controls, SygShift typography, balanced spacing, light/dark styling, contained scrolling, and mobile/laptop behavior.

## Authorization and data

- No database migration was required.
- Existing document authorization, HR MFA, private storage, audit, scanning, filing, sending, signing, and versioning boundaries were not changed.
- No employee, document, signature, schedule, timekeeping, payroll, ticket, notification, or access-control record was changed or deleted by the release.

## Verification

- Complete repository gate passed: TypeScript, zero-warning lint, 239 test files / 1,223 tests, Worker build, and client production build.
- Focused PDF and editor tests passed for long-form wrapping, explicit line breaks, movement, resizing, text editing, undo, selection without deletion, and maximize/restore behavior.
- Document Center browser matrix: 12/12 passed across desktop and Pixel 7 mobile dimensions in light and dark themes, including measured search-icon clearance, long-text containment, full-screen behavior, no horizontal overflow, and automated accessibility checks.
- Existing Document Center, company-library, and Licensing document browser suites: 24/24 passed.
- Mandatory actual-component Time Clock and Early Clock-In suite: 42/42 passed before release and 42/42 passed again after deployment.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned HTTP 200 for health, readiness, and `/hr/documents`; readiness reported every configured dependency healthy.
- The live main JavaScript, application stylesheet, and Document Center bundle matched the final local production build byte-for-byte by SHA-256.

## Release record

- Source commit: `cbe1603` (`fix: make Document Center annotations fully editable`).
- Cloudflare Worker version: `9d86390f-91b1-4add-9552-25866bb5ed33`.
- Pre-release fallback tag: `rollback/pre-document-editor-controls-20260910` at `d993ebb`.
- Live assets: `index-CbdfOGis.js`, `index-BCKToNMu.css`, and `HrisDocumentsPage-Bucm22nY.js`.
- Verified SHA-256 hashes: main bundle `20B307146D0CA3873C0C37FCB9137BF7E6061F15A9C64A53B1097CC1CC51B447`; stylesheet `711BA2F87CD9BF33123E21879870933097A57F7917620E2C6BB6C4F6A8751E0D`; Document Center bundle `14DBCA2E32049B525F9492868A1DCEC30A3E801AF5030D706D4D88FC1FF155BA`.

## Recovery

The application can be restored to the fully verified pre-release source with `rollback/pre-document-editor-controls-20260910`. Because this release required no database migration and did not modify production records, recovery is application-only and requires no data rollback.
