# SygShift Change Log — HRIS Stage 4 Document Workspace

**Date:** 08/30/2026  
**Program:** Enterprise HRIS/HCM  
**Stage:** Stage 4, Run 3 of 4  
**Production state:** Secure HR document workspace deployed dormant; document access remains unavailable until a separate controlled activation

## Outcome

Completed the permission-aware HR Documents workspace on top of the dormant secure document pipeline. The release adds the full browser experience, protected API boundary, and service-only database workspace contract without exposing documents to employees or administrators. Existing employee, account, schedule, payroll, timekeeping, role, and permission assignments were preserved.

## Compact document workspace

- Added the protected `/hr/documents` workspace and HR & Finance navigation entry.
- Kept the route and navigation hidden unless the signed-in person has an effective HR document permission.
- Added a compact document inventory with legal employee names, vault and status filters, search, and archived-record controls.
- Limited list pages to 5, 10, or 20 records, with 10 as the default.
- Added expandable document rows so file, version, scan, vault, and employee details remain available without creating an unbounded scrolling page.
- Added clear empty, loading, unavailable, and retry states.

## Upload and recovery workflow

- Added a focused upload modal with drag-and-drop and standard file selection.
- Restricted employee choices to active, onboarding, or leave records shown by legal name.
- Restricted vault choices to vaults the current person can manage.
- Added title, category, and description fields without crowding the inventory.
- Added upload progress, retry-safe failure handling, and a stable idempotency key so a retry cannot create a duplicate upload operation.
- Kept every upload inside the quarantine and malware-scan pipeline created in Stage 4 Run 2.

## Protected preview and download

- Added audited preview and download actions that require a business reason.
- Required recent MFA and a valid effective document permission before the server issues access.
- Used single-use, short-lived access grants; no storage bucket URL or permanent public link is exposed.
- Allowed in-browser preview only for PDF, PNG, JPEG, and text files.
- Required DOCX, XLSX, and other non-preview formats to use the protected download workflow.
- Rechecked the active employee account, vault permission, release gate, clean scan state, and current document version when access is consumed.

## Database and API controls

- Added service-only `service_get_hr_document_workspace(...)` for authorized, paginated workspace data.
- Enforced employee status, effective permission, vault scope, search, archive status, and pagination in the database contract.
- Added the protected Worker workspace endpoint and kept all document API routes behind the Worker feature switch.
- Revoked workspace RPC execution from public, anonymous, and authenticated database roles; only the service role may call it.
- Preserved legal-name boundaries throughout the document workspace.

## Dormant release safeguards

- Worker feature switch `SYGSHIFT_DOCUMENT_PIPELINE_ENABLED` remains disabled by omission.
- Database document release gate remains disabled.
- Scanner callback secret remains unconfigured.
- No document permissions were assigned to roles or individual employees.
- The production upload boundary returns `503 Service Unavailable` with `hr_document_pipeline_unavailable`.
- The workspace therefore cannot appear to unauthorized users or accept a file during this release.

## Production verification

- Release commit: `fec35af` (`Build gated HR document workspace`).
- Cloudflare Worker version: `8dff9390-9372-4770-8ec7-624a466c9bdc`.
- Primary application health: `200 OK` at `https://app.sygilant.us/api/v1/health`.
- Primary application readiness: `200 OK` at `https://app.sygilant.us/api/v1/ready`.
- Dormant upload-boundary probe: `503 Service Unavailable` with `hr_document_pipeline_unavailable`.
- Supabase migration ledger: `20260830170000` recorded as applied.
- A post-apply migration dry run reported the production database fully up to date.
- The migration's preservation checks completed successfully and changed no employee or access-assignment counts.

## Quality gates

- Stage 4 document-workspace validator passed.
- Focused Stage 4 workspace guard suite passed: **6 tests**.
- Full application suite passed: **111 test files / 557 tests**.
- Type checking passed.
- Linting passed.
- Worker production build passed.
- Client production build passed.
- Git whitespace validation passed.

## Deliberately deferred

Stage 4 Run 4 will address document requests, acknowledgments, signatures, and their lifecycle controls. Production activation of upload, preview, and download will remain a separate controlled canary after scanner configuration, permission assignment, recent-MFA browser testing, quarantine/recovery drills, and rollback verification.
