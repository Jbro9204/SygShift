# Smart Document Center Release — September 12, 2026

## Outcome

The Document Center now opens as a task-first HR workspace instead of a mixed technical library. Users are guided toward the job they need to complete, working forms are separated from training material, standard fillable PDF fields are usable, and employee details can be inserted without manually placing every value.

## What changed

- Added a simple **Start** page with four plain-language choices: use an outside PDF, start an HR task, add a document to an employee file, or find training and guides.
- Separated **Working HR forms**, **Training & guides**, **Signature requests**, and permission-controlled system management.
- Added HR task shortcuts for hiring, coaching, leave/medical, pay/job changes, incidents/safety, and separations.
- Normalized awkward uppercase/lowercase document titles for display without changing controlled source records.
- Kept technical source metadata under an optional **Document details** disclosure.
- Added standard AcroForm field support for short text, long text, checkboxes, dropdowns, and option lists.
- Added guided employee selection and prefill for names, employee numbers, roles, employment type, supervisor, site/location, company, and dates where matching fields exist.
- Made a newly selected employee replace stale employee-specific values left in a form.
- Preserved manual text, dates, checks, and generated typed signatures for flattened or non-fillable PDFs.
- Finalized native fields into a stable completed copy so preview, download, filing, and delivery use the same rendered content.
- Standardized rounded controls, even internal spacing, readable sans-serif typography, consistent font sizes, and touch-sized actions.
- Reworked the mobile navigation so every primary Document Center tab is visible without hidden horizontal scrolling.

## Data and security preservation

- No employee, schedule, timekeeping, payroll, document, signature, or access-control record was deleted or rewritten.
- Database change `20260912210000_guided_document_employee_prefill.sql` is additive and retains the prior workspace function for rollback.
- The new workspace function is executable only by `service_role`; public, anonymous, and authenticated-client execution remains revoked.
- The Worker falls back to the prior workspace contract only when the new function is genuinely unavailable, preventing a deployment-order outage.
- Production employee and private-profile counts remained unchanged after the migration (`80` employees and `53` private profiles).

## Verification

- Full repository check: **253 test files / 1,298 tests passed**, with typecheck, zero-warning lint, and production build passing.
- Document browser matrix: **38 passed / 2 expected skips** across desktop and mobile in light and dark themes.
- Updated Start page responsive/accessibility suite: **4 of 4 passed**.
- Mandatory timekeeping preservation suite: **42 of 42 passed** across desktop and mobile.
- Production health and readiness: HTTP `200` on both `app.sygilant.us` and the Worker origin.
- Protected Document Center workspace: unauthenticated request correctly returns HTTP `401`.
- Production `/hr/documents` returns HTTP `200` and references the new release assets.

## Release references

- Source commit: `986a2cafc78a994c3039665cc4b851f9b6964e14`
- Cloudflare Worker version: `0b033281-708e-4916-8e38-f1e70d75c3d0`
- Rollback tag: `rollback/pre-smart-document-center-20260912`

## Remaining acceptance item

The final owner-session roundtrip—complete a selected real form, preview, download, file, reopen, and optionally send—remains intentionally pending because the clean verification browser had no authenticated owner session. No disposable employee document or signature request was created merely to manufacture a production test result. The automated equivalents and all non-mutating production checks passed.
