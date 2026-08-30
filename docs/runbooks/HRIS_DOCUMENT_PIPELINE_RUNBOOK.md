# HRIS Secure Document Pipeline Runbook

## Current production state

The secure HR document pipeline is installed but dormant. It is not an employee-facing feature in this run.

- `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED` is absent or false in the Worker environment.
- `private.hr_document_release_gate.enabled` is false in the database.
- No production role or employee receives a new document permission from this run.
- No browser receives direct access to a storage bucket or object URL.
- No scanner secret is required while the pipeline remains disabled.

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

An accepted file is written only to its private quarantine vault. It is unavailable for preview or download until a scanner records a clean result. A rejected or infected file never becomes the current document version.

Document access requires a fresh permission check and recent MFA. The service issues a hashed, one-time access token that expires after 60 seconds. Consumption rechecks the database release gate, current document version, current employee permission, and clean scan state. Preview and download are recorded in the append-only document access history.

## Required evidence before a later activation

Do not enable the pipeline until all of the following exist:

1. A production malware-scanning service that can read quarantine objects through a server-only identity and return an authenticated callback.
2. A stored scanner callback secret that is not present in source control or browser code.
3. A successful isolated restore drill for document metadata, version history, scan evidence, access history, and private objects.
4. A canary employee or role with the minimum explicit vault permissions required for the test.
5. Passing upload, rejection, infected-file, clean-file, preview, download, expiration, replay, stale-MFA, revoked-permission, and rollback tests.
6. A recorded approval identifying who authorized activation and the evidence package used.

## Controlled activation order

1. Confirm the application is healthy and no maintenance restriction is unexpectedly active.
2. Configure and verify the scanner service.
3. Store `SYGSHIFT_DOCUMENT_SCANNER_SECRET` through the platform secret manager.
4. Assign only the canary document permissions approved for the release test.
5. Enable `private.hr_document_release_gate` with the authorizing employee and evidence reference recorded.
6. Set `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED=true` and deploy.
7. Upload a safe canary document and verify quarantine, clean scan, immutable version creation, one-time access, audit history, expiration, and replay denial.
8. Verify a rejected active-content file and a simulated infected result remain unavailable.
9. Verify a permission removal invalidates an already-issued but unused grant.
10. Expand permission assignments only after the canary evidence is reviewed.

## Operational checks

- An upload may be `initiated`, `stored`, `scan_pending`, `released`, `rejected`, or `failed`.
- Only clean scan evidence may move an upload to `released`.
- A scanner callback may finish an upload that was already in flight when the feature was disabled. This permits safe cleanup without allowing new uploads or access.
- Document access links are intentionally non-reusable and should return an invalid-or-expired response after their first successful use.
- Never copy object keys, access tokens, scanner secrets, or document contents into logs or support tickets.

## Verification commands

Run these from the repository root before any document release:

```text
pnpm check:hris-documents
pnpm check:hris-document-pipeline
pnpm check
```

The release is not complete merely because the commands pass. The production scanner, private-object restore drill, canary access, audit evidence, and rollback test are also mandatory.
