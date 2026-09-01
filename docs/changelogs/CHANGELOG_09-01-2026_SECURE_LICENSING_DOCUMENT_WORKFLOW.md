# SygShift Change Log — Secure Licensing Documents

**Date:** 09/01/2026  
**Area:** Licensing Center / Protected Documents  
**Status:** Production release complete

## Outcome

The Licensing Center credential-document failure has been repaired. The former browser-to-Supabase Storage upload path, which could be rejected by Storage row-level security before its metadata was recorded, has been replaced by one protected server workflow.

Authorized users can now upload a credential document and then view or download it inside the employee's licensing record. The document list is compact by default at five rows, supports 5/10/20 rows and pagination, and is available from both the credential editor and the employee's Documents & Activity view.

## Security and data handling

- Credential files remain in the existing private `credential-documents` bucket; no public URL or storage object path is returned to the browser.
- Upload, list, preview, and download require an authenticated session, an exact Licensing or credential-editing permission, and recent authenticator or FIDO2 security-key verification.
- The Worker checks extension, declared MIME type, verified file signature, allowed PDF/image content, 25 MB size limit, checksum, and an idempotency key before releasing metadata.
- Partially failed uploads remain archived and unavailable. Successful storage and database release are coordinated through service-only database functions.
- Preview and download require a written business reason and create append-only licensing-document audit events.
- The former authenticated direct-storage policy and legacy browser document-recording RPC grant were removed. Service RPCs have no `anon` or `authenticated` execution grants.
- The release created no document, moved no object, and changed no employee credential. Production had zero credential objects and zero active credential-document metadata before the repair.

## Interface

- Added clear Choose Document and Upload Document controls with progress and retry-safe error handling.
- Added a compact protected-document list with file name, size, upload time, View, and Download.
- Added in-browser previews for PDF, PNG, JPEG, and WebP files.
- Added a dedicated document viewer for users who can view Licensing but cannot edit credentials.
- Verified responsive containment, usable controls, and contrast in light and dark themes on desktop and mobile.

## Verification and rollout

- Applied forward migration `20260902030000_secure_licensing_document_workflow.sql`; its transaction preserved employee, credential, legacy document metadata, storage object, access, schedule, time-event, and payroll-export state.
- Post-migration checks confirmed all five secure columns and five protected service functions, zero direct authenticated Storage policies, zero browser service-function grants, zero active credential-document records, and zero credential Storage objects.
- Migration version `20260902030000` is recorded in the linked production ledger.
- `pnpm check` passed: type checking, zero-warning lint, 139 test files / 680 tests, and Worker/client production builds.
- All 48 Playwright checks passed across desktop and mobile, including the new light/dark licensing-document layout and accessibility coverage.
- Deployed Cloudflare Worker version `137f2bbb-03f8-4e41-9d9e-4734fce4d57a`.
- Primary and fallback login, health, and readiness endpoints returned HTTP `200`; readiness confirmed assets and protected server configuration.
- Unauthenticated list, upload, preview, and download route checks returned HTTP `401`.
- The live Licensing Center bundle contains the new protected preview, download, and document workspace controls.

## Operational note

No production employee document was invented or uploaded for verification. The first authorized real upload should be performed from the relevant employee credential record; it will exercise the now-live protected path and appear immediately in the same modal.
