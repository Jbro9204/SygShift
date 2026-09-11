# Document Center Complete Repair

**Date:** 09/11/2026  
**Status:** Released and technically verified in production; owner workflow acceptance pending

## Outcome

The Document Center now supports a direct, usable workflow for completing approved PDFs, finding an employee, placing a complete typed signature, previewing the exact finished file, filing it, and later removing or restoring an accidental upload without deleting its history.

## Repairs

- Gave the File and Send employee-result lists a stable usable height and independent scrolling so matching people render as complete selectable rows instead of a clipped strip.
- Rebuilt typed-signature rendering around the generated image's measured glyph bounds and real aspect ratio. Long names now scale inside the signature box without cutting off the first or last characters, and the editor uses the same PNG that is embedded in the finished PDF.
- Added guided fields for approved PDFs containing bracketed prompts. Detected fields appear in a straightforward form, support short and long answers, can prefill matching employee name/ID fields, remain editable, and visually replace the original prompt in the finished PDF.
- Replaced temporary `blob:` fetching in Document Center PDF previews with stable completed-PDF bytes, preserving the existing production Content Security Policy.
- Stabilized preview painting with an off-screen render buffer and added a visible **Try preview again** recovery action instead of leaving a blank or dead-end viewer.
- Added **Remove from employee file** and **Archive** to manageable document actions with one plain confirmation. The normal action is recoverable, never deletes the file, and automatically records the actor, version, timestamp, employee association, and reason.
- Added **Restore** through the existing **Include archived** inventory path.
- Prevented archive operations from bypassing permissions, recent HR MFA, legal holds, active employee assignments, completion evidence, active signature requests, document processing, or a currently published form source. Blockers are returned in plain language.

## Scope and safety

- Migration `20260912190000_hr_document_archive_restore.sql` adds one service-only archive/restore function with a fixed search path and service-role-only execution.
- The existing Worker session, exact Document Studio permission, recent-HR-MFA, private-storage, version, scanning, and audit boundaries remain in force.
- No existing employee, document, version, signature, schedule, timekeeping, or audit record was deleted or rewritten during deployment.
- The production Content Security Policy was not relaxed.
- A pre-release rollback tag was created before any change: `rollback/pre-document-center-complete-repair-20260911` at `d9b0dea7f0083947eecfd9926ac9ad9bd7664ba6`.

## Verification

- Focused Document Center, PDF viewer, lifecycle, and access-boundary tests passed.
- Complete repository gate passed: TypeScript, zero-warning lint, 251 test files / 1,286 tests, Worker build, and client production build.
- Complete desktop/mobile browser gate passed: 320 tests, 10 expected duplicate-project skips, and zero failures.
- Post-release Time Clock and Early Clock-In regression gate passed 46/46 across desktop and mobile.
- Supabase dry-run isolated exactly one migration; the forward migration then compiled and applied successfully, and remote migration history reports `20260912190000` present.
- Both production origins returned HTTP 200 for `/api/v1/health`, `/api/v1/ready`, and `/hr/documents`; the new archive endpoint returned HTTP 401 without a session on both origins.
- The production CSP remains `connect-src 'self' https://*.supabase.co wss://*.supabase.co`.
- The live entry JavaScript, global stylesheet, HR Documents bundle, and Secure PDF Viewer bundle match the fresh production build byte-for-byte on both origins. The custom-domain HTML differs only by Cloudflare's injected analytics beacon; the Worker-domain HTML matches exactly.
- A read-only authenticated production check loaded the new release, confirmed the complete employee inventory, **Include archived**, and **Remove from employee file** action. No real document was archived or altered for the check.

## Release record

- Source commit: `978b8cf` (`fix: complete Document Center workflows`).
- Cloudflare Worker version: `a36ca760-e124-4331-915e-7824091c7daa`.
- Database migration: `20260912190000_hr_document_archive_restore.sql`.
- Pre-release rollback tag: `rollback/pre-document-center-complete-repair-20260911`.
- Live assets:
  - `index-B11a7VED.js` — SHA-256 `a33d5569083073d2bd2e21a6580de62b700e68e5c36735332a7d5e5878096977`
  - `index-BY-ZeoMx.css` — SHA-256 `e5fcb5a45b2c8d9528b7b7fe2d901ed094c97e4e16d619e595577e0efb7ea379`
  - `HrisDocumentsPage-QvqViKTU.js` — SHA-256 `523fa41a02b28a9b7f96bc54ee3e031b28258daf0c508b2144598b7532f5dfc1`
  - `SecurePdfViewer-YikFA-S2.js` — SHA-256 `5119b743af8d22b58d0e312eb1e104a04d3310a500408288c74dec3e74df7f7c`

## Files

- `src/components/DocumentWorkbench.tsx`
- `src/components/SecurePdfViewer.tsx`
- `src/lib/pdfWorkbench.ts`
- `src/pages/HrisDocumentsPage.tsx`
- `src/data/hrDocuments.ts`
- `src/App.css`
- `worker/index.ts`
- `supabase/migrations/20260912190000_hr_document_archive_restore.sql`
- `src/components/DocumentWorkbench.test.tsx`
- `src/components/SecurePdfViewer.test.tsx`
- `src/documentLifecycleGuard.test.ts`
- `src/documentStudioAccessBoundaryGuard.test.ts`
- `tests/e2e/document-workbench-layout.spec.ts`

## Recovery

The application can be returned to the pre-release source using `rollback/pre-document-center-complete-repair-20260911`. The database change is additive and leaves existing records compatible with the prior application; normal document removal is itself recoverable through Restore.
