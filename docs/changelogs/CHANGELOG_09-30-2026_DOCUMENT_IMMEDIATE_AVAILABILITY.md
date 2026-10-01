# Document Immediate Availability

Date: 09/30/2026  
Status: Released to production

## Outcome

Document Center and SygSphere attachments no longer wait for an asynchronous
security scan, queue, container, callback, or retry loop. A supported upload
becomes usable as soon as the saved private object passes the platform's
storage-integrity checks.

This applies to HR documents, generated and filed employee documents, and
SygSphere attachments. The matching Sygilant release covers client documents,
report evidence, fuel receipts, commercial PDFs, TrackTik archives, and client
portal attachments.

## What remains protected

The release removes only the failed scanner gate. It retains and enforces:

- SygShift identity, MFA, effective permissions, tenant/client scope, and
  immutable audit history.
- Private storage, supported file types and sizes, file-signature checks, and
  active-content rejection.
- Byte-for-byte SHA-256 verification of the saved private object, its approved
  size, and its normalized MIME type before availability is recorded.
- Version history, legal holds, retention, and short-lived authorized access.

An upload with a real storage or integrity failure remains private and gives a
plain retry result. It does not enter an invisible scanner queue or a
"being prepared" state.

## Recovery and data boundary

- All existing HR upload operations were already available at cutover.
- Eight stranded SygSphere files were read from private storage, verified
  against their immutable size and checksum records, and restored to available.
- Seventeen expired resumable uploads remain expired. Rejected, canceled, and
  missing or mismatched records were not reopened.
- Historic scan-event records remain immutable audit history only. They no
  longer approve, deny, queue, retry, or block a document.

## Production changes

- SygShift source commits:
  - `e3d8535` — retire document scanner gates
  - `0fa1c52` — remove legacy SygSphere upload status flow
  - `97f3841` — guard retired SygSphere upload routes
- SygShift hosted migration ledger:
  `20260930231530_document_upload_immediate_availability`.
- Sygilant source commits:
  - `363000b6e1cf731474f350dba492ca3ec2c60d0f` — document-intake contract
  - `00a31b7cc42c37424c7d306ba07b825868ea1659` — remove SygSphere scan polling
- Sygilant hosted migration ledger:
  `20260930231523_sygilant_document_intake_immediate_availability`.

## Retired infrastructure

The following scanner-only infrastructure was removed after both application
paths were live and verified:

- Cloudflare Worker `sygilant-evidence-scanner`.
- Queues `sygilant-evidence-scans`, `sygilant-evidence-scans-dlq`,
  `sygshift-document-scans`, and `sygshift-document-scans-dlq`.
- Container `sygshift-document-scanner`.
- Worker secret `SYGSHIFT_DOCUMENT_SCANNER_SECRET`.
- The obsolete Pages service binding in both Sygilant preview and production.

The current Pages deployment `0b65ad03-47a4-4d23-8bb8-ef1a7290da26` and its
clean rollback checkpoint `61c63941-600e-4559-b20f-3b41ec315f75` have no
scanner binding. Older inactive Pages snapshots may retain historical binding
metadata, but the scanner Worker itself is deleted and cannot run.

## Verification

- SygShift: strict type check, zero-warning lint, production build, and the
  full `344`-file / `1,837`-test suite passed.
- Sygilant: hardening checks, type/lint/build checks, and the full `240`-file /
  `1,208`-test suite passed.
- Both SygShift production origins returned `200` from readiness. Sygilant's
  custom domain and immutable Pages deployment returned `200` from health.
- The retired SygSphere upload-status and retry URLs now return `404` before
  authentication; new uploads use one protected upload and one immediate
  completion check.
- Final Cloudflare inventory shows no scanner queues, containers, Worker, or
  scanner secret. The active Pages project and deployment expose only the
  required email and report-image bindings.

## Release references and future correction

- Current SygShift Worker version:
  `0d48131e-c4e0-4f8a-93c2-54cac0d5a628`.
- Rollback checkpoint before this release:
  `rollback/pre-document-immediate-availability-20260930`, targeting
  `48a0400`.
- Production origins:
  - `https://app.sygilant.us`
  - `https://sygshift.sygilant.workers.dev`
  - `https://sygilant.us`

Do not roll an application back to a scanner-era release: the scanner services
have deliberately been removed. Any later change must be a forward corrective
release that preserves private storage and the documented integrity boundary.
