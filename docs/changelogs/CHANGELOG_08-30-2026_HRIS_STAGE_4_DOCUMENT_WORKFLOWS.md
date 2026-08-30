# SygShift Change Log — HRIS Stage 4 Document Workflows

**Date:** 08/30/2026  
**Program:** Enterprise HRIS/HCM  
**Stage:** Stage 4, Run 4 of 4  
**Production state:** Secure Document Platform structurally complete and deployed dormant; no current user access or employee document assignment changed

## Outcome

Completed the final Secure Document Platform run by adding controlled requests, exact-version assignments, acknowledgments, signatures, and append-only lifecycle evidence. The release preserves the existing private-vault, immutable-version, quarantine, malware-scan, and short-lived-access design. It does not activate the document system, assign permissions, or expose a new navigation item to current users.

## Manager document workflow

- Added a separately authorized HR document workflow workspace for requests and assignments.
- Added service-only creation and review of document requests with an append-only event history.
- Added exact-version employee assignments that cannot silently move to a newer document version.
- Added controlled assignment cancellation without deleting the original assignment or its history.
- Kept document inventory, request management, and assignment management as separate focused workflows.
- Limited list pages to 5, 10, or 20 records, with 10 as the default, so the workspace does not become an unbounded scrolling page.

## Employee document workflow

- Added a separate My Documents workspace that returns only assignments belonging to the signed-in employee.
- Added protected preview and download for the exact immutable document version assigned to that employee.
- Required recent authenticator or security-key verification, an active account, an active assignment, a clean scan result, and the closed release controls to pass before access can be issued.
- Added acknowledgment with explicit confirmation and an immutable completion record.
- Added signature with the employee's legal name, explicit confirmation, and immutable completion evidence.
- Kept source documents and versions unchanged; acknowledgment and signature evidence is stored independently.

## Database and audit controls

- Added private request, request-event, assignment, assignment-event, and completion-evidence structures.
- Made request events, assignment events, and completion evidence append-only.
- Extended one-time access grants with an authorization source and optional assignment reference while preserving immutability.
- Added service-only manager and employee workspace contracts with server-side pagination and status filtering.
- Added service-only request, review, assignment, cancellation, employee access, and completion operations.
- Revoked execution from public, anonymous, and authenticated database roles; only the service role may call the workflow functions.
- Preserved employee, role, permission, role-assignment, and individual-override counts transactionally during migration.

## Authorization boundaries

- Manager workflow operations require the effective `hr.documents.manage` permission and a recent MFA session.
- Employee document access is self-only and does not rely on a general manager document permission.
- Employee access is limited to the exact assigned version and cannot enumerate another employee's assignments.
- Preview, download, acknowledgment, and signature all revalidate assignment, version, employee, account, scan, and release state at execution time.
- No browser client receives direct storage permissions or a permanent bucket URL.

## Dormant release safeguards

- Database document release gate remains disabled.
- Worker feature switch `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED` remains disabled by omission.
- Scanner callback secret remains unconfigured.
- No document permission was assigned to any role or employee.
- No employee document assignment or completion was created by this release.
- HR document navigation remains hidden under the existing disabled feature gate.
- Live manager and employee workflow probes return `503 Service Unavailable` with `hr_document_pipeline_unavailable`.

## Production verification

- Implementation commit: `2ef6dd3` (`Complete dormant HR document workflows`).
- Cloudflare Worker version: `a2f3c1b9-64de-404e-a5b9-359dd092afe0`.
- Primary application health: `200 OK` at `https://app.sygilant.us/api/v1/health`.
- Primary application readiness: `200 OK` at `https://app.sygilant.us/api/v1/ready`.
- Manager workflow boundary: expected closed-gate `503` response.
- Employee workflow boundary: expected closed-gate `503` response.
- Supabase migration ledger: `20260830200000` recorded as applied.
- Post-apply migration dry run: production database fully up to date with no pending migrations.
- Optional remote database lint could not establish a connection before timeout after migration; the migration itself applied transactionally, reconciled in the remote ledger, and passed its embedded preservation assertions.

## Quality gates

- All ten HRIS architecture and security validators passed.
- Focused Stage 4 workflow guard suite passed: **5 tests**.
- Full application suite passed: **112 test files / 562 tests**.
- Type checking passed.
- Linting passed with zero warnings.
- Worker production build passed.
- Client production build passed.
- Git whitespace validation passed.
- Implementation diff contained no generated-author or assistant-attribution markers.

## Activation remains separate

Stage 4 is complete as a secure, dormant platform. It must not be activated casually. A later controlled activation must configure and validate the scanner callback, prove quarantine and recovery behavior, assign the minimum required permissions, create a small exact-version canary assignment, test recent-MFA browser behavior, verify audit evidence, and demonstrate rollback before broader use.

No Stage 5 workflow was included in this release.
