# Guard Licensing Status Report

Date: 09/01/2026
Status: Production database control applied; application release pending

## Outcome

SygShift Reports now includes a dedicated **Guard Licensing Status** workspace. Authorized users can immediately see who is currently licensed, expiring soon, expired, not licensed, pending review, or restricted, then download a complete Excel workbook for operational follow-up.

## Report workspace

- Reuses the Licensing Center as the single authoritative source; the report creates no duplicate license records or competing editor.
- Defaults to active guards and legal employee names.
- Provides status totals, search, employee scope, employment status, license status, credential type, and 10/25/50-row controls.
- Keeps the worklist compact with ten rows by default and explicit pagination.
- Opens a read-only employee detail modal and routes record changes back to Licensing Center.
- Appears in the existing Reports library only for users who can view protected licensing information.

## Excel workbook

- Downloads as `sygshift-licensing-status-YYYY-MM-DD.xlsx`.
- **Guard Status** provides one summary row per employee with employment, license, expiration, work-eligibility, credential-count, document-count, and renewal information.
- **Credential Detail** provides one row per credential or requirement with issuing authority, dates, days remaining, renewal status, supporting-document count, and work-eligibility impact.
- Both worksheets include report scope, generated time, filters, frozen headers, usable column widths, autofilters, landscape print setup, and restrained status colors.
- Legal names are used. Email addresses, mobile numbers, employee/internal notes, document contents, SSN, PHI, payroll, compensation, banking, and tax information are excluded.

## Access and audit controls

- Viewing continues to require the existing protected `licensing.view` permission and verified licensing MFA boundary.
- Downloading also requires the exact `reports.export` permission; hiding the browser button is not the security boundary.
- Every authorized download receives a server-generated export ID and writes a private append-only `LICENSING_STATUS_REPORT_EXPORT` audit event containing only the selected filters.
- The Recruiting & Licensing system role received the existing Report Export permission. Admin access continues through the established Admin boundary.
- Forward migration `20260901230000_licensing_status_report_export.sql` fingerprints employee records, license records, role memberships, and individual overrides and aborts if any existing protected record changes.
- No employee, license, document, schedule, punch, time card, payroll record, role assignment, individual override, or historical audit record was changed.

## Verification

- Production migration `20260901230000_licensing_status_report_export.sql` applied successfully through an isolated targeted query and was reconciled in migration history.
- Production verification confirmed the export authorization function, MFA guard, export-permission guard, and Recruiting & Licensing export permission.
- Type checking passed.
- Lint passed with zero warnings.
- 134 test files and 659 tests passed.
- Worker and client production builds passed.
- All 34 desktop/mobile Playwright checks passed, including the dedicated report containment and control-size test.
- A generated workbook was imported, inspected, and rendered from both worksheets; status counts, status colors, frozen/filterable tables, legal-name alignment, and sensitive-field exclusions were verified.

## Release

- Cloudflare application deployment: pending.
- Production app, login, health, readiness, and live bundle checks: pending.
