# SygShift Change Log — HRIS Stage 4 Secure Document Pipeline

**Date:** 08/30/2026  
**Program:** Enterprise HRIS/HCM  
**Stage:** Stage 4, Run 2 of 3–4  
**Production state:** Dormant quarantine and one-time access pipeline deployed; employee document upload, preview, and download remain unavailable

## Outcome

Installed the protected server pipeline that future HR document workflows will use for file validation, quarantine, malware-scan evidence, recent-MFA verification, and one-time access. The release remains deliberately dormant. No employee received document access, no document was uploaded, and no existing employee, account, role, permission, or operational record was changed.

## Upload and quarantine controls

- Enforced a 25 MB server-side file-size limit.
- Required exact agreement between the filename extension, declared MIME type, and detected file signature.
- Added content validation for PDF, PNG, JPEG, WEBP, text, DOCX, and XLSX files.
- Rejected PDF scripts, launch actions, embedded files, and automatic open actions.
- Rejected Office macros, embedded packages, and external relationships.
- Added quarantine-only storage with immutable upload-operation evidence and explicit state transitions.
- Added an authenticated scanner callback boundary with clean, rejected, and error outcomes recorded in append-only evidence.
- Preserved in-flight scanner completion during a rollback while preventing new uploads whenever the release is disabled.

## Recent MFA and one-time delivery controls

- Required a recent authenticator MFA session no older than 15 minutes for protected document access.
- Added equivalent recent security-key verification for a future hardware-key workflow.
- Explicitly rejected remembered/trusted-device status as sufficient recent MFA.
- Added permission-scoped access grants for preview, view, or download.
- Hashed every access token, limited it to 60 seconds, and allowed it to be consumed only once.
- Rechecked the current document version, clean scan state, active account, effective vault permission, and release gate at consumption time.
- Returned private, non-cacheable document responses; no permanent or public document URL is created.

## Release and recovery controls

- Added a machine-enforced pipeline contract validator.
- Added operating and rollback runbooks for upload, scan, release, disablement, incident response, and evidence review.
- Kept the Worker feature switch unconfigured and the database release gate disabled.
- Kept all twelve document permissions unassigned to roles and people.
- Added no employee-facing document routes or controls.

## Production verification

- Supabase migration ledger: `20260830120000` recorded as applied.
- Existing employees: **78**.
- Existing employee accounts: **68**.
- Document records: **0**.
- Document versions: **0**.
- Upload operations: **0**.
- One-time access grants: **0**.
- Document access events: **0**.
- Document permissions assigned to roles: **0**.
- Document permissions granted directly to people: **0**.
- Database document release gate: **Disabled**.
- Worker document-pipeline feature switch: **Disabled by omission**.

## Quality gates

- Stage 4 document-pipeline validator passed.
- Stage 4 foundation validator passed.
- Focused pipeline guard suite passed: **5 tests**.
- Full application suite passed: **110 test files / 551 tests**.
- Type checking passed.
- Linting passed.
- Worker production build passed.
- Client production build passed.

## Deliberately deferred

This release does not allow employees or administrators to upload, preview, or download HR documents. Stage 4 still requires:

- a compact, permission-aware browser workspace for upload, progress, recovery, preview, and download;
- production malware-scanner integration and an operational quarantine/recovery drill;
- browser-level authorization and recent-MFA tests for every vault and document action;
- explicit document-permission assignment through the approved role and employee access workflows;
- controlled canary activation with rollback evidence;
- document requests, acknowledgments, signatures, and retention operations.

These controls must pass before either release switch is enabled.
