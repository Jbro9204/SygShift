# Document Center Workbench

**Date:** 09/10/2026  
**Status:** Released and verified in production

## Outcome

The HR document workspace is now a direct, usable Document Center. An authorized user can open an outside PDF immediately, type on it, add a date or checkmark, generate a signature by typing the signer name, and then download, send, save to company documents, or add the completed PDF to a specific employee file from the same workspace.

## User experience

- Replaced the normal multi-step setup path with three clear starting actions: **Open a PDF**, **Find a company document**, and **Add to an employee file**.
- PDFs open directly in a stable workbench with page navigation and a visible two-pane document/action layout.
- Added simple document tools for text, today's date, checkmarks, and typed-name signatures. Four readable signature styles are available, and the selected name is embedded into the completed PDF.
- Added undo, redo, remove-one, and clear-all controls before completion.
- Added a primary **Download PDF** action that remains available without filing or sending the document.
- Added a first-class **Add to employee file** workflow with employee name/number search, a plain document type, and an optional internal note. The filing area is chosen automatically.
- Added **Save to company documents** for reusable internal material.
- Added **Use this document** to the searchable company library and **Work on a copy** to clean PDFs already in Document Center.
- Preserved optional sending from the same workbench. The user selects recipients and the requested action; SygShift chooses the active standard electronic-signature policy and continues tracking the request under Signature Requests.
- Removed quarantine, vault, policy, section, and scan-confirmation language from the ordinary user workflow. Saving returns a clear destination confirmation while scanning continues behind the scenes.
- Added stable retry identities to prevent duplicate uploads or envelopes. Re-saving edited content to the same destination creates a new version of the existing document instead of a duplicate record.
- Renamed the visible module and navigation entry from Document Studio to **Document Center** while retaining the existing advanced signature, template, policy, and processing tools for authorized users who need them.
- Added consistent rounded controls, readable typography, balanced spacing, contained scrolling, sticky completion actions, and responsive light/dark layouts for desktop, 14-inch laptop, tablet, and mobile widths.

## Authorization, data, and security

- Existing exact document permissions, HR MFA boundary, private storage, audit logging, malware scanning, version history, recipient authorization, and signature-envelope contracts remain in force.
- The scan pipeline now operates behind the normal workflow instead of exposing implementation states that stopped or confused users.
- No storage bucket was made public, no authorization was weakened, and no browser was given direct database privileges.
- No database migration was required. No existing employee, document, signature, timekeeping, scheduling, payroll, ticket, or access-control record was updated or deleted by this release.

## Verification

- Complete repository gate: TypeScript and zero-warning lint passed; 238 test files / 1,220 tests passed; Worker and client production builds passed.
- Document Center and mandatory Time Clock browser matrix: 50/50 passed across desktop and mobile.
- Existing Document Studio and company-document-library browser matrix: 20/20 passed.
- Responsive Document Center coverage passed in light and dark themes for desktop and Pixel 7 mobile dimensions, including containment, no horizontal overflow, readable 44-pixel-or-larger controls, visible employee-file actions, and automated accessibility checks.
- PDF finalization tests reopened the produced PDF and verified text, date, and checkmark annotations without changing its page count; filename sanitization also passed.
- Post-deployment mandatory Time Clock regression gate: 42/42 passed across desktop and mobile, including Early Clock-In acknowledgment and the complete punch lifecycle.
- Both `https://app.sygilant.us` and `https://sygshift.sygilant.workers.dev` returned HTTP 200 for health, readiness, and `/hr/documents`; readiness reported every configured dependency healthy.
- The live main JavaScript, application stylesheet, and Document Center bundle matched the final local production build byte-for-byte by SHA-256.

## Release record

- Source commit: `73586c3` (`feat: rebuild Document Center workbench`).
- Cloudflare Worker version: `509d4533-e1d6-4266-abe8-62f6a50eb080`.
- Pre-release fallback tag: `rollback/pre-document-center-workbench-20260910` at `d3e9bc0`.
- Live assets: `index-DE0nSoVo.js`, `index-mV3CF-sX.css`, and `HrisDocumentsPage-CdbB9fz5.js`.
- Verified SHA-256 hashes: main bundle `04627249A497AB1AED880BDBFB7A8DD419DB669344D8CB1111E5F06A15A5F54A`; stylesheet `367348B357D357741710207F4116A2F2748612BCDAD5D1A2E28E6AF0BF8E0F59`; Document Center bundle `7B464FB5EE7735824F91AC7A8F5E74EA41FB570E05D771C11560A4A37FA9BBCD`.

## Recovery

The application can be restored to the fully verified pre-release source with `rollback/pre-document-center-workbench-20260910`. Because this release required no database migration and did not alter existing records, recovery is presentation/application-only and does not require data rollback.
