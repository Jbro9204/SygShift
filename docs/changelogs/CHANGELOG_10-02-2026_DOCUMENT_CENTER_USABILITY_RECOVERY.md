# Document Center Usability Recovery

Date: 10/02/2026  
Status: Released to production

## Outcome

Repaired the existing Document Center so Guardianship's current PDF library is
usable without approving almost 600 source files one at a time. This is not a
new document system and it does not replace the existing library. Form-like
sources can now open directly in a guided question flow, while guides,
policies, handbooks, and other reference material remain preview/download
resources.

The release also restores protected PDF preview, separates reusable source
PDFs from permanent employee/company records, and makes the form-completion
experience usable on phones, small laptops, and high browser zoom.

## Root causes

- The earlier lifecycle model treated every draft source as unusable until an
  authorized manager approved it individually. That was operationally
  impractical for 537 linked source PDFs and made routine HR work depend on a
  catalog-governance action.
- Three source-lifecycle routines still called the deleted
  `private.hr_document_latest_scan_state` helper after document availability
  moved to the newer protected-storage boundary.
- The base document-workspace query counted and paged reusable source PDFs as
  if they were completed employee/company records.
- Several protected preview surfaces passed a temporary `blob:` URL back to
  PDF.js. The application's content-security policy correctly blocks that
  second fetch, which made an authorized PDF look unavailable.
- The form workbench exposed low-level PDF controls before the actual
  questions, allowed template-backed answers to enter a generic movable
  annotation path, and did not bring the reordered PDF into view when a phone
  user selected **Show on form**.

## Guided form and immediate-use recovery

- Form-like draft sources now show **Available source** and can start with
  **Start guided form** immediately.
- Source review remains available as the optional governance action
  **Mark reviewed**; it is no longer a prerequisite for ordinary use.
- Retired sources remain blocked, and guides/reference material remain
  preview/download only instead of being misrepresented as fillable forms.
- Training material keeps its existing review-before-assignment safeguard.
- The workbench now starts with **Answer the form questions**, groups fields in
  plain language, and keeps manual text/signature placement behind
  **Advanced PDF tools**.
- Ambiguous fields display **Template repair needed**. SygShift does not guess
  at an unclear destination or allow a partially mapped form to be finalized.
- Template-backed answers and signatures stay locked to their mapped boxes;
  they cannot be dragged out of place through generic annotation controls.
- **Show on form** renders one selected field and scrolls the document section
  into view, including in the one-column phone/high-zoom layout.

## Secure preview and protected-file access

- Protected PDFs are now passed to the shared secure viewer as in-memory byte
  arrays rather than a second `blob:` URL fetch.
- The repair covers the HR source library, client files, Licensing Center,
  My Documents signature review, and SygSphere document preview.
- Existing authentication, recent-MFA gates, document permissions, protected
  storage, and audit behavior remain in force.

## Source library and permanent-record separation

- Reusable source PDFs remain in **Forms & source catalog** and
  **Guides, policies & training**.
- The authoritative workspace query excludes linked source documents before
  both its total count and its paginated result query.
- **Saved document records** now represents completed employee/company
  records rather than duplicating the source catalog.
- The production data was preserved: 542 active protected documents and 537
  linked source PDFs remain present, with five actual active saved records.

## Database repair and production preservation

- Applied targeted migration
  `20261002190309_repair_document_library_usability` in one atomic transaction
  with its migration-history record. A broad migration push was intentionally
  not used because local and remote historical ledgers contain older known
  divergence.
- Repointed the three affected source-lifecycle routines to
  `private.hr_document_latest_availability_state`.
- Added both source exclusions to
  `public.service_get_hr_document_workspace` before count and pagination.
- Postflight confirmed zero stale scan-helper references, two workspace source
  exclusions, unchanged owners/ACLs/security-definer configuration, and the
  same 542/537/5 document counts.
- No document row, source PDF, completed file, employee record, signature,
  permission, schedule, timekeeping, payroll, or audit record was deleted or
  rewritten.

## Responsive and accessibility behavior

- Guided questions become the first work area on narrow screens, while the PDF
  retains a usable review height below them.
- Rounded inputs, touch targets, action wrapping, and document navigation were
  verified at phone, small-laptop, and effective 200% zoom dimensions in light
  and dark themes.
- The selected mapped control remains keyboard-focusable without exposing a
  second overlapping or draggable accessibility target.

## Verification

- Focused Document Center regression coverage: **68/68 passed** across nine
  test files, including **22/22** workbench component tests.
- Full `pnpm check`: TypeScript, zero-warning lint, **355 passed / 1 skipped
  test file** and **1,923 passed / 1 skipped test**, production Worker/client
  builds, and static-asset validation passed.
- Document Center and mandatory actual-component Time Clock browser matrix:
  **80 passed / 2 intentional responsive-loop skips** across desktop and
  mobile projects.
- `git diff --check`: passed.
- The migration succeeded in a rollback-only production rehearsal before
  release, then passed its production history, function-definition,
  privilege, query-placement, and data-count postflight.
- A signed-in production browser reached the Document Center after deployment.
  Its 30-minute HR verification had expired, so final owner-level form opening
  and preview were not automated or falsely claimed; the security-key/current
  authenticator checkpoint remains intact.

## Release status

- Application commit: `1e93257`.
- Database migration: `20261002190309` recorded locally and remotely.
- Cloudflare Worker version:
  `ba1cb980-4416-4362-9d78-84d718fd7d8e`.
- Both `app.sygilant.us` and `sygshift.sygilant.workers.dev` returned HTTP 200
  for health and readiness, with readiness reporting ready.
- Both origins served the entry JavaScript/CSS and the Document Center,
  workbench, and secure-viewer chunks with exact local SHA-256 parity.
- Pre-release rollback tag:
  `rollback/pre-document-center-usability-recovery-20261002` at `d4cfb91`.

## Rollback

If application containment is required, redeploy the pre-release tag with the
current production bindings preserved. The database migration repairs live
function references and source-record separation without changing business
rows; keep it forward-applied unless a reviewed replacement migration is
prepared.
