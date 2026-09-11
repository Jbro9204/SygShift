# Document Roundtrip and SygSphere Thread Layout

**Date:** 09/10/2026  
**Status:** Released and verified in production

## Outcome

The Document Center now proves that the exact completed PDF was stored before it reports a successful save or send. Signatures can be selected, moved, resized, and removed without accidental duplicates, and the same finalized PDF bytes are used for preview, download, filing, and delivery. SygSphere attachment cards now remain readable in a narrow thread panel instead of collapsing filenames into one-character columns.

## Document Center behavior

- Added a **Preview finished PDF** action that renders the same finalized file used by download, filing, and sending.
- Cached finalized PDF output by document fingerprint so every completion path uses one exact file rather than independently rebuilding similar outputs.
- Added a storage roundtrip check after upload. The saved object is reopened and its byte length and SHA-256 digest must match the expected completed PDF before the interface reports success.
- Applied the same stored-byte verification before a signature envelope is created, preventing a send from continuing when storage does not contain the exact completed document.
- Kept the workbench open with a clear retryable error when verification fails; it no longer presents a false **Saved** or **Sent** result.
- Made typed-name signatures selectable, movable, width-resizable, and explicitly removable. Movement and sizing keep the complete signature inside the PDF page.
- Returned to selection mode after placing an annotation so one click does not create repeated signatures or text boxes.
- Preserved finalized text extraction and PDF page count in automated document-output tests.

## SygSphere behavior

- Changed attachment cards to respond to the available thread width rather than the full viewport.
- Preserved usable filename space at narrow widths and moved **Preview** and **Download** beneath the file details when needed.
- Added desktop and mobile regression coverage for the exact narrow-panel layout that previously split filenames into single-character columns.

## Authorization, data, and security

- Existing document authorization, HR MFA, private storage, malware scanning, audit, versioning, recipient authorization, and signature-envelope boundaries remain in force.
- Storage verification uses authenticated application paths and does not expose a public object or bypass document access controls.
- No database migration or production-data mutation was required.
- No employee, document, signature, message, schedule, timekeeping, payroll, ticket, notification, role, permission, or access-control record was changed or deleted by this release.

## Verification

- Complete repository gate passed: TypeScript, zero-warning lint, 239 test files / 1,227 tests, Worker build, and client production build.
- Focused PDF/workbench tests passed 9/9, including text extraction, signature resize/bounds, exact-file reuse, successful stored-byte verification, and rejection of a checksum mismatch.
- Document Studio and mandatory Time Clock browser matrix passed 54/54 across desktop and mobile.
- The corrected narrow SygSphere attachment layout passed 2/2 across desktop and mobile after the regression scenario was made self-contained.
- Post-deployment mandatory Time Clock and Early Clock-In matrix passed 42/42 across desktop and mobile.
- Document foundation, pipeline, workspace, workflow, and administration-permission validators passed against the current protected architecture.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned healthy/ready responses, and `/hr/documents` returned HTTP 200.
- The live main JavaScript, stylesheet, Document Center bundle, and secure PDF viewer matched the final local production build byte-for-byte by SHA-256.

## Release record

- Source commit: `691431f` (`fix: verify Document Center output and thread layout`).
- Cloudflare Worker version: `dcad2b7a-34df-4e1e-9ac9-fa0f8a1fe1cd`.
- Pre-release fallback tag: `rollback/pre-document-roundtrip-and-thread-layout-20260910` at `eda10f09f0164fd3009b827630467a90efa917c1`.
- Live assets and verified SHA-256 hashes:
  - `index-BS3mSQ7d.js`: `E8B65559C59A38A91712C21B2E1B1717019050362DCC59412166D68AE6FBC07B`
  - `index-CG9TRMke.css`: `4A8E7578E511D91CBCA95BE03185E62BE8B0C710D3847A1FE082BC80A03947BE`
  - `HrisDocumentsPage-CAY-eg_t.js`: `E97C369CB08C63EE72EAE21B63184377AA16739B0117337888B1916A7CEEE1DE`
  - `SecurePdfViewer-D1iQgkk5.js`: `132F53E120F5CEA128C2B16568B00F785205EBCBF505417E53AA327E35994B5E`

## Recovery

The application can be restored to the fully verified pre-release source with `rollback/pre-document-roundtrip-and-thread-layout-20260910`. Because this release required no database migration and did not mutate production records, recovery is application-only and requires no data rollback.
