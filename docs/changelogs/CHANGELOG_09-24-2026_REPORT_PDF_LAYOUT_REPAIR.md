# Report PDF Layout and Rendering Repair

Date: 09/24/2026
Status: Released to production

## Outcome

The User Account & Sign-In Activity PDF now exports with straight, consistently
aligned columns, row separators below the complete employee row, measured text
fitting, repeated page headings, and page-numbered footers. The shared repair
also standardizes the Short-Notice Call-Out and Patrol Activity report PDFs so
continuation pages use the same complete report chrome and alignment rules.

## Root causes

- The account-activity row divider was positioned through the employee-number
  baseline instead of below the row.
- Column text was shortened by character count rather than measured rendered
  width, allowing visually uneven clipping and alignment.
- Each text operation created another page-font resource name. Large reports
  could accumulate more than one hundred font aliases per page, increasing the
  chance of inconsistent rendering between PDF engines.
- The three report exporters independently implemented page banners, table
  headers, pagination, and footers, allowing their layouts to drift.

## Repair

- Added one shared report-PDF layout layer for banners, text fitting, stable
  per-page font resources, colors, margins, and footers.
- Rebuilt the account report around fixed column geometry and 28-point rows.
  Employee names and numbers now occupy separate baselines, alternating row
  fills cover the complete row, and separators sit at the row boundary.
- Repeated the full report banner, continuation summary, table header, and page
  numbering on every account-report page.
- Applied the shared banner, footer, font, and compatibility path to the
  Short-Notice Call-Out and Patrol Activity report PDFs.
- Saved report PDFs without object streams for broad viewer compatibility.
- Kept Excel exports, report data, permissions, audit behavior, report filters,
  employee records, schedules, timekeeping, payroll, and document PDFs
  unchanged.

## Verification

- The supplied six-page User Account & Sign-In Activity PDF was rendered and
  reviewed to reproduce the divider and alignment defects.
- A replacement six-page synthetic account report was rendered and inspected
  page by page in both Poppler and Chromium/PDFium-compatible engines.
- Multi-page synthetic Short-Notice Call-Out and Patrol Activity PDFs were also
  rendered and visually checked for repeated headers, aligned content, clean
  separators, and complete footers.
- Focused PDF regression coverage passed: 2 files / 7 tests. The tests verify
  page headings, table headings, page numbers, and exactly two stable font
  resources on every generated page.
- Full `pnpm check` passed: 306 test files / 1,617 tests, strict TypeScript,
  zero-warning application/Worker lint, production builds, and static-asset
  validation.
- Mandatory actual-component Time Clock preservation matrix passed: 42/42
  desktop and mobile checks.
- Both production origins returned healthy and ready, and `/reports` returned
  HTTP 200.
- The custom domain and Worker origin serve byte-identical verified application,
  stylesheet, and Reports assets.

## Release references

- Source commit: `1df96ae9c9021c7271ef5fc55d909173793765e9`
- Cloudflare Worker version: `e29f8937-d62f-40a9-9c54-b78aba44ed5d`
- Database migration: none
- Rollback tag: `rollback/pre-report-pdf-layout-repair-20260924`
- Verified application asset: `/assets/index-CoxYKtIw.js`
  (`2CF7D5851938F5600725E77E62F608E5106D4738B09B3D7D53802504AA07A02A`)
- Verified stylesheet: `/assets/index-CkhE3gY0.css`
  (`90953649C6D8EBC682B65D7654CC0C9551960F7971E45E78C7D004E2476A6090`)
- Verified Reports asset: `/assets/ReportsPage-FiN7_64w.js`
  (`993CF32A845BE60A54BBD17EDE689791E623138BC0B3190E1F1056FC334A46C7`)

## Operator note

PDFs already downloaded remain unchanged. Re-export the report to receive the
corrected layout.
