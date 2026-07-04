# Bible Import Run - 2026-07-04

## Source

- Source file: `dispatch schedule-LAPTOP-DUUH2O4N.xlsx`
- Source SHA-256: `5746f5e6c97a88e267cbb0feb5c6def0ad2a444ecc810d2adcbd997f1c356dc0`
- Private storage path: `source-imports/20260704/dispatch-schedule-LAPTOP-DUUH2O4N.xlsx`
- Import run ID: `68d8dc39-d46b-4306-b82d-e10f3dd0c554`
- Import status: `review`

## Extraction verification

Two independent value-evidence extraction passes matched exactly.

- Worksheets: 155
- Used-range source cells: 95,332
- Populated cells: 27,685
- Formula cells: 218
- Value-evidence digest: `8d1fdeb5df0dec7c73272a08604a0a7bf9006a2734ec8b52bdd9ac5e5e6b22eb`

Two independent OOXML metadata extraction passes matched exactly.

- OOXML cell metadata records: 85,811
- Bold cell records: 40,962
- Annotation records: 65
- OOXML evidence digest: `aa0b6df497050d68f19d1b208f2c2ea8a83a0d1f43b6aa731b87c2c6fec30f74`

## Normalization summary

- Weekly schedule tabs: 140
- Intentionally blank tabs: 11
- Reference tabs: 4
- Directory candidates: 56
- Armed directory candidates: 16
- Site/post candidates: 82
- Shift candidates: 9,130
- Total review candidates: 9,408
- Blocking issues: 132
- Warnings: 60
- Promotion eligible: No

## Live staging verification

The live Supabase import-review staging tables match the dry-run payload.

- Protected source cells: 110,274
- Source sheets: 155
- OOXML cell metadata records: 85,811
- Source annotations: 65
- Source relationships: 147
- Review candidates: 9,408
- Issues: 192
- Reconciliation digest: `8fc044c1cb969d2aa2f49ea43b5122f7e9d073dbb0314f65b8531e979c00d137`

## Guardrails

- No canonical schedules, shifts, sites, or employee directory records were promoted by this import.
- The import is locked in review status because unresolved blocking issues remain.
- Admin review functions require an active Admin session with MFA before source-data review is available in the application.
- Sensitive workbook evidence remains under ignored private data paths and is not committed to Git.
