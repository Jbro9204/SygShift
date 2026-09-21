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

## Production references

- Database migration:
  `20260921102000_coverage_candidate_flex_boolean_contract.sql`
- Primary URL: `https://app.sygilant.us`
- Fallback URL: `https://sygshift.sygilant.workers.dev`
