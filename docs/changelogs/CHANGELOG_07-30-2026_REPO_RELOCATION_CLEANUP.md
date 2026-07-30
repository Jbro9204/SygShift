# SygShift Changelog — 07-30-2026 Repo Relocation Cleanup

## Summary

Moved SygShift work to a clean standalone project path so it no longer needs to live inside the old DayZ workspace.

## Completed

- Backed up the current SygShift application state to Git before relocation.
- Added Git ignore rules for local clutter that should not be tracked:
  - `.pnpm-store/`
  - `tmp/`
  - `.reference/`
  - `assets/`
- Created a clean working clone at `C:\Users\Jordan\Projects\SygShift`.
- Left the old `C:\Users\Jordan\Documents\DayZ Shirt\sygshift` folder in place as a temporary safety backup because Windows reported the folder was in use and blocked a direct move.
- Confirmed the clean repo does not carry the DayZ reference folder, temporary screenshots/CSV files, or local package-store clutter.

## Validation

- `pnpm install --frozen-lockfile` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed.
- `pnpm test` passed: 29 test files, 115 tests.
- `pnpm build` passed.

## Notes

- The new working location going forward should be `C:\Users\Jordan\Projects\SygShift`.
- The old DayZ-folder copy should be treated as a backup only until it can be safely archived or deleted after any app/process locking it is closed.
