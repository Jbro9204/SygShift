# SygShift Changelog — 07/30/2026

## Schedule Open-State Normalization

### What was fixed

- Fixed the “phantom open shift” issue where fully assigned schedule blocks could still display as open.
- Corrected the live 07/26/2026–08/01/2026 draft week for the `3 unarmed guards` site:
  - Friday, 07/31/2026, Fernando Gomez: 1 assigned / 1 needed / 0 open.
  - Friday, 07/31/2026, William Lane: 1 assigned / 1 needed / 0 open.
  - Saturday, 08/01/2026, Fernando Gomez: 1 assigned / 1 needed / 0 open.
- Updated schedule display logic so cards show “Covered” based on actual assigned count versus required headcount, not a stale stored flag.
- Added database normalization so draft shifts recalculate open/covered status whenever assignments are added, canceled, edited, or removed.
- Updated the weekly schedule payload so the UI receives open status calculated from live coverage counts.

### Why it mattered

Michael was seeing Friday as still needing coverage even though the two visible Friday shifts were already assigned. The root cause was stale `is_open` state on the shift records, not missing employees or missing shift cards.

### Validation completed

- Applied the production Supabase migration successfully.
- Queried the affected week/site directly in production and confirmed all three relevant shifts now show `open_slots = 0`.
- Ran full project checks:
  - TypeScript passed.
  - Lint passed.
  - 112 tests passed.
  - Production build passed.
- Deployed the updated frontend to Cloudflare.

### Production URLs

- https://app.sygilant.us
- https://sygshift.sygilant.workers.dev
