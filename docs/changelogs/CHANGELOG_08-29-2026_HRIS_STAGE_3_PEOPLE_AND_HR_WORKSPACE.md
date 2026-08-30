# SygShift Change Log — HRIS Stage 3 People & HR Workspace

**Date:** 08/29/2026

**Program:** Enterprise HRIS/HCM

**Stage:** Stage 3 — People & HR Workspace

**Production migration:** `20260830023000_hris_stage3_people_workspace.sql`

**Prerequisite migration ledger reconciliation:** `20260830013000_hris_stage2_identity_readiness_workspace.sql`

**Cloudflare production version:** `b2fc09e6-6022-4677-a5fc-ab27bad85098`

## Outcome

Authorized HR users now have a compact, production People & HR workspace built on SygShift's existing employee identity. The release provides an HR overview, a bounded People worklist, private saved views, and a read-only Employee File without creating a second employee editor or changing any employee's role, access, schedule, time, payroll, licensing, or account record.

The existing Directory remains the operational Directory workflow. Schedule, Time & Attendance, Licensing Center, User Accounts, Roles & Permissions, and Payroll remain authoritative for their existing domains.

## Delivered

- Added the protected `/hr` overview with bounded summary cards and a five-item priority queue for authorized managers.
- Added `/hr/people` with server-side legal-name search, status, employment, role, sort, and pagination controls.
- Defaulted the People list to active employees, 15 rows per page, with a hard maximum of 25 rows.
- Added private employee-owned saved views that cannot be read, changed, or deleted by another user.
- Added `/hr/people/:employeeId` as a read-only authoritative Employee File.
- Required current MFA plus `hr.people.view` or `hr.people.manage` for HR People access.
- Required the separate `hr.people.restricted` permission before personal email or mobile phone data can be returned.
- Kept legal names in the HR workspace and excluded preferred-name substitution.
- Filtered Employee File workspace links through the current user's actual route permissions so inaccessible destinations are not shown.
- Preserved the existing Directory as the only operational Directory editing workflow.
- Added compact responsive layouts, clear empty states, bounded controls, and no uncontrolled long-scroll employee list.

## Database and security

- Added private `hr_people_saved_views` storage with row ownership and no direct browser-table access.
- Added authenticated RPCs for People search, Employee File retrieval, saved-view creation, and saved-view deletion.
- Enforced employee identity, active status, MFA, module permissions, restricted-field permissions, page-size limits, filter allowlists, and saved-view ownership in the database.
- Returned only the fields required by each authorized view.
- Preserved the closed Stage 2 identity-backfill gate; Stage 3 performed no protected identity backfill.
- Reconciled only the missing Stage 2 readiness migration ledger marker after confirming the exact production function already existed. No broad migration repair or historical rewrite was performed.

## Production verification

- The Stage 3 migration completed successfully in the linked production database.
- The production migration ledger now records both the Stage 2 readiness prerequisite and Stage 3 People workspace migration.
- The Cloudflare Worker deployment completed successfully with Worker version `b2fc09e6-6022-4677-a5fc-ab27bad85098`.
- `https://app.sygilant.us` returned the expected secure SygShift sign-in route in a clean production browser.
- Signed-in authorization, restricted-field, saved-view ownership, and route-link behavior were validated by the automated access tests; no credentials or browser session were bypassed for live verification.

## Validation

- `pnpm check:hris-people`
- Focused Stage 3 guard suite: 6 tests
- Full Vitest suite: 108 files / 540 tests
- `pnpm typecheck`
- Zero-warning `pnpm lint`
- `pnpm build`
- Cloudflare Worker dry run
- Production database migration
- Production Worker deployment
- Clean-browser production route verification

## Preservation and rollback

The release is additive. Existing production employee identities, roles, individual permission overrides, schedules, time records, payroll records, licensing records, account access, and operational history were not changed. Saved HR views can be removed independently without changing employee data. If a later correction is required, use a forward migration and preserve the applied migration and audit history; do not edit an applied production migration.
