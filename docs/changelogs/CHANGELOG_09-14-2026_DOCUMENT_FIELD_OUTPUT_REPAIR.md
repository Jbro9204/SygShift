# Document Field Output Repair — September 14, 2026

## Outcome

The Document Center now keeps completed information inside the intended PDF fields instead of painting text, checks, or signatures loosely over the source page. The correction is implemented in the shared finalization path used by preview, download, employee filing, and sending, so it applies to both approved company documents and outside PDFs opened in the workbench.

## Root causes repaired

- Short bracketed fields were exported through the ordinary multiline text path. Long values such as a job title could wrap into the next table row and overlap another answer.
- Long narrative fields had no enforced vertical boundary during finalization.
- Manual checks depended on a Zapf Dingbats glyph and used a top-left click anchor, which allowed the saved mark to render outside the printed checkbox or disappear in some viewers.
- Signature prompts such as **Enter / Sign** were treated as ordinary text fields. A manually placed signature did not clear the prompt and was sized only from width, allowing the image to cross a shallow signature row.
- Native fillable text fields were flattened without a deterministic fit calculation for the field's actual width and height.

## Shared repair

- Added deterministic single-line fitting for short detected fields. The preferred sans-serif size is retained when it fits and reduced only as much as required to keep the complete value in one row.
- Added bounded multiline fitting for narrative fields. Wrapping and line height are calculated against the detected field width and height before the PDF is produced; content that cannot fit is rejected with a plain field-specific instruction instead of producing an overlapping document.
- Applied the same bounded fitting rules to standard native PDF text widgets before their appearances are flattened.
- Replaced glyph-based manual checkmarks with two visible vector strokes centered on the selected checkbox location.
- Recognized static and native signature fields, added a plain **Place signature here** guide, snapped a signature placed near that field to its center, cleared the old signature prompt, and constrained the generated image by both field width and field height.
- Kept preview, download, employee filing, and sending on the existing one-file fingerprint path so all four destinations continue to use the same finished PDF bytes.
- Preserved the established rounded controls, readable sans-serif typography, even cushioning, mobile stacking, and keyboard/touch behavior.

## Safety and preservation

- No database migration or production-data mutation was required.
- Document permissions, recent HR MFA, private storage, scanning, immutable versions, audit history, employee-file associations, delivery authorization, and signature evidence were not weakened or bypassed.
- Employee records, documents, schedules, punches, payroll, requests, notifications, and access-control records were not changed by this release.
- Pre-release rollback tag: `rollback/pre-document-field-output-repair-20260914`.

## Verification

- Focused Document Center and PDF finalization tests passed: **2 files / 18 tests**.
- A rendered PDF output audit confirmed one-line position fitting, bounded long-form wrapping, a visible centered vector check, a fully contained long typed signature, and removal of the underlying signature prompt.
- Focused Document Center browser checks passed **12/12** across desktop and mobile in light and dark modes.
- Full repository gate passed: **259 test files / 1,319 tests**, TypeScript, zero-warning application lint, Worker build, and client production build.
- Full browser matrix passed: **328 passed / 12 intentional skips / 0 failures** across desktop and mobile.

## Release references

- Source commit: pending release commit
- Database migration: none
- Cloudflare Worker version: pending deployment
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`

## Files

- `src/lib/pdfWorkbench.ts`
- `src/lib/pdfWorkbench.test.ts`
- `src/components/DocumentWorkbench.tsx`
- `src/components/DocumentWorkbench.test.tsx`
- `src/App.css`
- `tests/e2e/document-workbench-layout.spec.ts`

## Remaining acceptance item

The final authorized owner-session roundtrip on a selected real HR document—complete, preview, download, file, reopen, and optionally send—remains the explicit production acceptance item. Automated equivalents and non-mutating production checks do not replace that user-owned record action.
