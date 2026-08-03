# SygShift Change Log — 08/03/2026

## Licensing Center active-workforce correction

- Removed separated employees from the Licensing Center employee list.
- Removed credential rows belonging to separated employees from the credential worklist.
- Recalculated Licensing Center status totals after the workforce filter is applied.
- Removed the obsolete Separated option from Licensing Center filters.
- Changed licensing save flows to refresh from the authoritative filtered dataset before displaying updated information.
- Preserved separated employee licensing history in the database for authorized historical and audit workflows.

## Verification

- Added an automated guard that prevents separated employees or their credentials from returning to the Licensing Center.
- Completed the full automated test, type-check, lint, and production-build suite.
