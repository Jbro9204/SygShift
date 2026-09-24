# Existing Licensing Center Major Update

Date: 09/24/2026
Status: Released to production

## Outcome

The existing SygShift Licensing Center now supports a complete employee-to-
Licensing workflow without creating a separate system. Every authenticated
employee can view their own verified credentials, submit new credentials,
renewals, corrections, or proof that a renewal is in progress, attach multiple
protected files, and follow the review decision. Authorized Licensing staff
retain the established team worklist and employee-profile tools, with a new
review queue in the same workspace.

## Employee experience

- Added **My Licenses & Credentials** to the existing Licensing Center.
- Shows the employee's current verified records, expiration state, attention
  items, pending submissions, correction requests, and decision history.
- Supports new credentials, renewals or replacements, corrections, and
  renewal-in-progress evidence.
- Supports multiple PDF, PNG, JPEG, and WebP files with progress, retry,
  removal, protected preview, and protected download.
- Preserves drafts and lets the employee withdraw an eligible request.
- Provides clear correction and rejection reasons with notification deep links
  that reopen the exact submission.
- Uses responsive, rounded, consistent SygShift controls and layouts for phones,
  small laptops, high zoom, light mode, and dark mode.

## Licensing and management experience

- Preserved the complete existing Licensing Center, employee worklist,
  credential profiles, onboarding-profile action, eligibility logic, filters,
  documents, removal and restoration history, and reporting behavior.
- Added a paginated, searchable submission-review queue with Awaiting review,
  Correction requested, Approved, and Rejected views.
- Reviewers can inspect every protected supporting document and approve,
  request a correction, or reject with a recorded reason.
- Approval updates the canonical employee credential rather than creating a
  competing record. Prior verified values remain in immutable credential-version
  history.
- Approval of renewal-in-progress evidence does not extend the license dates;
  it records that the employee is awaiting the issuing authority.

## Security and data integrity

- Added forced-row-level-security submission, submission-event, and credential-
  version tables while revoking direct browser table access.
- Employee RPCs resolve the signed-in employee at the database boundary and
  enforce ownership on every read and mutation.
- Management review requires the established Licensing permission and recent
  MFA. Service upload preparation remains service-role-only.
- Protected documents stay in the existing private storage, scan, checksum,
  preview, download, audit, and access-recording pipeline.
- Notifications are permission-scoped to authorized Licensing reviewers and
  the affected employee.
- Existing credential records, documents, eligibility calculations, employee
  data, schedules, timekeeping, payroll, HR workflows, and permissions were
  preserved.

## Production database verification

- Applied and recorded migration
  `20260924213024_employee_licensing_center_self_service.sql`.
- A rollback-only production regression exercised employee ownership, draft,
  upload preparation, submit, correction, resubmit, approval, immutable version
  history, notification routing, service-role boundaries, and fixture cleanup.
- The regression passed and left zero licensing-submission fixture rows.
- Exact post-migration checks confirmed forced RLS on all three new tables,
  no direct authenticated table access, no anonymous employee-RPC access, no
  browser access to the service upload RPC, and service-role upload access.
- Database performance advisors reported no new Licensing objects. Security
  advisor notices for the six signed-in RPCs are intentional: those functions
  are the public API and each performs its own employee, ownership, permission,
  and MFA checks.

## Verification

- Full `pnpm check` passed: 307 test files / 1,622 tests, strict TypeScript,
  zero-warning application/Worker lint, production builds, and static-asset
  validation.
- Mandatory actual-component Time Clock preservation matrix passed 42/42 across
  desktop and mobile.
- Focused access-policy, least-privilege, employee self-service, Worker upload,
  and database rollback tests passed.
- Both production origins returned HTTP 200 for health, readiness, and the
  Licensing route.
- The live application, stylesheet, shared runtime assets, and Licensing Center
  chunk were byte-identical to the verified production build.
- Authenticated production verification loaded the existing team Licensing
  Center, the new review queue, My Licenses & Credentials, and the complete
  submission dialog without creating or changing a credential.

## Release references

- Source commit: `00f6c592ff0ef3b4bde395acb1f4ef470480c9a0`
- Cloudflare Worker version: `789b03a0-3619-4ce7-9d00-d5e1e62d2fbe`
- Database migration: `20260924213024`
- Rollback tag: `rollback/pre-employee-licensing-center-major-update-20260924`
- Verified application asset: `/assets/index-BhF8J0KG.js`
  (`B94BE0155657E0DC879A15D4F3446B35861222C891672BFB39A83E01336193DE`)
- Verified stylesheet: `/assets/index-VKZYXlD9.css`
  (`94FFE5C2AE5DA0F8EFB1157D42BB2205F879CEA3F7CC4C8CFEC29CC3E42550AE`)
- Verified Licensing Center asset: `/assets/LicensingCenterPage-Brirj9dx.js`
  (`DBA1BDB61A3CE992F500A312607F6F93E43E42AFD7039A925A2A6B9F08AEA363`)

## Operator note

This release expands the existing Licensing Center. It does not introduce a
second Licensing system or migrate employees away from the existing credential
records. Employees can begin using **Licensing Center > My Licenses &
Credentials** immediately; authorized Licensing staff review those submissions
from **Team Licensing Center**.
