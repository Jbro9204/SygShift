# SygShift Change Log — Reports Workspace Redesign

**Date:** 08/28/2026
**Status:** Released to production
**Production URL:** https://app.sygilant.us
**Cloudflare version:** `60587ba8-6ec9-44f9-94bb-6f5993869256`
**Implementation commit:** `443deed`

## Outcome

Reports is now a compact operational report library instead of a long page of mixed summaries. Authorized users can choose one of eight clearly defined reports, open a focused workspace, apply a shared date range and report-specific filters, review a bounded page of results, inspect one record at a time, and move to the correct operational workflow when action is required.

## Report library

The library contains exactly these eight reports:

1. Timekeeping Exceptions
2. Automatic Clock-Outs
3. Manual Time Entry Audit
4. Time-Adjustment Requests
5. Attendance & Call-Offs
6. Scheduled vs Actual
7. Coverage & Unfilled
8. Overtime & Payroll Risk

The main Reports page now provides:

- One shared **From** and **Through** date range that follows the user into report workspaces.
- Four concise operational metrics: published weeks, assigned slots, review needed, and active employees.
- Compact employee, Site/Post, action-queue, and timekeeping posture summaries.
- A maximum of five priority attention records.
- One consistent report card for each supported report, without loading every detail row into the library.
- A direct handoff to the dedicated Payroll workspace rather than duplicating payroll inside Reports.

## Focused report workspaces

- Added a dedicated URL for every report at `/reports/:reportKey`.
- Added clear Back navigation, title and description, shared dates, search, report-specific filters, active/archive views, sorting, and 10/25/50-row page sizes.
- Added server-backed pagination capped at 50 records per request.
- Added stable sorting and total counts so browser rendering remains bounded even when production history grows.
- Added on-demand record detail in a focused modal instead of expanding every row.
- Added clear loading, empty, error, and unknown-report states.
- Added links to the canonical correction, review, scheduling, accountability, and payroll workflows. Reports remain read-only.
- Added responsive layouts for desktop, tablet, and phone without shrinking normal reading text.

## Data and security controls

- Added `private.report_legal_employee_name(...)` so employee and reviewer identities use legal names in administrative reports.
- Added `public.get_timekeeping_operations_report_page(...)` as the bounded server contract for report records.
- The server validates report type, date range, scope, page, page size, search, filter, and sort inputs.
- Requests require the existing `time.reports.view` permission at the route, navigation, client data call, and database-function boundary.
- Existing role assignments, employee role memberships, grants, and denials were not changed.
- The previous aggregate report function remains available for existing internal consumers; the browser no longer receives an unbounded operational report collection.
- Applied targeted production migration `20260828203000_reports_workspace_server_pagination.sql` because the project has documented historical migration-ledger drift.

## Quality controls

- Added `src/reportsWorkspaceGuard.test.ts` to protect:
  - The exact eight-report library.
  - Nested report routing and permission enforcement.
  - Server pagination limits and database authorization.
  - The read-only report-detail boundary.
- Updated the existing timekeeping operations expansion guard for the centralized report definitions and bounded report API.
- Full validation passed:
  - TypeScript type checking
  - Linting with warnings denied
  - 97 test files / 490 tests
  - Production build
  - Git whitespace validation
- The production database function and authenticated execution grant were verified after migration.
- The primary and fallback Worker health and readiness endpoints passed after deployment.
- The deployed `/reports` route returned the production application and correctly enforced the branded authentication boundary without browser console errors.

## Rollback

The application implementation can be reverted from the release commit recorded after deployment. The database addition is backward compatible: it adds a helper and report RPC without deleting or modifying the prior aggregate report contract. If database rollback is required, remove `public.get_timekeeping_operations_report_page(...)` and `private.report_legal_employee_name(...)` only after reverting all application callers.
