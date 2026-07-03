# Data quality and reconciliation

## Source preservation

The workbook is read-only input. Each import records the source filename, SHA-256 digest, byte size, workbook sheet order, cell address, raw value, formula, display value, and relevant layout metadata. The application never rewrites the source workbook.

## Import stages

1. Register the source file and verify its digest.
2. Extract every worksheet and source cell with provenance.
3. Classify dated schedules and reference sheets without discarding unknown content.
4. Normalize employees, sites, posts, shifts, contacts, patrol, and dispatch records into staging tables.
5. Produce conflicts, duplicates, missing references, and ambiguous values as review issues.
6. Reconcile normalized records back to their exact source cells.
7. Promote an import only when required checks pass and every difference is explained.

## Required invariants

- A promoted record retains a link to its source file, sheet, and cell or documented derivation.
- Duplicate people are never merged by name alone.
- A shift cannot end before it starts.
- A published shift belongs to one published schedule version.
- An employee cannot be assigned to overlapping shifts.
- An armed post cannot be requested or assigned without a valid armed qualification.
- Operational timestamps are stored as `timestamptz`; local dates use the site time zone.
- Time events, audit events, and source evidence are append-only.
- Import promotion requires zero unresolved blocking issues.

## Reconciliation report

Every import produces counts by sheet and record type, source-to-normalized mappings, duplicate candidates, unparsed cells, formula warnings, and a final pass/fail result. A person must approve any documented exception before promotion.
