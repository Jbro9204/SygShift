# Searchable Guardianship HR Document Library

Date: 09/02/2026

## Outcome

SygShift now has one searchable index for the complete Guardianship HR Template Library v1.0. Every signed-in employee can open **Document Library** from Workforce, search by what they need, and see only the forms appropriate to their role. HR sees the same authoritative catalog inside Document Studio rather than a duplicate list.

## Library experience

- Cataloged all 56 controlled GS-HR forms with their form code, official title, category, record class, purpose, audience, handling sensitivity, and controlled source filename.
- Added plain-language search aliases for common needs including PTO, vacation, emergency contacts, payroll corrections, missing time, complaints, injuries, resignations, call-offs, overtime, licenses, and government forms.
- Added category and role-aware audience filters, expandable purpose and filing details, clear result counts, and compact 5/10/20 pagination with 10 rows by default.
- Added the employee library to **My Documents** and the HR library to **Document Studio**, both backed by the same endpoint and catalog.
- Added a visible **Document Library** entry under Workforce for every authenticated employee.
- Added responsive, high-contrast light and dark presentation without a long unbounded list.

## Security and document handling

- Searchable metadata is released independently from protected document binaries.
- Employee, supervisor, and HR audience filtering is enforced in the service-only database routine using the actor's live effective permissions.
- Private catalog tables have row-level security enabled and are inaccessible to anonymous and authenticated browser database roles.
- A form remains **Indexed** until it is deliberately linked to a canonical HR document whose current immutable version passed malware scanning and whose protected document release gate is enabled.
- This release does not enable HR upload, preview, download, signature execution, OCR, editing, redaction, or any existing protected document gate.
- Completed employee documents and sensitive HR records remain outside the blank-form catalog.

## Database and preservation

- Applied forward migration `20260902232050_searchable_hr_template_library.sql` directly to the linked production database because the repository retains documented historical migration-ledger drift.
- Reconciled only the exact new migration marker; no historical migration was replayed or repaired.
- The migration's production rollback rehearsal compiled successfully and removed all rehearsal schema/data changes.
- Post-release verification confirmed 56 indexed forms, nine categories, no blank search vectors, row-level security enabled, no browser execution of the service routine, and correct HR and ordinary-employee audience boundaries.
- Preserved 78 employees, two role assignments, zero individual overrides, and the existing zero HR-document/version baseline.

## Verification

- Full repository gate passed: TypeScript, zero-warning lint, 154 test files / 746 tests, and Worker/client production builds.
- All 100 desktop/mobile Chromium Playwright checks passed.
- The new library passed desktop and mobile containment and automated accessibility checks in light and dark modes.
- Production search verification found the expected PTO form `GS-HR-400`; an ordinary employee search returned only `all_employees` results and did not receive supervisor or HR scope.

## Release status

- Database migration: applied and recorded.
- Git implementation commit: `7834464` pushed to `origin/main`.
- Cloudflare Worker version: `915f4548-ab9e-40ab-94af-b755d466c542` deployed.
- Primary and fallback app, login, health, and readiness endpoints returned HTTP 200; the anonymous library endpoint returned the expected HTTP 401, and the live bundles contain the library navigation and search experience.

## Remaining controlled step

The supplied DOCX files are indexed but are not yet uploaded or downloadable. Canonical file ingestion remains dependent on the approved malware scanner, recovery drill, permission assignment, limited canary, and deliberate protected-pipeline release. This limitation is visible in the interface so an indexed form cannot be mistaken for an available file.

## Rollback

The release is additive. The application can be rolled back without deleting the catalog. Any database correction must use a new forward migration; do not edit the applied migration or remove audit history.
