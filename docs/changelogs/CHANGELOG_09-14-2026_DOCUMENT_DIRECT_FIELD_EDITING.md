# Document Direct Field Editing — September 14, 2026

## Outcome

The Document Center now treats the PDF itself as the primary form. An authorized user can click detected text, long-text, choice, checkbox, and signature fields directly on the page, complete them in place, and use the synchronized side field list only when it is helpful. Long-form editors remain inside the printed section instead of covering later rows or sections.

## What changed

- Added direct on-document inputs for native PDF fields and the controlled field map derived from flattened HR forms.
- Added direct check and clear behavior for native checkbox widgets and printed checkbox glyphs.
- Added direct signature-field selection. Clicking the signature location opens the signer-name and style controls at the top of the side panel, then places or replaces the complete generated signature inside that field.
- Kept the side field list synchronized with every on-page edit, including page changes and the currently selected field.
- Constrained long-form editors to the space before the next printed section or field. Long content scrolls inside the editor while it is being written and remains subject to the existing bounded final-output validation.
- Kept completed answers visible when moving from Edit to File or Send so destination selection does not appear to erase work.
- Preserved manual text, date, check, and signature placement for outside documents that do not expose detectable form fields.

## Safety and preservation

- Preview, download, employee filing, and sending still use the same completed-PDF finalizer and the same final byte fingerprint.
- Document permissions, recent HR MFA, private storage, malware scanning, controlled versions, audit evidence, employee-file associations, and delivery authorization were not bypassed or weakened.
- No database migration or production-data mutation was required.
- Employee records, documents, schedules, punches, payroll, requests, notifications, and access-control records were not changed by this release.
- Pre-release rollback tag: `rollback/pre-document-direct-field-editing-20260914`.

## Verification

- Focused PDF/workbench tests passed: **2 files / 20 tests**.
- Theme-contract and focused component tests passed: **3 files / 23 tests**.
- Focused Document Center browser checks passed **12/12** across desktop and mobile in light and dark modes.
- Full repository gate passed: **259 test files / 1,321 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Full browser matrix passed: **328 passed / 12 intentional skips / 0 failures** across desktop and mobile.
- Post-release actual-component Time Clock preservation passed **42/42** across desktop and mobile.
- Both production origins returned HTTP `200` for health, readiness, and `/hr/documents`; the protected Document Center workspace continued to return HTTP `401` without an authenticated session.
- The live main JavaScript, shared stylesheet, Document Center bundle, and PDF viewer bundle matched the fresh production build byte-for-byte on both origins.

## Release references

- Source commit: `52a194a`
- Database migration: none
- Cloudflare Worker version: `110a65f2-f98a-4fd5-9883-5bc349810a68`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`

## Files

- `src/components/DocumentWorkbench.tsx`
- `src/components/DocumentWorkbench.test.tsx`
- `src/App.css`
- `tests/e2e/document-workbench-layout.spec.ts`
- `docs/future-items/FUTURE_ITEMS.md`

## Remaining acceptance item

The final authorized owner-session roundtrip on a selected real HR document—complete, preview, download, file, reopen, and optionally send—remains the explicit production acceptance item. Automated equivalents and non-mutating production checks do not replace that user-owned record action.
