# Client Directory completion — 09/03/2026

## Outcome

- Renamed the client workspace navigation and landing header to **Client Directory** while preserving each canonical **Client File**.
- Repaired the source-review dead end: an authorized manager can now create a Client File directly from a staged Michelle sales-sheet row, match the row to an existing file, or exclude a heading/non-client row.
- Added searchable existing-client matching and prefilled creation fields for company, status, contact channel, address, Mountain time, and an import note.
- Retained the immutable spreadsheet row and review decision as controlled provenance visible inside authorized Client Files.
- Made client-number allocation concurrency safe with a database sequence.
- Automatically advances the source batch from staged to in-review and then completed when its final row is resolved.

## Security and integrity

- Source provenance is returned only through an authenticated, permission-checked database function requiring `clients.import.manage`.
- Direct table access remains revoked; the original private import batch and payloads remain private.
- Creating or matching a Client File does not infer site, post, schedule, shift, patrol, document, or portal relationships.
- Every resolution remains audit logged with actor, action, client, source tab, source row, reason, and timestamp.

## Data release

- Michelle's 261 staged source rows were reconciled into canonical status categories without importing spreadsheet headings as clients.
- Exact repeated company names are linked to one Client File and their individual source rows remain separately retained.
- Potential semantic aliases are not silently merged; canonical cleanup remains an explicit management decision.

## Validation

- Focused Client Directory guard coverage verifies create, match, exclude, provenance, private access, navigation, and report integration.
- TypeScript, zero-warning lint, complete Vitest suite, and production build must pass before release.
- Database migration and data reconciliation are validated with rollback-first SQL and post-release count/integrity checks.
