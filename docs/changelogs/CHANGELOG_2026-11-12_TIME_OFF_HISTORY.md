# Complete Time Off history and verified action context — November 12, 2026

Status: local verification and database activation complete; exact-candidate
application release pending.

## Cause and repair

The previous manager history read stopped after 100 non-pending requests.
Search and totals were then computed from that partial browser collection.
The source could therefore hide an older record or an approved future request.
This is a verified source limitation, not a claim that every manager was already
missing the same live record.

Time Off now uses a separate authenticated server-side reader. Search, status,
queue/history and employee upcoming/past selection apply before keyset paging.
The reader returns exact counts for the authorized search cohort, a bounded page
and a stable creation cutoff/evaluation time. Current statuses are read on each
request; this is not a frozen multi-request database snapshot. Exact reads preserve deep links and
open action dialogs independently of the page containing the request.

The other request tabs retain their existing readers and workflows. The new
cache keys bind results to the employee and access generation; sign-out clears
them. Failed or late reads cannot substitute another account's results, capped
legacy data or false zero counts.

Original approvals, cancellation receipts and early-return records remain
authoritative. Historical timezone snapshots are preserved. Deterministically
invalid historical action context leaves the record visible with an explicit HR
review message and no unverified Cancel/End action. Permission, database and
timeout failures remain errors rather than being represented as eligibility.

## Boundaries

- No request is canceled or ended by this release.
- No schedule, punch, balance, payroll, account, password, permission or email
  is changed by the new read-only migration.
- Existing cancellation/early-return mutations and their current MFA,
  employment, HR-linked and payroll-lock requirements are unchanged.
- The original v2/v3 request-center readers and canonical authorization/time
  helper definitions are preserved.

Forward migration: `20261112210145_time_off_history_keyset_reader.sql`.

The separately owned Sygilant update pairs Security Center state refreshes and
shows the recorded early-return interval beside original approved leave in
Admin employee view. It neither initiates recovery nor reinstates an account.

## Verification and remaining checks

- 47 native PostgreSQL checks passed using the retained canonical function
  definitions. Coverage includes authenticated/denied reads, full timestamp
  precision, identical-timestamp paging, search beyond row 100, exact lookup,
  timezone preservation, malformed-row isolation and complete rollback.
- A synthetic 100,000-row read measured about 137 ms locally. This is not a
  production latency guarantee.
- 134 focused data, component, permission and session tests passed. Thirteen
  actual browser tests cover historical records, action dialogs and unavailable
  context at small-phone dimensions; 1440/1280-pixel desktop checks also passed.
- Full application checks, mandatory desktop/mobile clock tests, exact main
  quality workflow, migration postflight and live release checks remain gates.
- The next ownership baseline must preserve all 460 existing entries and admit
  only this reader and Sygilant's reviewed early-return projection. It must not
  accept unrelated ledger/source drift or replay any historical migration.

## Local release checkpoint

- `pnpm check` passed: 411 test files and 2,619 application tests passed, with
  one intentionally skipped file/test. The new 47-check native history suite,
  seven ownership-baseline tests and existing release/native checks also passed.
- All 42 mandatory desktop/mobile clock tests passed.
- The exact migration activation batch passed a production rollback rehearsal;
  a subsequent read confirmed the new reader and both new migration versions
  absent, the original employee-preview hash intact and ledger count still 460.
- Reviewed normalized source SHA-256:
  `fba287d070889ef8c539b8fed445b1425b80adbade792a24501bb935abfa59c2`.
  Its 12-statement ledger SHA-256 is
  `f12b7cbc93c9cd61de85e8bdeb956c1b33a697f69e081dc115b34206efb3515a`.
- The migration is applied. Read-only postflight passed; the new reader MD5 is
  `63f0032d516b9875190eb16aa23c0828`. Preserved reader/context fingerprints and
  the separate Sygilant audited wrapper/time helpers remain unchanged.
- The 462-entry ownership baseline preserves all 460 earlier entries and
  source checksums; file SHA-256 is
  `ec9abe908618b6c77c88d5d62efd81f17a2ee1c058bb70131eb0a8f5dc447027`.
- Advisors report the same 409 prior findings plus one intentional warning for
  the new authenticated SECURITY DEFINER read endpoint. The endpoint needs the
  private canonical context and explicitly verifies the active employee plus
  existing `requests.manage` authority for other employees. Anonymous/service
  direct execution is denied; its helper has no public execution grant. Native
  self/manager/denied cases and postflight metadata verify that boundary. This
  is reviewed exposure, not a claim of zero database advisories.
- Independent exact-candidate verification and deployed source/readback remain
  pending at this checkpoint.

## Rollback

The old readers remain available. A source rollback can restore the previous UI
without removing approvals, requests or receipts. Retain the additive reader and
migration ledger; do not rewrite migration history. Investigate any source or
live fingerprint mismatch rather than forcing the migration through it.
