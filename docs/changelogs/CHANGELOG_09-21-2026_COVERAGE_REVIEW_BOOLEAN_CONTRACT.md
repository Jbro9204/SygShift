# Coverage Review Boolean Contract Repair — September 21, 2026

## Outcome

The manager coverage review now opens when the candidate list includes ordinary
non-Flex guards whose optional work-classification field is blank. SygShift no
longer exposes an internal validation dump in the coverage dialog.

## Root cause

The protected coverage-candidate helper used a nullable SQL expression for
`isFlex`. When a non-Flex employee had no work classification, PostgreSQL
produced JSON `null` instead of `false`. The browser contract correctly
expected a boolean and rejected the entire workspace.

The shift date did not cause the validation failure. A past date may determine
which coverage actions remain operationally valid, but it does not change the
candidate-data contract.

## Repair

- The database helper now emits a non-null JSON boolean for every candidate.
- The browser contract safely normalizes an older null or omitted Flex flag
  from the employee's authoritative employment fields during rollout.
- Malformed protected payloads and RPC failures now produce concise recovery
  guidance instead of raw database or schema-validation details.
- Existing MFA, effective-permission, candidate-eligibility, overlap, armed
  credential, overtime, schedule, and audit controls remain unchanged.

## Verification

- Focused Requests data and workflow suite: **6/6 passed**.
- Full repository gate: **291 test files / 1,523 tests passed**, with TypeScript,
  zero-warning application lint, Worker build, and client production build.
- Absence coverage layout plus mandatory actual-component Time Clock matrix:
  **44/44 passed** across desktop and mobile.
- A fresh production build passed after browser verification.
- The linked Supabase dry run identified exactly one pending migration:
  `20260921102000_coverage_candidate_flex_boolean_contract.sql`.
- The migration contains transactional assertions for security-definer search
  path hardening and the non-null JSON boolean contract.
- The first production attempt safely rolled back because its search-path
  assertion did not use PostgreSQL's canonical empty-path spelling. The
  corrected assertion passed, the single migration applied, and version
  `20260921102000` is recorded in the production ledger.
- Both production origins returned health `ok`, readiness `true`, and HTTP
  200 for Requests.
- The deployed Requests bundle matches the verified local production build
  byte-for-byte on both origins (SHA-256
  `2832EB829ED69A6568DD9603B2CDA8E132258B69F7CE3E7179360BD7D27C7E02`).

## Production references

- Database migration:
  `20260921102000_coverage_candidate_flex_boolean_contract.sql`
- Source commits: `b494e5c`, `2f16dec`
- Cloudflare Worker version:
  `387d975e-026f-4abd-a91f-a2fe6b5c5d51`
- Rollback tag: `rollback/pre-coverage-review-contract-20260921`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`
