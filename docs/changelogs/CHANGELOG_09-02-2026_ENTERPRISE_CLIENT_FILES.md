# Enterprise Client Files

Date: 09/02/2026

## Outcome

SygShift now has a controlled Client Files workspace that makes each client the stable root for its identity, contacts, sites, posts, service history, documents, and future portal delivery. Existing Schedule, Sites & Posts, Patrol, Events, employee, Time & Attendance, and Payroll records remain authoritative and were not copied or rewritten.

## Client workspace

- Added permission-aware `/clients` and `/clients/:clientId` routes under Workforce.
- Added complete client identity, service status, lifecycle dates, renewal, billing channels, address, time zone, ownership reference, and internal notes.
- Added editable contacts with primary, emergency, billing, operations, legal, executive, and other classifications.
- Linked existing Sites and Posts to a client by identifier. Site address, time zone, coordinates, and optional geofence radius remain editable in the authoritative Site record.
- Assembled Schedule shifts, Patrol hits, Events, incidents, and service records into one Client Activity history and audited CSV export.
- Added the Client Portfolio & Activity entry to Reports.
- Kept directories and worklists bounded to 5, 10, or 20 rows by default, with explicit expansion or paging for contacts, sites, documents, activity, and staged imports.

## Documents and future portal readiness

- Added a private client-document vault for proposals, contracts, amendments, pricing, post orders, insurance, correspondence, reports, images, and related records.
- Added protected upload, browser preview, and download with file-signature validation, MIME and size limits, recent authenticator/security-key verification, business-reason capture, object authorization, and audit history.
- Gave contracts and pricing a separate restricted permission from ordinary client-document access.
- Added independent internal/share-eligible/approval/published/withdrawn states without creating any client login or publishing content.

## Source reconciliation

- Staged 261 nonblank rows from the supplied `Sales sheet.xlsx` in a private, checksum-identified review batch.
- Preserved the source tab, row number, and original populated fields.
- Created no operational client automatically. Authorized reviewers must deliberately match, create and match, or exclude source rows from the 10-row review queue.
- Excluded the workbook's internal staff-information tab from client staging.

## Security and preservation

- Added ten exact Client Files permissions and role-appropriate grants; Admin receives all ten.
- Revoked direct browser access to client tables and the private storage bucket. Sensitive document content is served only through protected same-origin Worker routes.
- Added automatic Client relationship propagation for Site-linked Patrol stops, Patrol hits, and Events.
- Added audit records for client saves, Site links/location updates, service records, document upload/access, exports, and source-row resolution.
- Added database preservation assertions for employees, Sites, Posts, shifts, assignments, time events, access-role assignments, individual permission overrides, Patrol routes, and Patrol hits.

## Verification

- All three database migrations completed rollback rehearsals before production application.
- Production verified zero automatically created Client Files, one private source batch, 261 pending source rows, one private document bucket, ten permissions, ten public workflow functions, and all ten Admin grants.
- A rollback-only MFA-authenticated Admin test completed workspace read, source pagination, client creation, contact creation, service-record creation, Client File assembly, and activity export.
- `pnpm check` passed: type checking, zero-warning lint, 149 test files / 722 tests, and Worker/client production builds.
- All 72 full desktop/mobile Playwright checks passed. Eight focused Client Files light/dark desktop/mobile checks passed with no accessibility violation or horizontal overflow.
- Deployed Cloudflare Worker version `82e0fe7d-c0e7-4fb0-8ccb-b9d09776cd5d`.

## Rollback

This is a forward-only additive release. Application rollback may deploy the preceding Worker/Git revision while preserving Client File tables, staged source evidence, document metadata, and audit history. Any database correction must use a new forward migration. The staged workbook rows can remain safely dormant because they do not affect operational data until an authorized reviewer resolves them.
