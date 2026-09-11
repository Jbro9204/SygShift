# Employee Document Filing Latency Repair

**Date:** 09/11/2026  
**Status:** Released and verified in production

## Outcome

Adding a completed PDF to an employee file or Company documents now finishes as soon as the exact completed PDF is durably stored and its background processing is queued. The workbench no longer remains blocked while the already-saved file completes asynchronous scanning.

## Confirmed production diagnosis

The reported upload was `Zach Ward Medical Excuse 9.11.26`, a 719,094-byte PDF filed to Zach Ward.

- Created at `2026-09-11T20:00:22.820202Z`.
- Durably stored at `2026-09-11T20:00:23.142597Z`: 0.322 seconds after creation.
- Background scan completed in 0.790 seconds once the scanner received the job.
- The document reached `clean` at approximately 49.103 seconds after creation because it waited for background scanner pickup.

The file was not taking 49 seconds to save. The workbench was synchronously polling for the `clean` state and then downloading the entire stored PDF for a second checksum comparison before reporting success. That duplicated guarantees already enforced by the upload boundary and made a completed filing appear stuck.

## Repair

- Preserved final-PDF generation, server validation, SHA-256 calculation, immutable document/version creation, private storage, scan queue dispatch, and background malware/integrity processing.
- Removed only the workbench's redundant foreground scan polling and full-file re-download from the ordinary File action.
- Continued to reject the filing immediately if the upload boundary returns `rejected` or `cancelled`; a failed upload can never display a saved confirmation.
- Added a clear confirmation that the file is saved and that processing can finish in the background, so the user can close the workbench immediately.
- Triggered an immediate document-inventory refresh without making that refresh block the confirmation.
- Kept the Send action's existing clean-document requirement intact so recipients are not given access before processing finishes.
- Changed the progress label from `Saving and verifying document` to the accurate `Saving document`.

## Scope and safety

- No database migration was required.
- No production data or document was altered or deleted by this release.
- No authorization, recent-MFA, vault, private-storage, file-validation, malware-scanning, download, preview, or audit control was weakened or bypassed.
- The document scanner container, queue, Worker bindings, routes, and scheduling/timekeeping code were unchanged.
- The affected Zach Ward document is stored and in the `clean` state.

## Verification

- Focused Document Workbench and document-guard gate: 3 files / 15 tests passed.
- Complete repository gate: 250 test files / 1,277 tests passed; TypeScript, zero-warning lint, Worker build, and client production build passed.
- Complete browser gate: 316 tests passed, 10 intentionally skipped duplicate SygTasks mobile-project cases, and zero failed.
- Combined document and clock browser matrix: 82/82 passed before release.
- Post-release Time Clock and Early Clock-In matrix: 46/46 passed across desktop and mobile.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned healthy and ready with every readiness check passing.
- The live main JavaScript, stylesheet, and HR Documents page bundle match the tested local production build byte-for-byte.

## Release record

- Source commit: `9b99356` (`fix: complete employee document filing promptly`).
- Cloudflare Worker version: `f6539268-095e-42d3-8144-569a14d6a6d2`.
- Pre-release rollback tag: `rollback/pre-document-filing-latency-repair-20260911` at `95d7608f5cabd0495c8a3ab2edb8a60e81773c97`.

## Files

- `src/components/DocumentWorkbench.tsx`
- `src/components/DocumentWorkbench.test.tsx`

## Recovery

The prior application release can be restored with `rollback/pre-document-filing-latency-repair-20260911`. No database rollback is needed because this repair contains no migration and made no data changes.
