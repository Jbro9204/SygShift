# SygShift Change Log — 08/03/2026

## Scheduler employee-view navigation

- Replaced the scrollbar-dependent employee week layout after scheduler feedback showed that moving the scrollbar did not solve the workflow.
- Fit the full Sunday-through-Saturday employee schedule inside the desktop planning board at once.
- Reduced only structural spacing and allowed the existing shift content to wrap cleanly within each day; operational details remain available.
- Preserved the existing single-column phone layout for readable mobile use.
- Expanded resize tracking for the other schedule boards that still use synchronized scrolling.

## Quality checks

- Added a scheduler behavior guard test requiring a seven-column, non-scrolling employee week board.
- Type checking passed.
- Lint passed with no warnings.
- All 156 automated tests passed.
- Production build passed.
