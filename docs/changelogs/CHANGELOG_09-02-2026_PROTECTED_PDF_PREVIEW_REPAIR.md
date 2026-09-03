# Protected PDF Preview Repair

Date: 09/02/2026

## Outcome

Protected PDF documents now open inside SygShift instead of displaying Chrome's blocked-page error. The repair covers every remaining legacy PDF preview path: Licensing Center and Client Files now use the same PDF.js-based viewer already used by Document Studio and employee signature documents.

## Root cause and repair

- Licensing Center and Client Files fetched the correct private file and created a local object URL, but then embedded that URL in a sandboxed iframe.
- SygShift's strict application content-security policy correctly prevented that frame from loading, so Chrome displayed a blocked-page message even though authorization and file retrieval had succeeded.
- Replaced both iframe paths with the centralized SecurePdfViewer, which renders PDF pages to an in-app canvas and provides page navigation, zoom, fit-to-width, rotation, and text search.
- Added a visible Opening protected PDF state so a legitimate render delay does not look like another blank preview.
- Widened the Client Files preview modal and retained bounded, responsive layouts in light and dark modes.

## Security and preservation

- Private Supabase storage, same-origin Worker delivery, permission checks, recent authenticator or FIDO verification, business-reason capture, no-store responses, and access audit events remain unchanged.
- No public or signed storage URL was introduced.
- The global content-security policy was not weakened.
- Download behavior and image previews remain unchanged.
- No database migration or production data change was required.

## Regression protection

- Licensing and Client Files guard tests now require the centralized PDF viewer and reject reintroduction of iframe-based PDF previews.
- A repository-wide source scan confirms no application page contains an iframe.
- The deployed Licensing and Client Files bundles both import the production SecurePdfViewer chunk and contain no iframe token.

## Verification

- Full release gate passed: TypeScript, zero-warning lint, 156 test files / 755 tests, and both Worker and client production builds.
- Focused Licensing, Client Files, and Document Studio browser checks passed 20/20 across desktop and mobile Chromium in light and dark modes.
- Production asset verification confirmed the PDF viewer chunk and PDF worker are present and referenced by both repaired document surfaces.
- Primary and fallback application, health, and readiness endpoints returned HTTP 200; the readiness response reported all checks ready.

## Release status

- Implementation commit: `fe9e99e`, pushed to `origin/main`.
- Cloudflare Worker version: `0e57e4a9-ff51-4c06-bcb3-16c49fc501ad`.
- Database migration: not required.

