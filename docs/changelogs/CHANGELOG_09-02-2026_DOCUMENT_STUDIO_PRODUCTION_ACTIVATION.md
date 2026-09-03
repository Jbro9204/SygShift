# Document Studio Production Activation

## Outcome

SygShift's protected Document Studio is being moved from an installed, fail-closed workspace to an operational core document system. Upload, quarantine, malware scanning, browser preview, controlled download, policies, templates, internal employee signature envelopes, final signed PDFs, audit certificates, and processing state use the existing canonical employee, permission, MFA, audit, and private-storage controls.

This release does not pretend unfinished capabilities are operational. OCR, native PDF content editing, irreversible redaction, page restructuring, regulated-document automation, external signers, and organizational seals remain disabled behind their existing database gates.

## Security and reliability controls

- Added a dedicated Cloudflare Queue with one-file batches, bounded concurrency, five retries, and a dead-letter queue.
- Added an isolated Cloudflare Container using the exact `clamav/clamav:1.5.4` image tag, the ClamAV-recommended 4 GiB container class, no SSH, no outbound internet, one maximum instance, and a 360-second cold-start-plus-scan kill boundary.
- A document remains private and quarantined until its stored size and SHA-256 checksum match the immutable upload record and ClamAV returns clean.
- Malware or integrity failures are recorded through the existing append-only scan ledger; rejected stored objects are deleted. Operational scan failures remain quarantined and retry safely.
- Added append-only release evidence for clean-file detection, known-malware rejection, and private-storage recovery. The activation migration refuses to unlock the workspace unless all three checks passed in one current canary run.
- Existing short-lived, hashed, single-use access grants, recent authenticator/FIDO verification, effective vault permissions, and access-event logging remain unchanged.

## User experience

- HR can upload a document to an employee file or to a company/shared record without inventing an employee owner.
- Pending scan rows refresh automatically until security review completes.
- Clean PDF, image, text, Word, and Excel files can be opened in the browser. Office previews are generated as escaped, script-free text under a sandboxed content-security policy; the exact original remains available for authorized download.
- The workspace banner now reports **Protected workspace operational** only when both Worker and database release controls agree.
- A standard internal employee electronic-signature policy is installed so internal envelope creation is usable immediately after clean PDF ingestion.

## Data and access preservation

- Migrations are additive and forward-only.
- No employee, account, role assignment, permission override, schedule, timekeeping, payroll, licensing, client, patrol, or existing HR record is rewritten.
- Existing role-based document permissions remain the source of authority; activation does not grant new vault permissions.
- All Supabase document buckets remain private.

## Validation

- TypeScript build passed.
- Lint passed with zero warnings.
- Vitest passed: 155 files / 750 tests.
- Production client and Worker builds passed.
- Wrangler dry-run recognized the Durable Object, queue producer/consumer, and ClamAV container configuration.
- Targeted release-guard tests verify queue dispatch, dead-letter configuration, pinned scanner image, fail-closed evidence requirements, company/shared records, pending-scan polling, and Office preview support.
- Document Studio responsive layout and signature execution passed eight desktop/mobile light/dark Playwright checks.
- Anonymous requests to the live Document Studio and document workspace endpoints returned the required HTTP 401 response.

## Deployment record

- Migration `20260903001850_document_pipeline_scanner_release_evidence.sql`: applied and reconciled in production.
- Scanner/recovery canary `361b9d1e-b63a-41f7-bf21-2319ddd5837a`: passed clean-file detection, EICAR rejection, and private-storage recovery using `ClamAV 1.5.4/28108`.
- Post-deployment lifecycle canary `69fdc03a-2e27-43b9-a9de-a5b0a23d0063`: passed the same three controls after the protocol-safe scanner startup was attached to the 30-minute container sleep lifecycle.
- Migration `20260903001851_document_studio_controlled_activation.sql`: applied and reconciled in production after the canary passed.
- Production gates enabled: HR document pipeline, Document Studio workspace, processing, and internal signatures.
- Intentionally closed gates: advanced editing, regulated-document automation, external signers, and organizational seals; no UI claims those unfinished capabilities are available.
- Current Cloudflare version: `933343fe-3975-485c-bf3e-94c50aec835f` (code deployment `d6f02dd6-f624-49a1-b683-15f8b203caef` plus final scanner-secret version).
- Primary and fallback health/readiness endpoints returned HTTP 200 and ready after activation.

## Rollback

New uploads can be stopped immediately by setting `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED=false` and applying a new forward migration that closes the core release gates. Existing clean documents and immutable audit evidence are not deleted by rollback. Queued/in-flight scan records remain quarantined and auditable; database history is never rewritten.
