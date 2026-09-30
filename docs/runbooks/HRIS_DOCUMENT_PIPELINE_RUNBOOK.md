# HRIS Document Pipeline Runbook

## Immediate-availability model

An accepted document becomes usable as soon as the Worker has completed all of the existing server-side validation, written it to private storage, and verified the expected SHA-256 checksum. There is no malware scanner, quarantine queue, scanner callback, or background processing state in the active document workflow.

- No browser receives direct access to a storage bucket or object URL.
- Access remains permission-scoped, MFA-protected where required, time-limited, single-use, and audited.
- A protected-storage or checksum mismatch leaves the document unavailable and returns a retryable storage error; it never creates an accessible file.

## Security boundary

The pipeline accepts only server-authenticated requests. Uploads require an active account, an explicit vault permission, and recent authenticator or security-key MFA no older than 15 minutes. A trusted-device record alone is not sufficient.

Every upload is checked for:

- a 25 MB maximum size;
- an allowed extension;
- an allowed declared MIME type;
- a matching content signature;
- PDF active actions or embedded files;
- Office macros, embedded objects, or external relationships; and
- a SHA-256 checksum.

An accepted file is written only to its private vault. It is available for preview or download immediately after protected-storage and checksum verification. A file that fails validation, storage, or integrity verification never becomes an accessible current document version.

The Worker reads the saved object back and verifies its byte count and SHA-256 digest before it requests availability. The database independently verifies the exact private bucket, object key, stored size, and MIME type before it records the available state. Generated signed PDFs and audit certificates use the same two-layer verification.

Document access requires a fresh permission check and recent MFA. The service issues a hashed, one-time access token that expires after 60 seconds. Consumption rechecks the database release gate, current document version, current employee permission, and verified availability. Preview and download are recorded in the append-only document access history.

## Required evidence before a release

Do not enable the pipeline until all of the following exist:

1. A successful isolated restore drill for document metadata, version history, access history, and private objects.
2. A canary employee or role with the minimum explicit vault permissions required for the test.
3. Passing upload, validation rejection, protected-storage failure, checksum mismatch, preview, download, expiration, replay, stale-MFA, revoked-permission, and rollback tests.
4. A recorded approval identifying who authorized the release and the evidence package used.

## Controlled activation order

1. Confirm the application is healthy and no maintenance restriction is unexpectedly active.
2. Assign only the canary document permissions approved for the release test.
3. Enable `private.hr_document_release_gate` with the authorizing employee and evidence reference recorded.
4. Set `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED=true` and deploy.
5. Upload a safe canary document and verify private storage, checksum integrity, immediate availability, immutable version creation, one-time access, audit history, expiration, and replay denial.
6. Verify an active-content file and a simulated storage or checksum failure remain unavailable.
7. Verify a permission removal invalidates an already-issued but unused grant.
8. Expand permission assignments only after the canary evidence is reviewed.

## Operational checks

- An upload moves from accepted to available only after protected storage and checksum verification complete.
- There is no scanner queue, scanner callback, or pending scan state to operate or recover.
- Existing historical scan evidence remains audit history only and does not gate current availability.
- At cutover, the scheduled Worker safely recovers only pre-existing nonterminal uploads whose immutable version, private object key, size, and checksum still match. Missing, mismatched, rejected, and cancelled records are never released by recovery.
- Document access links are intentionally non-reusable and should return an invalid-or-expired response after their first successful use.
- Never copy object keys, access tokens, or document contents into logs or support tickets.

## Verification commands

Run these from the repository root before any document release:

```text
pnpm check:hris-documents
pnpm check:hris-document-pipeline
pnpm check
```

The release is not complete merely because the commands pass. Protected-object restore, canary access, checksum verification, audit evidence, and rollback testing are also mandatory.
