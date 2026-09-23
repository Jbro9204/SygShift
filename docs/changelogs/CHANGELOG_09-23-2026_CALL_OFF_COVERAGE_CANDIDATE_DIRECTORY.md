# Call-Off Coverage Candidate Directory

Date: 09/23/2026
Status: Released to production

## Outcome

Dispatchers using **Coverage already found** can now find and select every
qualified employee who may cover the call-off. Flex employees remain the first
recommendation, but they no longer displace regular employees from the list.

## Root cause

The protected coverage-candidate service was already returning all active,
qualified employees. The client sorted Flex employees first and then displayed
only the first 12 results. When at least 12 Flex employees were returned, the
regular available employees existed in the response but could not be seen or
selected.

## Coverage workflow

- Removed the arbitrary 12-candidate display limit.
- Added a single searchable directory that matches employee name, employee
  number, employment type, work classification, and Flex status.
- Organized results into four clear sections:
  - **Recommended Flex** for available Flex employees without projected
    overtime.
  - **Available employees** for other qualified employees without a schedule
    conflict or projected overtime.
  - **Overtime approval required** for otherwise qualified employees whose
    assignment would create scheduled overtime.
  - **Unavailable for this shift** for blocked employees, hidden by default and
    available through a review toggle or a matching search.
- Added visible group counts, the total eligible count, and the number requiring
  overtime approval.
- Each result displays the employee number, employment classification,
  overlapping-shift status, projected overtime, and any blocking reason.
- Selecting an overtime candidate now requires an explicit
  **Overtime is approved for this replacement** acknowledgment before the
  dispatcher can advance.
- The result area has a contained scroll region and responsive stacking so the
  workflow remains usable on phones, small laptops, and enlarged browser zoom.

## Preserved controls

- Flex is still recommended first; the change does not remove the Flex-first
  operating preference.
- The server remains authoritative for active employment, role qualification,
  armed credentials, shift overlap, overtime, and final assignment validation.
- The original call-off assignment and its permanent history are not changed by
  opening or searching the selector.
- No candidate is assigned until the dispatcher completes and confirms the
  existing final workflow step.
- No database migration, policy change, permission expansion, employee edit,
  schedule rewrite, or production data backfill was required.

## Verification

- Focused unit/component coverage: 4 files / 16 tests passed.
- Full `pnpm check`: 304 test files / 1,612 tests, strict TypeScript,
  zero-warning application lint, Worker build, client production build, and
  static-asset contract.
- Coverage directory browser matrix: 4/4 desktop and mobile checks passed with
  15 Flex candidates followed by a regular available employee, proving the
  former cutoff cannot hide the regular employee.
- Mandatory actual-component Time Clock workflow: 42/42 desktop and mobile
  checks passed.
- Rendered desktop and mobile layouts were visually reviewed for contained
  scrolling, readable search and group summaries, complete candidate access,
  and horizontal-overflow prevention.
- A read-only production walkthrough opened an existing call-off and displayed:
  - 2 recommended Flex employees;
  - 11 other available employees;
  - 5 overtime candidates requiring approval; and
  - 13 unavailable employees behind the optional review toggle.
- The production dialog was closed without selecting an employee or changing a
  schedule.

## Release references

- Database migration: none
- Source commit: `f9d15201fdbd09d602434ba93c744909bb820ed8`
- Cloudflare Worker version: `1cb6a07b-ef71-4945-b81a-200c7beeb012`
- Rollback tag:
  `rollback/pre-calloff-coverage-candidate-directory-20260923`
- Production verification: the custom domain and Worker origin returned healthy
  and ready, `/requests` returned HTTP 200, and both origins served the exact
  locally verified application and Requests bundles.
- Verified application asset: `/assets/index-BIp1VwBf.js`
  (`21A03CB3260D5DC8329D530778376B8DA6035FA1D04F0B7465D59B61D0B75CF4`)
- Verified Requests asset: `/assets/RequestsPage-Cy13eH7Y.js`
  (`F67CA174645D3D1558A12B9976C5B0982E16C00AA8D4B866D4D55E471F48C4D2`)
