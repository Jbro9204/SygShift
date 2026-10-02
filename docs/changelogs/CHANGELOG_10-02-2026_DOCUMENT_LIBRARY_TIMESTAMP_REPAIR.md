# Document Library Timestamp Repair

Date: 10/02/2026
Status: Released to production

## Outcome

Repaired the Document Center failure that displayed **Document library
unavailable** followed by raw datetime-validation errors for every item on the
page. The library now accepts the timezone-qualified timestamps returned by
PostgreSQL, preserves their full precision for source-version checks, and
keeps optional lifecycle actions fail-closed if one item's timestamp is
missing or malformed.

## Root cause

- The source-library database function correctly returned `timestamptz`
  values such as `2026-10-01T22:43:50.714662+00:00`.
- The browser schema used the default Zod datetime mode, which accepts only a
  trailing `Z`. The valid PostgreSQL `+00:00` representation therefore caused
  all ten items in the requested page to fail parsing.
- Approval and retirement also passed the source-version timestamp through a
  JavaScript `Date`, which truncated PostgreSQL microseconds before the exact
  database concurrency comparison. Once the library loaded, that would have
  falsely reported an unchanged source as stale.

## Repair

- Accept valid RFC 3339 timestamps with either `Z` or an explicit UTC offset.
- Normalize zero-offset API timestamps to `Z` without converting through a
  JavaScript `Date`, preserving all fractional-second digits.
- Preserve the exact validated timestamp string through approval and
  retirement so optimistic concurrency remains exact at PostgreSQL precision.
- Omit only an invalid optional item timestamp instead of rejecting the entire
  library. Approval and retirement stay unavailable for that item until a
  valid version token is returned.
- Replace raw schema diagnostics with a concise operational error if another
  required library response field is ever incomplete.
- Normalize the Worker response as well as the browser parser so an older
  cached browser bundle can recover during the rolling deployment.

## Security and preservation

- Authentication, recent MFA, Document Studio permission, service-only RPCs,
  source checksum validation, row locking, and exact timestamp comparison are
  unchanged.
- The repair does not weaken stale-review protection or round timestamps to
  milliseconds.
- No document, source PDF, employee file, signature, training assignment,
  permission, schedule, timekeeping, payroll, or audit record was changed.
- No database migration or production-data repair is required.

## Verification

- Read-only production diagnosis confirmed the database emits six-digit UTC
  timestamps with `+00:00` offsets.
- Focused timestamp, Worker payload, and source-metadata regression coverage:
  **20/20 passed**.
- Full `pnpm check`: TypeScript, zero-warning lint, **354 passed / 1 skipped
  test file** and **1,919 passed / 1 skipped test**, production Worker/client
  builds, and static-asset validation passed.
- Document Center and mandatory actual-component Time Clock browser matrix:
  **62/62 passed** across desktop and mobile.
- `git diff --check`: passed.
- Authenticated production verification confirmed the Document Center opens,
  saved records load, and the Forms & Source Catalog renders all **231 source
  items** without the prior raw datetime-validation failure.

## Release status

- Application commit: `23e6137`.
- Cloudflare Worker version: `5681178e-e895-4dfd-949a-b0c0e92f6023`.
- Both `app.sygilant.us` and `sygshift.sygilant.workers.dev` returned HTTP 200
  for health and readiness, with readiness reporting ready.
- Both production origins served `/assets/index-CxWo8_OL.js` with exact
  SHA-256 parity:
  `719649218D62D9865C22FEC54BDDFCC48C54633FBEC72C293C9D9681F7A3E3AA`.
- Anonymous Document Library access remained rejected with HTTP 401 on both
  origins.
- Pre-release rollback tag:
  `rollback/pre-document-library-timestamp-repair-20261002` at `508d543`.

## Rollback

This is an application-only compatibility repair. If containment is required,
restore the preceding application revision and redeploy with all current
bindings preserved. The existing source-metadata migration remains additive
and must not be edited or reversed.
