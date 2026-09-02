# Enterprise Document Studio and Signature System

Date: 09/02/2026

## Outcome

SygShift now has one shared, production-structured Document Studio and electronic-signature system built on the existing private HR document vault, employee identity, effective permissions, MFA, audit history, notifications, and background processing. It does not create a second file store, signature identity, employee directory, permission model, or audit log.

The system is installed fail-closed. Document upload, processing, signature execution, advanced editing, regulated-document handling, external signers, and organizational seals remain disabled until the approved malware-scanner canary and recovery drill pass. No HR document or signature record was created during the release.

## Problem and user impact

The earlier HR document foundation could securely store and assign future records, but it did not provide one coherent workspace for policies, reusable templates, field placement, signature routing, employee execution, final signed renditions, and audit certificates. The approved design also requires processor-backed malware scanning, OCR, true PDF content editing, and irreversible redaction; those capabilities must not be represented as working without an approved document processor.

## What changed

- Added granular Document Studio permissions and role-aware grants while preserving existing roles, assignments, individual overrides, employees, documents, and audit history.
- Added versioned document policies, templates, normalized field definitions, record associations, signature adoptions, envelopes, recipients, consent, authentication evidence, field values, processing jobs, lifecycle events, comments, and immutable audit certificates.
- Added exact-version signature routing with sequential or parallel recipients, decline and correction paths, expiry, reminders-ready metadata, saved/typed/drawn/uploaded signature appearances, and signer-only field enforcement.
- Added final signed-PDF generation with source, appearance, and final checksums; a downloadable audit certificate; retry, backoff, stale-lease recovery, and dead-letter handling.
- Added a real PDF.js-based protected viewer with page navigation, direct page selection, search, zoom, fit width, and rotation.
- Added the protected Document Studio dashboard for policies, templates, fields, signature envelopes, processing state, and compact 10-row worklists.
- Added the employee My Documents execution experience and homepage pending-action signal.
- Kept unavailable OCR, arbitrary content editing, page manipulation, annotation, and irreversible redaction controls out of the interface. Those features remain behind the disabled advanced-processing gate instead of appearing as fake actions.

## Security and preservation

- Every database function is service-only, uses a fixed search path, rechecks the actor's effective permissions, and applies recent authenticator or FIDO verification where required.
- Original source versions remain immutable. Signatures are pinned to the exact clean source checksum and cannot be applied to a later replacement.
- Consent wording/version, identity-verification method/time, assigned recipient, field values, signature method, trusted timestamps, request IDs, source checksum, final checksum, and evidence-package checksum are recorded.
- Signature images are private, checksum-verified, owner-only, and never exposed through public storage URLs.
- Signed completion creates a new immutable version and locks the canonical document; it does not overwrite the uploaded source.
- Retry cleanup cannot delete an appearance after its signature event has committed.
- Storage, private tables, and service functions remain inaccessible to anonymous and authenticated browser database roles.
- The migration includes a before/after preservation assertion for employees, access-role assignments, permission overrides, existing HR documents, versions, and access events.

## Libraries

- Mozilla PDF.js / `pdfjs-dist` (Apache-2.0) provides local protected PDF rendering and search.
- `pdf-lib` (MIT, already used by SygShift) produces signed renditions and audit certificates.
- Local Fontsource packages provide four OFL-licensed signature-style fonts. No remote font or document-processing request was added.

## Verification

- The complete forward migration executed successfully against the linked production database inside a transaction and rolled back cleanly.
- The final application gate passed: TypeScript, zero-warning lint, 151 test files / 733 tests, and both Worker and client production builds.
- All 88 desktop/mobile Playwright checks passed, including the new Document Studio and signer experiences in light and dark modes with automated accessibility checks.
- Production migration application, Git push, Cloudflare deployment, and live health/readiness verification are recorded below after the release completes.

## Release status

- Migration: rollback rehearsal passed; production application pending.
- Git: pending final verified commit and push.
- Cloudflare: pending final verified deployment.
- Live health/readiness: pending final verified deployment.

## External release blocker

An approved malware-scanning/document-processing service and a completed recovery canary are still required before HR document upload or signature execution can be enabled. OCR, true native PDF content editing, irreversible redaction, sanitization, page restructuring, and processor-derived previews remain intentionally unavailable until that service, its data-processing terms, supported file limits, recovery behavior, and security evidence are approved and integrated. The application does not claim or display those capabilities today.

## Rollback

This is an additive, forward-only schema release. The application can be rolled back to the prior Worker revision without deleting the dormant Document Studio schema. Database correction must use a new forward migration. All release gates remain disabled, so rollback does not require moving or rewriting any employee document.
