# Document Access, Upload, and Preview Repair

Date: 09/10/2026

## Outcome

The document system no longer makes authorized employees type a redundant access reason before every ordinary view or download, supported business documents are no longer rejected by overly broad content rules, and the shared PDF viewer now reliably paints the document instead of opening a large blank canvas. The repair covers HR Documents, Document Studio and signatures, Licensing, Client Files, and SygSphere attachments.

## Problems and root causes

- Document access screens duplicated information the system already knew: the signed-in employee, permitted action, document, route, and time. A required free-text reason added friction without strengthening the audit record.
- The shared PDF viewer handed PDF.js a short-lived browser object URL and could reuse the same canvas while an earlier render was still being cancelled. A file could report its page count but never finish painting the visible page.
- The preview modal inherited a narrow global modal width. Its paging and search controls compressed and wrapped vertically while the viewer reserved an oversized blank region.
- PDF validation rejected every `/OpenAction`, including harmless initial-page or initial-view instructions commonly written by normal PDF software.
- Office validation rejected every external relationship, including ordinary `http`, `https`, `mailto`, and `tel` hyperlinks in DOCX and XLSX files.
- Some Windows/browser uploads provide no useful MIME type even when the extension and file signature are valid, causing otherwise supported PDF, DOCX, and XLSX files to be stopped before the server could validate them.

## Functional changes

- Ordinary authorized View and Download actions start directly. The Worker records an automatic, specific audit reason for HR Documents, Licensing, and Client Files.
- PDF data is fetched into stable bytes before PDF.js opens it. Rendering is serialized, prior work is cancelled safely, fit-to-width responds to container changes, and the canvas appears only after the page has actually painted.
- The shared viewer and SygSphere preview modal now use a wider bounded layout, contained scrolling, readable progress and error states, non-wrapping controls, and responsive desktop/mobile toolbars.
- MIME inference now recognizes supported PDF, DOCX, XLSX, TXT, JPEG, PNG, and WebP uploads when the browser omits or generalizes the type. The Worker still verifies the actual file signature and structure.
- Normal PDF initial-view actions and normal Office web/email/telephone hyperlinks are accepted. JavaScript, launch actions, embedded files, ActiveX, macros, OLE, linked files, remote templates, external data sources, and other dangerous active content remain blocked.
- Document-facing language now describes uploading, opening, sharing, signing, and recovery in direct terms instead of exposing internal pipeline jargon.
- SygSphere upload recovery retains the clearer **Finish upload** action and continues the same upload without making the employee select or transmit the file again.

## Security retained

- Exact server-side permissions and row scope remain enforced.
- Required HR identity verification/MFA remains enforced.
- Private storage, quarantine, file-signature validation, size limits, malware scanning, short-lived access, participant-only SygSphere access, and append-only access/scan audits remain in place.
- No storage bucket was made public, no authorization boundary was bypassed, and no dangerous document capability was enabled.

## Files and data

- Rebuilt the shared viewer in `src/components/SecurePdfViewer.tsx` and its responsive presentation in `src/App.css` and `src/styles/sygsphere.css`.
- Updated HR, Licensing, Client Files, Document Studio, signature, and SygSphere document flows in their existing pages and data modules.
- Narrowed false-positive document validation and added automatic audit descriptions in `worker/index.ts`.
- Added and updated component, pipeline, architecture, usability, and browser regression coverage.
- No database migration or production-data mutation was required.

## Verification

- `pnpm check`: passed TypeScript, zero-warning application lint, 234 test files, 1,205 tests, Worker build, and client production build.
- New coverage proves stable PDF bytes are supplied to PDF.js, the canvas is shown only after a successful paint, failed previews provide a usable fallback, MIME inference accepts supported Windows/browser uploads, and dangerous active content remains denied.
- Combined Document Studio, SygSphere, and mandatory actual-component Time Clock browser matrix: 104 unaffected checks passed in the full run; the two recovery checks whose selector used the retired button label passed on desktop and mobile after the test was aligned to **Finish upload**. All 106 checks were verified.
- Mandatory post-deployment Time Clock matrix: 42/42 desktop/mobile checks passed, including early-clock-in acknowledgment, clock-in, break, clock-out, shift return, active controls, ambiguity handling, permission denial, and duplicate-submission protection.
- Production health, readiness, `/hr/documents`, and `/sygsphere` returned HTTP 200 on the primary and fallback origins.
- Main JavaScript, global CSS, PDF viewer, HR Documents, Licensing, Client Files, and SygSphere assets match the verified production bundle byte-for-byte on both origins.

## Release

- Application source: `2328da7` (`fix: repair document access upload and preview`).
- Cloudflare Worker version: `29691cf9-16fb-4e02-a913-a90b0ce51e3d`.
- Primary URL: `https://app.sygilant.us`.
- Fallback URL: `https://sygshift.sygilant.workers.dev`.

## Rollback

- Pre-release source tag: `rollback/pre-document-workflow-repair-20260910` at `47efe51`.
- If containment is required, restore the tagged application source and redeploy with the existing private storage, scanner, and authorization bindings preserved.

## Remaining limitations

- This release repairs the existing supported upload, preview, download, sharing, and internal signing workflows. OCR, native PDF content editing, irreversible redaction, page restructuring, external signers, and organizational seals remain separately gated future capabilities.
